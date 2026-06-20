#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventAudibleStart } from '../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor } from '../lib/live-sfx-project-io.mjs';
import { buildCaptionBeatCandidates, captionBeatCandidateConfig } from '../sfx-automation/caption/build-caption-beat-candidates.mjs';
import { extractCaptionBeatFeatures } from '../sfx-automation/caption/extract-caption-beat-features.mjs';
import { resolveCaptionProjectForMedia } from '../sfx-automation/caption/find-caption-project.mjs';
import { readCaptionProject } from '../sfx-automation/caption/load-caption-project.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const defaultProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v2/visible-caption-corpus.jsonl');
const defaultSummaryPath = resolve(editorRoot, 'data/sfx-automation-v2/visible-caption-corpus-summary.md');
const lockedHoldoutId = 'footage_06_10_26_sfx';
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

function parseIdSet(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function normalizeCategoryId(value) {
  const raw = String(value || '').trim();
  const withoutNamespace = raw.toLowerCase().startsWith('manual:') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return withoutNamespace
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function captionFamily(value) {
  const id = normalizeCategoryId(value);
  return captionFamilies.has(id) ? id : '';
}

function round(value, places = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function projectSpeakerKeys(cues) {
  const keys = new Map();
  for (const cue of cues) {
    const speaker = String(cue.speaker || '');
    if (!speaker || keys.has(speaker)) continue;
    keys.set(speaker, `speaker_${keys.size + 1}`);
  }
  return keys;
}

function cuePayload(cue, index, speakerKeys, wordsById) {
  const wordIds = new Set(Array.isArray(cue.wordIds) ? cue.wordIds.map(String) : []);
  const words = [...wordIds]
    .map((id) => wordsById.get(id))
    .filter(Boolean)
    .map((word) => ({
      id: word.id,
      text: word.text,
      start: round(word.start),
      end: round(word.end),
    }));
  return {
    id: cue.id,
    index,
    start: round(cue.start),
    end: round(cue.end),
    text: cue.text,
    speakerKey: speakerKeys.get(cue.speaker) || '',
    words,
  };
}

function zoomPayload(marker) {
  return {
    id: marker.id,
    startSeconds: round(marker.startSeconds),
    endSeconds: round(marker.endSeconds),
    durationSeconds: round(marker.durationSeconds),
  };
}

function manualEventPayload(event) {
  const rawCategoryId = String(event.categoryId || '');
  const normalizedCategoryId = normalizeCategoryId(rawCategoryId);
  const captionFamilyId = captionFamily(rawCategoryId);
  return {
    id: event.id,
    rawCategoryId,
    normalizedCategoryId,
    family: normalizedCategoryId,
    captionFamily: captionFamilyId,
    startSeconds: round(event.startSeconds),
    audibleStartSeconds: round(eventAudibleStart(event)),
    audibleOffsetSeconds: round(event.audibleOffsetSeconds || 0),
    snapZoomId: event.snapZoomId || '',
    track: Number(event.track) || 1,
    isAutomation: Boolean(event.automation || String(event.id || '').startsWith('sfxauto_')),
  };
}

function resolverPayload(resolver) {
  return {
    status: resolver?.status || 'failed',
    reason: resolver?.reason || '',
    confidence: round(resolver?.resolverConfidence || 0),
    projectDurationSec: round(resolver?.projectDurationSec),
    captionDurationSec: round(resolver?.captionDurationSec),
    durationDeltaSec: round(resolver?.durationDeltaSec),
    verifiedTimeMap: resolver?.status === 'ok' ? { offsetSec: 0, scale: 1 } : null,
  };
}

function compactCandidate(candidate) {
  const extracted = extractCaptionBeatFeatures(candidate);
  return {
    id: candidate.id,
    targetSec: round(candidate.targetSec),
    targetFrame: candidate.targetFrame,
    cueIds: candidate.cueIds,
    wordIds: candidate.wordIds,
    beatGroupId: candidate.beatGroupId,
    anchorTypes: candidate.anchorTypes,
    anchors: candidate.anchors.map((anchor) => ({
      type: anchor.type,
      seconds: round(anchor.seconds),
      cueId: anchor.cueId,
      wordId: anchor.wordId || '',
      zoomMarkerId: anchor.zoomMarkerId || '',
    })),
    zoomMarkerIds: candidate.zoomMarkerIds,
    speakerKey: candidate.speaker,
    text: candidate.text,
    denseFeatures: extracted.dense,
    lexicalTokens: extracted.lexical,
  };
}

function projectRecord(meta) {
  const { project } = readLiveSFXDescriptor(meta.interface_path);
  const resolver = resolveCaptionProjectForMedia(project, { captionPath: meta.caption_source });
  let captionProject = null;
  let captionLoadError = '';
  try {
    captionProject = meta.caption_source ? readCaptionProject(meta.caption_source) : null;
  } catch (error) {
    captionLoadError = error instanceof Error ? error.message : String(error);
  }

  const cues = captionProject?.cues || [];
  const wordsById = new Map((captionProject?.words || []).map((word) => [word.id, word]));
  const speakerKeys = projectSpeakerKeys(cues);
  const trainEligible = resolver.status === 'ok' && Boolean(captionProject);
  const candidateResult = trainEligible
    ? buildCaptionBeatCandidates(project, captionProject, {
      captionPath: meta.caption_source,
      captionProjectId: resolver.captionProjectId,
      resolver,
    })
    : { candidates: [] };
  const manualEvents = (project.events || [])
    .map(manualEventPayload)
    .filter((event) => event.family && !event.isAutomation);

  return {
    schemaVersion: 2,
    project: {
      projectId: meta.project_id,
      durationSec: round(project.duration),
      fps: round(project.fps),
    },
    resolver: resolverPayload(resolver),
    trainEligible,
    captionLoadError,
    candidateConfig: captionBeatCandidateConfig,
    cues: cues.map((cue, index) => cuePayload(cue, index, speakerKeys, wordsById)),
    zoomMarkers: (project.zoomMarkers || []).map(zoomPayload),
    manualEvents,
    candidates: candidateResult.candidates.map(compactCandidate),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const projectsPath = resolve(String(args.get('projects') || defaultProjectsPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryPath = resolve(String(args.get('summary-out') || defaultSummaryPath));
  const includeProjectIds = parseIdSet(args.get('project-ids'));
  const denyProjectIds = parseIdSet(args.get('deny-project')) || new Set([lockedHoldoutId]);
  denyProjectIds.add(lockedHoldoutId);

  const allProjects = JSON.parse(readFileSync(projectsPath, 'utf8')).projects || [];
  const selected = allProjects.filter((project) => {
    if (includeProjectIds && !includeProjectIds.has(project.project_id)) return false;
    return !denyProjectIds.has(project.project_id);
  });
  if (selected.some((project) => project.project_id === lockedHoldoutId)) {
    throw new Error(`Refusing to export locked holdout project: ${lockedHoldoutId}`);
  }

  const lines = [];
  const summary = {
    projectCount: selected.length,
    trainEligibleProjectCount: 0,
    manualEventCount: 0,
    manualCaptionEventCount: 0,
    candidateCount: 0,
    resolverFailures: [],
    datasetSha256: '',
  };
  for (const meta of selected) {
    const record = projectRecord(meta);
    if (record.trainEligible) summary.trainEligibleProjectCount += 1;
    else summary.resolverFailures.push({ projectId: record.project.projectId, reason: record.resolver.reason });
    summary.manualEventCount += record.manualEvents.length;
    summary.manualCaptionEventCount += record.manualEvents.filter((event) => event.captionFamily).length;
    summary.candidateCount += record.candidates.length;
    lines.push(JSON.stringify(record));
  }
  const content = `${lines.join('\n')}\n`;
  summary.datasetSha256 = sha256(content);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
  const md = [
    '# Visible Caption Corpus V2',
    '',
    `Projects: ${summary.projectCount}`,
    `Train-eligible projects: ${summary.trainEligibleProjectCount}`,
    `Manual SFX events: ${summary.manualEventCount}`,
    `Manual caption-family events: ${summary.manualCaptionEventCount}`,
    `Beat candidates: ${summary.candidateCount}`,
    `Dataset SHA-256: ${summary.datasetSha256}`,
    '',
    '## Resolver Failures',
    '',
    ...(summary.resolverFailures.length
      ? summary.resolverFailures.map((item) => `- ${item.projectId}: ${item.reason}`)
      : ['- none']),
    '',
  ].join('\n');
  writeFileSync(summaryPath, md, 'utf8');
  console.log(JSON.stringify({ outputPath, summaryPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
