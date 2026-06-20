#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventAudibleStart } from '../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor } from '../lib/live-sfx-project-io.mjs';
import { buildCaptionCandidates } from '../sfx-automation/candidates/build-caption-candidates.mjs';
import { readCaptionProject } from '../sfx-automation/caption/load-caption-project.mjs';
import { resolveCaptionProjectForMedia } from '../sfx-automation/caption/find-caption-project.mjs';
import { loadPolicy, generateSFXPass } from '../sfx-automation/run-sfx-pass.mjs';
import { scoreCaptionCandidatesLocal } from '../sfx-automation/scoring/caption-rule-scorer.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const defaultProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v1/model-slices/visible-caption-model-slices.json');
const defaultSummaryPath = resolve(editorRoot, 'data/sfx-automation-v1/model-slices/visible-caption-model-slices-summary.md');
const defaultProjectIds = ['footage_06_02_26_sfx', 'footage_05_07_26_sfx', 'footage_05_31_26_sfx', 'footage_05_27_26_sfx'];
const captionFamilies = new Set(['ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch']);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    args.set(key, value);
  }
  return args;
}

function parseProjectIds(value) {
  const ids = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return ids.length ? ids : defaultProjectIds;
}

function categoryFamily(value) {
  const id = String(value || '').toLowerCase().replaceAll('-', '_').replace(/\s+/g, '_');
  return captionFamilies.has(id) ? id : '';
}

function compactEvent(event, projectId) {
  return {
    id: event.id,
    projectId,
    family: categoryFamily(event.categoryId),
    categoryId: event.categoryId,
    fileName: event.fileName,
    timeSec: round(Number(event.startSeconds) || 0),
    audibleTimeSec: round(eventAudibleStart(event)),
    audibleOffsetSeconds: round(Number(event.audibleOffsetSeconds) || 0),
    snapZoomId: event.snapZoomId || '',
  };
}

function chooseDenseSegment(events, durationSec, lengthSec) {
  const anchors = events.map((event) => event.audibleTimeSec).sort((a, b) => a - b);
  if (!anchors.length || durationSec <= lengthSec) {
    return { startSec: 0, endSec: Math.min(durationSec, lengthSec), eventCount: anchors.length };
  }
  let best = { startSec: 0, endSec: lengthSec, eventCount: 0 };
  for (const anchor of anchors) {
    const startSec = Math.max(0, Math.min(durationSec - lengthSec, anchor - 30));
    const endSec = startSec + lengthSec;
    const eventCount = anchors.filter((seconds) => seconds >= startSec && seconds <= endSec).length;
    if (eventCount > best.eventCount) best = { startSec, endSec, eventCount };
  }
  return best;
}

function cueWords(cue, captionProject) {
  const wordIds = new Set(cue.wordIds || []);
  const words = wordIds.size
    ? captionProject.words.filter((word) => wordIds.has(word.id))
    : captionProject.words.filter((word) => word.start >= cue.start - 0.05 && word.end <= cue.end + 0.05);
  return words.map((word) => ({
    id: word.id,
    text: word.text,
    start: round(word.start),
    end: round(word.end),
  }));
}

function cuePayload(cue, index, cues, captionProject) {
  return {
    id: cue.id,
    index,
    start: round(cue.start),
    end: round(cue.end),
    speaker: cue.speaker,
    text: cue.text,
    previous2: cues[index - 2]?.text || '',
    previous1: cues[index - 1]?.text || '',
    next1: cues[index + 1]?.text || '',
    next2: cues[index + 2]?.text || '',
    words: cueWords(cue, captionProject),
  };
}

function zoomPayload(marker) {
  return {
    id: marker.id,
    name: marker.name,
    startSeconds: round(marker.startSeconds),
    endSeconds: round(marker.endSeconds),
    durationSeconds: round(marker.durationSeconds),
  };
}

function nearestManual(candidate, manualEvents) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of manualEvents) {
    const distance = Math.abs(Number(candidate.candidate.targetSec) - Number(event.audibleTimeSec));
    if (distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }
  return best ? {
    family: best.family,
    audibleTimeSec: round(best.audibleTimeSec),
    distanceSec: round(bestDistance),
    fileName: best.fileName,
  } : null;
}

function familyPolicy(policy, family) {
  return policy.families?.[family] || {};
}

function suppressionReason(scored, policy) {
  const family = scored.primaryFamily;
  if (!family || family === 'none') return scored.reasonCode || 'none_family';
  const config = familyPolicy(policy, family);
  if (config.enabled === false) return 'family_disabled';
  if (Number(scored.confidence) < Number(config.threshold ?? 0)) return 'below_threshold';
  const requiredMargin = Number(config.marginScore);
  if (Number.isFinite(requiredMargin) && Number(scored.scoreMargin) < requiredMargin) return 'below_margin';
  return 'predecoder_passed';
}

