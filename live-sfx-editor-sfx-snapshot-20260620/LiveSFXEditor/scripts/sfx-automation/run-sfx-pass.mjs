import { readFileSync } from 'node:fs';
import { packNewEventsAroundFixedEvents, eventAudibleStart } from '../../shared/sfx-event-core.mjs';
import { loadCaptionProjectForSFXProject } from './candidates/build-caption-candidates.mjs';
import { buildZoomCandidates } from './candidates/build-zoom-candidates.mjs';
import { buildCaptionBeatCandidates } from './caption/build-caption-beat-candidates.mjs';
import { buildCaptionMoments } from './caption/build-caption-moments.mjs';
import { decodeTimeline } from './decoding/decode-timeline.mjs';
import { loadAutomationManifest } from './loaders/load-asset-pack.mjs';
import { materializeDecisions } from './rendering/materialize-events.mjs';
import { familyPoliciesForDecoder, loadCaptionBeatModel, scoreCaptionCandidatesModel } from './scoring/caption-model-scorer.mjs';
import { scoreZoomPopMoments } from './scoring/zoom-pop-model-scorer.mjs';

const defaultPolicyUrl = new URL('../../config/sfx-automation-v1/policy.json', import.meta.url);

export function loadPolicy(policyPath = defaultPolicyUrl) {
  if (!policyPath) {
    return {
      pop: {
        threshold: 0.78,
        cooldownSeconds: 4,
        maxPerMinute: 2.4,
        maxZoomAccentRatio: 0.45,
      },
    };
  }
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

export function filterExistingConflicts(decisions, project, options = {}) {
  const toleranceSeconds = Number(options.toleranceSeconds ?? 0.35);
  const occupied = (project.events || []).map(eventAudibleStart);
  return decisions.filter((decision) => {
    return !occupied.some((seconds) => Math.abs(seconds - decision.targetSec) <= toleranceSeconds);
  });
}

export function normalizeAutomationRegion(region, project) {
  const duration = Math.max(0, Number(project.duration) || 0);
  const rawStart = Number(region?.start);
  const rawEnd = Number(region?.end);
  const start = Number.isFinite(rawStart) ? Math.min(duration, Math.max(0, rawStart)) : 0;
  const end = Number.isFinite(rawEnd) ? Math.min(duration, Math.max(start, rawEnd)) : duration;
  return { start, end };
}

export function generateSFXPass(project, options = {}) {
  const scorer = String(options.scorer || 'local');
  if (scorer !== 'local') {
    throw new Error(`SFX automation only supports local scoring right now, got "${scorer}"`);
  }

  const seed = String(options.seed || 'sfx-v1');
  const policy = options.policy || loadPolicy(options.policyPath);
  const assetPack = options.assetPack || loadAutomationManifest({ packRoot: options.packRoot });
  const region = normalizeAutomationRegion(options.region, project);
  const allZoomCandidates = buildZoomCandidates(project);
  const zoomCandidates = allZoomCandidates.filter((candidate) => {
    const targetSec = Number(candidate.targetSec);
    return targetSec >= region.start - 0.001 && targetSec <= region.end + 0.001;
  });
  const captionResult = options.includeCaptions === false
    ? { captionPath: '', captionProject: null, candidates: [] }
    : buildCaptionBeatCandidateResult(project, {
      captionPath: options.captionPath,
      searchRoot: options.captionSearchRoot,
      captionProject: options.captionProject,
    });
  const captionModelBundle = options.includeCaptions === false ? null : loadCaptionBeatModel({
    modelPath: options.captionModelPath,
    policyPath: options.captionModelPolicyPath,
    modelData: options.captionModelData,
    policyData: options.captionPolicyData,
  });
  const captionCandidates = captionResult.candidates.filter((candidate) => {
    const targetSec = Number(candidate.targetSec);
    return targetSec >= region.start - 0.001 && targetSec <= region.end + 0.001;
  });
  const captionMoments = captionResult.captionProject
    ? buildCaptionMoments(project, captionResult.captionProject, captionResult.candidates)
    : [];
  const zoomPopScored = options.includeZoomPop === false
    ? []
    : scoreZoomPopMoments(captionMoments, project, {
      modelPath: options.zoomPopModelPath,
      modelData: options.zoomPopModelData,
    });
  const regionZoomPopScored = zoomPopScored.filter((item) => {
    const targetSec = Number(item.candidate.targetSec);
    return targetSec >= region.start - 0.001 && targetSec <= region.end + 0.001;
  });
  const scored = [
    ...regionZoomPopScored,
    ...scoreCaptionCandidatesModel(captionCandidates, { seed, modelBundle: captionModelBundle }),
  ];
  const captionFamilyPolicies = captionModelBundle ? familyPoliciesForDecoder(captionModelBundle.policy) : {};
  const decoded = decodeTimeline(scored, project, {
    popThreshold: policy.pop?.threshold,
    popCooldownSec: policy.pop?.cooldownSeconds,
    maxPopPerMinute: policy.pop?.maxPerMinute,
    maxZoomAccentRatio: policy.pop?.maxZoomAccentRatio,
    familyPolicies: {
      ...policy.families,
      ...captionFamilyPolicies,
      pop: policy.pop,
    },
    density: policy.density,
  });
  const decisions = filterExistingConflicts(decoded, project, { toleranceSeconds: policy.conflicts?.toleranceSeconds });
  const generatedEvents = materializeDecisions(decisions, project, assetPack, {
    seed,
    createdAt: options.createdAt,
  });
  const events = packNewEventsAroundFixedEvents(project.events || [], generatedEvents, project.fps);
  const nextProject = {
    ...project,
    name: options.renameProject && !String(project.name || '').includes('Automated')
      ? `${project.name} Automated`
      : project.name,
    events,
  };

  return {
    project: nextProject,
    stats: {
      scorerMode: 'local-model-v3-zoom-pop',
      captionModelVersion: captionModelBundle?.model?.modelVersion || '',
      captionEnabledFamilies: Object.entries(captionFamilyPolicies)
        .filter(([, config]) => config.enabled !== false)
        .map(([family]) => family),
      captionCandidateMode: 'beat-v2',
      region,
      zoomCandidates: allZoomCandidates.length,
      regionZoomCandidates: zoomCandidates.length,
      zoomPopCandidates: zoomPopScored.length,
      regionZoomPopCandidates: regionZoomPopScored.length,
      captionSource: captionResult.captionPath,
      captionResolver: captionResult.resolver || null,
      captionCandidates: captionResult.candidates.length,
      regionCaptionCandidates: captionCandidates.length,
      selectedDecisions: decisions.length,
      generatedEvents: generatedEvents.length,
      skippedDecisions: Math.max(0, decisions.length - generatedEvents.length),
      preservedEvents: (project.events || []).length,
      generatedEventIds: generatedEvents.map((event) => event.id),
      generatedByFamily: generatedEvents.reduce((counts, event) => {
        const key = event.categoryId;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      packReleaseId: assetPack.manifest.releaseId,
    },
  };
}

function buildCaptionBeatCandidateResult(project, options = {}) {
  const loaded = options.captionProject
    ? {
      captionPath: options.captionPath || options.captionProject.descriptorPath || '',
      captionProject: options.captionProject,
      resolver: {
        status: 'ok',
        reason: 'provided_caption_project',
        captionPath: options.captionPath || options.captionProject.descriptorPath || '',
        captionProjectId: options.captionProject.projectFilePath || options.captionProject.descriptorPath || '',
        resolverConfidence: 100,
        durationDeltaSec: Math.abs((Number(project.duration) || 0) - (Number(options.captionProject.duration) || 0)),
        captionDurationSec: Number(options.captionProject.duration) || 0,
        projectDurationSec: Number(project.duration) || 0,
        candidates: [],
      },
    }
    : loadCaptionProjectForSFXProject(project, options);
  if (!loaded.captionProject) {
    return { ...loaded, candidates: [], utterances: [], speakerKeys: new Map() };
  }
  const beat = buildCaptionBeatCandidates(project, loaded.captionProject, {
    captionPath: loaded.captionPath,
    captionProjectId: loaded.resolver?.captionProjectId || '',
    resolver: loaded.resolver,
  });
  return { ...loaded, ...beat };
}
