#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventAudibleStart } from '../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor } from '../lib/live-sfx-project-io.mjs';
import { buildCaptionBeatCandidates } from '../sfx-automation/caption/build-caption-beat-candidates.mjs';
import { buildCaptionMoments } from '../sfx-automation/caption/build-caption-moments.mjs';
import { resolveCaptionProjectForMedia } from '../sfx-automation/caption/find-caption-project.mjs';
import { readCaptionProject } from '../sfx-automation/caption/load-caption-project.mjs';
import { routerClassForManualEvent, ROUTER_CLASSES } from '../sfx-automation/editorial-router-taxonomy.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const defaultProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const defaultManifestPath = resolve(editorRoot, 'validation/project-manifest-v1.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v3/caption-moment-corpus.jsonl');
const defaultSummaryJsonPath = resolve(editorRoot, 'data/sfx-automation-v3/caption-moment-corpus-summary.json');
const defaultSummaryMdPath = resolve(editorRoot, 'data/sfx-automation-v3/caption-moment-corpus-summary.md');
const LOCKED_FINAL_HOLDOUT = 'footage_06_10_26_sfx';
const OPENED_BLIND_PROJECT = 'blind_caption_only_06_17_26';
const prohibitedProjectIds = new Set([LOCKED_FINAL_HOLDOUT, OPENED_BLIND_PROJECT]);

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
  const ids = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function assertTrainingProjectAllowed(projectId) {
  if (prohibitedProjectIds.has(projectId)) {
    throw new Error(`Refusing to export prohibited SFX automation training project: ${projectId}`);
  }
}

function manifestMap(manifestPath) {
  const manifest = readJson(manifestPath);
  return new Map((manifest.projects || []).map((project) => [project.projectId, project]));
}

export function manualEventPayload(event) {
  const isAutomation = Boolean(event.automation || String(event.id || '').startsWith('sfxauto_'));
  const rawCategoryId = String(event.categoryId || '');
  const fileName = String(event.fileName || '');
  const routerFamily = routerClassForManualEvent({ ...event, rawCategoryId, fileName });
  return {
    id: String(event.id || ''),
    rawCategoryId,
    fileName,
    routerFamily,
    audibleStartSeconds: round(eventAudibleStart(event)),
    isAutomation,
  };
}

function compactTimingOption(option) {
  return {
    optionId: option.optionId,
    candidateId: option.candidateId,
    targetSec: round(option.targetSec),
    anchorType: option.anchorType || '',
    source: option.source || '',
    cueIds: option.cueIds || [],
    wordIds: option.wordIds || [],
    zoomMarkerIds: option.zoomMarkerIds || [],
    parentFeatures: option.parentFeatures || {},
  };
}

function compactMoment(moment) {
  return {
    schemaVersion: 3,
    featureVersion: 3,
    momentId: moment.momentId,
    beatGroupId: moment.beatGroupId,
    kind: moment.kind,
    momentSec: round(moment.momentSec),
    cueIds: moment.cueIds || [],
    text: moment.text || '',
    captionWindow: moment.captionWindow || '',
    features: moment.features,
    timingOptions: (moment.timingOptions || []).map(compactTimingOption),
    candidateIds: (moment.candidates || []).map((candidate) => candidate.id),
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
  };
}

export function projectRecord(meta, manifestByProjectId) {
  assertTrainingProjectAllowed(meta.project_id);
  const manifestProject = manifestByProjectId.get(meta.project_id) || {};
  const { project } = readLiveSFXDescriptor(meta.interface_path);
  const resolver = resolveCaptionProjectForMedia(project, { captionPath: meta.caption_source });
  let captionProject = null;
  let captionLoadError = '';
  try {
    captionProject = meta.caption_source ? readCaptionProject(meta.caption_source) : null;
  } catch (error) {
    captionLoadError = error instanceof Error ? error.message : String(error);
  }
  const trainEligible = resolver.status === 'ok' && Boolean(captionProject) && manifestProject.trainEligible !== false;
  const beat = trainEligible
    ? buildCaptionBeatCandidates(project, captionProject, {
      captionPath: meta.caption_source,
      captionProjectId: resolver.captionProjectId,
      resolver,
    })
    : { candidates: [] };
  const moments = trainEligible
    ? buildCaptionMoments(project, captionProject, beat.candidates).map(compactMoment)
    : [];
  const manualEvents = (project.events || [])
    .map(manualEventPayload)
    .filter((event) => !event.isAutomation);
  for (const event of manualEvents) {
    if (!ROUTER_CLASSES.includes(event.routerFamily) || event.routerFamily === 'none') {
      throw new Error(`Invalid router family for ${meta.project_id} event ${event.id}: ${event.routerFamily}`);
    }
  }
  return {
    schemaVersion: 3,
    project: {
      projectId: meta.project_id,
      durationSec: round(project.duration),
      fps: round(project.fps),
      generalizationGroupId: manifestProject.generalizationGroupId || '',
    },
    resolver: resolverPayload(resolver),
    trainEligible,
    captionLoadError,
    moments,
    manualEvents,
  };
}