function candidatePayload(scored, policy, manualEvents) {
  const candidate = scored.candidate;
  const features = candidate.features || {};
  return {
    id: candidate.id,
    cueIds: candidate.cueIds,
    targetSec: round(candidate.targetSec),
    text: candidate.text,
    speaker: candidate.speaker,
    primaryFamily: scored.primaryFamily,
    confidence: round(scored.confidence, 4),
    scoreMargin: Number.isFinite(Number(scored.scoreMargin)) ? round(Number(scored.scoreMargin), 4) : null,
    reasonCode: scored.reasonCode,
    suppressionReason: suppressionReason(scored, policy),
    familyScores: scored.familyScores,
    anchorType: features.anchorType,
    selectedZoomId: features.nearestZoomId || '',
    nearestZoomDistanceSec: Number.isFinite(Number(features.nearestZoomDistanceSec)) ? round(Number(features.nearestZoomDistanceSec)) : null,
    cueStartSec: round(features.cueStartSec),
    cueEndSec: round(features.cueEndSec),
    previousText: features.previousText,
    nextText: features.nextText,
    previous2Text: features.previous2Text,
    next2Text: features.next2Text,
    speakerChangedFromPrevious: features.speakerChangedFromPrevious,
    speakerChangesToNext: features.speakerChangesToNext,
    nearestManual: nearestManual(scored, manualEvents),
  };
}

function round(value, places = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectsPath = resolve(String(args.get('projects') || defaultProjectsPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryPath = resolve(String(args.get('summary-out') || defaultSummaryPath));
  const projectIds = parseProjectIds(args.get('project-ids'));
  const segmentLengthSec = Number(args.get('segment-seconds') || 600);
  const projectRows = JSON.parse(readFileSync(projectsPath, 'utf8')).projects || [];
  const policy = loadPolicy();
  const slices = [];

  for (const projectId of projectIds) {
    const meta = projectRows.find((project) => project.project_id === projectId);
    if (!meta) throw new Error(`Project not found in compilation: ${projectId}`);
    const { project } = readLiveSFXDescriptor(meta.interface_path);
    const resolver = resolveCaptionProjectForMedia(project, { captionPath: meta.caption_source });
    const captionPath = resolver.captionPath || meta.caption_source;
    const captionProject = readCaptionProject(captionPath);
    const manualEvents = project.events
      .map((event) => compactEvent(event, meta.project_id))
      .filter((event) => captionFamilies.has(event.family));
    const segment = chooseDenseSegment(manualEvents, Number(project.duration) || 0, segmentLengthSec);
    const captionResult = buildCaptionCandidates(project, { captionPath, captionProject });
    const scoredCandidates = scoreCaptionCandidatesLocal(captionResult.candidates)
      .filter((item) => Number(item.candidate.targetSec) >= segment.startSec - 2 && Number(item.candidate.targetSec) <= segment.endSec + 2);
    const generated = generateSFXPass({ ...project, events: [], decks: {} }, {
      seed: 'slice-export',
      scorer: 'local',
      captionPath,
      region: { start: segment.startSec, end: segment.endSec },
    }).project.events
      .filter((event) => String(event.id || '').startsWith('sfxauto_'))
      .map((event) => compactEvent(event, meta.project_id))
      .filter((event) => captionFamilies.has(event.family));
    const cuesInSegment = captionProject.cues
      .map((cue, index) => ({ cue, index }))
      .filter(({ cue }) => cue.end >= segment.startSec - 2 && cue.start <= segment.endSec + 2)
      .map(({ cue, index }) => cuePayload(cue, index, captionProject.cues, captionProject));
    const manualInSegment = manualEvents.filter((event) => event.audibleTimeSec >= segment.startSec - 2 && event.audibleTimeSec <= segment.endSec + 2);
    slices.push({
      projectId: meta.project_id,
      projectName: meta.name,
      mediaPath: meta.media_path,
      interfacePath: meta.interface_path,
      captionPath,
      projectDurationSec: round(project.duration),
      captionDurationSec: round(captionProject.duration),
      resolver,
      segment: {
        startSec: round(segment.startSec),
        endSec: round(segment.endSec),
        lengthSec: round(segment.endSec - segment.startSec),
        manualCaptionEventCount: manualInSegment.length,
      },
      cues: cuesInSegment,
      zoomMarkers: project.zoomMarkers
        .filter((marker) => marker.endSeconds >= segment.startSec - 2 && marker.startSeconds <= segment.endSec + 2)
        .map(zoomPayload),
      manualEvents: manualInSegment,
      generatedEvents: generated,
      scoredCandidates: scoredCandidates.map((item) => candidatePayload(item, policy, manualInSegment)),
    });
  }

  const payload = {
    version: 1,
    purpose: 'Visible-only caption-family model/debug slices requested by Pro. Locked holdout footage_06_10_26_sfx is not included.',
    projectIds,
    segmentLengthSec,
    slices,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const lines = ['# Visible Caption Model Slices', ''];
  for (const slice of slices) {
    lines.push(`- ${slice.projectId}: ${slice.segment.startSec}s-${slice.segment.endSec}s, cues ${slice.cues.length}, manual caption events ${slice.manualEvents.length}, candidates ${slice.scoredCandidates.length}`);
  }
  lines.push('');
  writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, summaryPath, slices: slices.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