export function reachabilityAudit(record) {
  const byClass = Object.fromEntries(ROUTER_CLASSES.filter((item) => item !== 'none').map((routerClass) => [routerClass, {
    humanCount: 0,
    reachableWithinStrictWindow: 0,
    reachableWithin075: 0,
    unreachable: 0,
  }]));
  const optionTimes = (record.moments || []).flatMap((moment) => (
    (moment.timingOptions || []).map((option) => Number(option.targetSec)).filter(Number.isFinite)
  ));
  for (const event of record.manualEvents || []) {
    const routerFamily = event.routerFamily;
    if (!byClass[routerFamily]) continue;
    const time = Number(event.audibleStartSeconds);
    const strictWindow = routerFamily === 'pop' ? 0.35 : 0.75;
    const nearest = optionTimes.length && Number.isFinite(time)
      ? Math.min(...optionTimes.map((target) => Math.abs(target - time)))
      : Number.POSITIVE_INFINITY;
    byClass[routerFamily].humanCount += 1;
    if (nearest <= strictWindow) byClass[routerFamily].reachableWithinStrictWindow += 1;
    if (nearest <= 0.75) byClass[routerFamily].reachableWithin075 += 1;
    if (nearest > strictWindow) byClass[routerFamily].unreachable += 1;
  }
  return byClass;
}

function mergeReachability(left, right) {
  for (const [routerClass, values] of Object.entries(right)) {
    if (!left[routerClass]) left[routerClass] = { humanCount: 0, reachableWithinStrictWindow: 0, reachableWithin075: 0, unreachable: 0 };
    for (const key of Object.keys(left[routerClass])) {
      left[routerClass][key] += Number(values[key] || 0);
    }
  }
}

function summaryMarkdown(summary) {
  return [
    '# Caption Moment Corpus V3',
    '',
    `Projects: ${summary.projectCount}`,
    `Train-eligible projects: ${summary.trainEligibleProjectCount}`,
    `Moments: ${summary.momentCount}`,
    `Timing options: ${summary.timingOptionCount}`,
    `Manual human events: ${summary.manualEventCount}`,
    `Dataset SHA-256: ${summary.datasetSha256}`,
    '',
    'Reachability is diagnostic only; it is not a product score.',
    '',
    '## Reachability By Router Class',
    '',
    '| Class | Human | Strict Reachable | Reachable 0.75s | Unreachable |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(summary.reachabilityByClass).map(([routerClass, values]) => (
      `| ${routerClass} | ${values.humanCount} | ${values.reachableWithinStrictWindow} | ${values.reachableWithin075} | ${values.unreachable} |`
    )),
    '',
    '## Resolver Failures',
    '',
    ...(summary.resolverFailures.length
      ? summary.resolverFailures.map((item) => `- ${item.projectId}: ${item.reason}`)
      : ['- none']),
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const projectsPath = resolve(String(args.get('projects') || defaultProjectsPath));
  const manifestPath = resolve(String(args.get('project-manifest') || defaultManifestPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryJsonPath = resolve(String(args.get('summary-json') || defaultSummaryJsonPath));
  const summaryMdPath = resolve(String(args.get('summary-md') || defaultSummaryMdPath));
  const includeProjectIds = parseIdSet(args.get('project-ids'));
  if (includeProjectIds) {
    for (const projectId of includeProjectIds) assertTrainingProjectAllowed(projectId);
  }

  const manifestByProjectId = manifestMap(manifestPath);
  const projects = readJson(projectsPath).projects || [];
  const selected = projects.filter((project) => {
    if (prohibitedProjectIds.has(project.project_id)) return false;
    return !includeProjectIds || includeProjectIds.has(project.project_id);
  });
  const lines = [];
  const summary = {
    schemaVersion: 3,
    projectCount: selected.length,
    trainEligibleProjectCount: 0,
    momentCount: 0,
    timingOptionCount: 0,
    manualEventCount: 0,
    datasetSha256: '',
    prohibitedProjectIds: [...prohibitedProjectIds].sort(),
    reachabilityByClass: {},
    resolverFailures: [],
  };
  for (const meta of selected) {
    const record = projectRecord(meta, manifestByProjectId);
    if (prohibitedProjectIds.has(record.project.projectId)) throw new Error(`Prohibited project reached output: ${record.project.projectId}`);
    if (record.trainEligible) summary.trainEligibleProjectCount += 1;
    else summary.resolverFailures.push({ projectId: record.project.projectId, reason: record.resolver.reason || record.captionLoadError });
    summary.momentCount += record.moments.length;
    summary.timingOptionCount += record.moments.reduce((sum, moment) => sum + (moment.timingOptions || []).length, 0);
    summary.manualEventCount += record.manualEvents.length;
    mergeReachability(summary.reachabilityByClass, reachabilityAudit(record));
    lines.push(JSON.stringify(record));
  }
  const content = `${lines.join('\n')}\n`;
  summary.datasetSha256 = sha256(content);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
  writeJson(summaryJsonPath, summary);
  mkdirSync(dirname(summaryMdPath), { recursive: true });
  writeFileSync(summaryMdPath, summaryMarkdown(summary), 'utf8');
  console.log(JSON.stringify({ outputPath, summaryJsonPath, summaryMdPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
