#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCaptionProject } from '../sfx-automation/caption/load-caption-project.mjs';
import { cueContext, formatCueWindow, textFeatureFlags } from '../sfx-automation/caption/text-features.mjs';

const targetFamilies = new Set(['ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch']);
const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const defaultProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const defaultEventsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_events.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v1/caption-evidence.json');
const defaultSummaryPath = resolve(editorRoot, 'data/sfx-automation-v1/caption-evidence-summary.md');

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

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseProjectIdSet(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function categoryToFamily(value) {
  const normalized = String(value || '').toLowerCase().replaceAll('-', '_').replace(/\s+/g, '_');
  if (targetFamilies.has(normalized)) return normalized;
  return '';
}

function audibleTime(row) {
  return Number(row.time_sec || 0) + Math.max(0, Number(row.audible_offset_sec || 0));
}

function eventPayload(row) {
  return {
    projectId: row.project_id,
    eventIndex: row.event_index,
    family: categoryToFamily(row.category_id),
    categoryId: row.category_id,
    categoryName: row.category_name,
    assetName: row.asset_name,
    timeSec: Number(row.time_sec) || 0,
    audibleTimeSec: audibleTime(row),
    captionDeltaSec: Number.isFinite(Number(row.caption_delta_sec)) ? Number(row.caption_delta_sec) : null,
    captionText: String(row.caption_text || ''),
    captionWindow: String(row.caption_window || ''),
    speaker: String(row.speaker || ''),
    nearestZoomDeltaSec: Number.isFinite(Number(row.nearest_zoom_delta_sec)) ? Number(row.nearest_zoom_delta_sec) : null,
    snapZoomId: String(row.snap_zoom_id || ''),
  };
}

function nearestCueDistanceSeconds(cue, seconds) {
  if (seconds < cue.start) return cue.start - seconds;
  if (seconds > cue.end) return seconds - cue.end;
  return 0;
}

function nearestCueForTime(cues, seconds) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const distance = nearestCueDistanceSeconds(cue, seconds);
    if (distance < bestDistance) {
      best = { cue, index, distance };
      bestDistance = distance;
    }
  }
  return best;
}

function cueAnchorDelta(cue, seconds) {
  return seconds - cue.start;
}

function buildCueCandidate(projectMeta, captionProject, cue, cueIndex, events, toleranceSeconds) {
  const context = cueContext(captionProject.cues, cueIndex, 3);
  const nearEvents = events
    .map((event) => ({
      ...event,
      cueStartDeltaSec: cueAnchorDelta(cue, event.audibleTimeSec),
      cueDistanceSec: nearestCueDistanceSeconds(cue, event.audibleTimeSec),
    }))
    .filter((event) => Math.abs(event.cueStartDeltaSec) <= toleranceSeconds || event.cueDistanceSec <= 0.2)
    .sort((a, b) => Math.abs(a.cueStartDeltaSec) - Math.abs(b.cueStartDeltaSec) || a.family.localeCompare(b.family));
  const labels = [...new Set(nearEvents.map((event) => event.family))].sort();
  return {
    exampleType: labels.length ? 'cue_positive' : 'cue_negative',
    projectId: projectMeta.project_id,
    projectName: projectMeta.name,
    mediaPath: projectMeta.media_path,
    captionSource: projectMeta.caption_source,
    cueId: cue.id,
    cueIndex,
    anchorSec: cue.start,
    cueStartSec: cue.start,
    cueEndSec: cue.end,
    speaker: cue.speaker,
    text: cue.text,
    textFeatures: textFeatureFlags(cue.text),
    context,
    captionWindow: formatCueWindow(context),
    labels,
    nearEvents,
  };
}

function buildPositiveEventExample(projectMeta, captionProject, row, eventsByProject) {
  const event = eventPayload(row);
  const nearest = nearestCueForTime(captionProject.cues, event.audibleTimeSec);
  const cue = nearest?.cue || null;
  const cueIndex = nearest?.index ?? -1;
  const context = cue ? cueContext(captionProject.cues, cueIndex, 3) : [];
  const siblingEvents = (eventsByProject.get(projectMeta.project_id) || [])
    .filter((candidate) => candidate.event_index !== row.event_index)
    .map(eventPayload)
    .filter((candidate) => Math.abs(candidate.audibleTimeSec - event.audibleTimeSec) <= 1.5)
    .sort((a, b) => Math.abs(a.audibleTimeSec - event.audibleTimeSec) - Math.abs(b.audibleTimeSec - event.audibleTimeSec));
  return {
    exampleType: 'event_positive',
    projectId: projectMeta.project_id,
    projectName: projectMeta.name,
    mediaPath: projectMeta.media_path,
    captionSource: projectMeta.caption_source,
    family: event.family,
    event,
    cueId: cue?.id || '',
    cueIndex,
    anchorSec: event.audibleTimeSec,
    cueStartSec: cue?.start ?? null,
    cueEndSec: cue?.end ?? null,
    cueDistanceSec: nearest?.distance ?? null,
    cueStartDeltaSec: cue ? cueAnchorDelta(cue, event.audibleTimeSec) : null,
    speaker: event.speaker || cue?.speaker || '',
    text: event.captionText || cue?.text || '',
    textFeatures: textFeatureFlags(event.captionText || cue?.text || ''),
    context,
    captionWindow: event.captionWindow || formatCueWindow(context),
    siblingEvents,
  };
}

function topCounts(items, keyFn, limit = 20) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function markdownSummary(evidence) {
  const lines = [];
  lines.push('# Caption SFX Evidence V1');
  lines.push('');
  lines.push(`Projects loaded: ${evidence.summary.loadedCaptionProjectCount}/${evidence.summary.projectCount}`);
  lines.push(`Positive target events: ${evidence.summary.positiveEventCount}`);
  lines.push(`Cue candidates: ${evidence.summary.cueCandidateCount}`);
  lines.push(`Cue positives: ${evidence.summary.cuePositiveCount}`);
  lines.push(`Cue negatives: ${evidence.summary.cueNegativeCount}`);
  lines.push('');
  lines.push('## Positive Events By Family');
  lines.push('');
  for (const [family, count] of Object.entries(evidence.summary.positiveEventsByFamily).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${family}: ${count}`);
  }
  lines.push('');
  lines.push('## Top Positive Cue Texts');
  lines.push('');
  for (const [family, items] of Object.entries(evidence.summary.topPositiveTextsByFamily).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${family}`);
    for (const item of items.slice(0, 12)) {
      lines.push(`- ${item.value}: ${item.count}`);
    }
    lines.push('');
  }
  lines.push('## Top Negative Cue Texts');
  lines.push('');
  for (const item of evidence.summary.topNegativeTexts.slice(0, 24)) {
    lines.push(`- ${item.value}: ${item.count}`);
  }
  lines.push('');
  lines.push('## Ambiguous Cue Labels');
  lines.push('');
  for (const item of evidence.summary.ambiguousCueExamples.slice(0, 30)) {
    lines.push(`- ${item.projectId} @ ${item.anchorSec.toFixed(2)} [${item.labels.join(', ')}]: ${item.text}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectsPath = resolve(String(args.get('projects') || defaultProjectsPath));
  const eventsPath = resolve(String(args.get('events') || defaultEventsPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryPath = resolve(String(args.get('summary-out') || defaultSummaryPath));
  const toleranceSeconds = Number(args.get('tolerance-seconds') || 0.75);
  const includeProjectIds = parseProjectIdSet(args.get('project-ids'));
  const excludeProjectIds = parseProjectIdSet(args.get('exclude-projects'));
  const allProjectRows = loadJson(projectsPath).projects || [];
  const projectRows = allProjectRows.filter((project) => {
    if (includeProjectIds && !includeProjectIds.has(project.project_id)) return false;
    if (excludeProjectIds?.has(project.project_id)) return false;
    return true;
  });
  const projectIdSet = new Set(projectRows.map((project) => project.project_id));
  const eventRows = (loadJson(eventsPath).events || []).filter((row) => projectIdSet.has(row.project_id));
  const eventsByProject = new Map();
  for (const row of eventRows) {
    const family = categoryToFamily(row.category_id);
    if (!family) continue;
    const rows = eventsByProject.get(row.project_id) || [];
    rows.push(row);
    eventsByProject.set(row.project_id, rows);
  }

  const positiveEventExamples = [];
  const cueCandidates = [];
  const loadErrors = [];
  let loadedCaptionProjectCount = 0;

  for (const projectMeta of projectRows) {
    if (!projectMeta.caption_source) continue;
    let captionProject;
    try {
      captionProject = readCaptionProject(projectMeta.caption_source);
      loadedCaptionProjectCount += 1;
    } catch (error) {
      loadErrors.push({
        projectId: projectMeta.project_id,
        captionSource: projectMeta.caption_source,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const projectEvents = eventsByProject.get(projectMeta.project_id) || [];
    for (const row of projectEvents) {
      positiveEventExamples.push(buildPositiveEventExample(projectMeta, captionProject, row, eventsByProject));
    }
    const eventPayloads = projectEvents.map(eventPayload);
    captionProject.cues.forEach((cue, cueIndex) => {
      cueCandidates.push(buildCueCandidate(projectMeta, captionProject, cue, cueIndex, eventPayloads, toleranceSeconds));
    });
  }

  const positiveEventsByFamily = {};
  for (const example of positiveEventExamples) {
    positiveEventsByFamily[example.family] = (positiveEventsByFamily[example.family] || 0) + 1;
  }
  const topPositiveTextsByFamily = {};
  for (const family of targetFamilies) {
    const examples = positiveEventExamples.filter((example) => example.family === family);
    topPositiveTextsByFamily[family] = topCounts(examples, (example) => example.textFeatures.normalized, 20);
  }
  const cuePositiveCount = cueCandidates.filter((example) => example.labels.length > 0).length;
  const negativeCueCandidates = cueCandidates.filter((example) => example.labels.length === 0);
  const ambiguousCueExamples = cueCandidates
    .filter((example) => example.labels.length > 1)
    .slice(0, 200)
    .map((example) => ({
      projectId: example.projectId,
      anchorSec: example.anchorSec,
      text: example.text,
      labels: example.labels,
    }));

  const evidence = {
    version: 1,
    source: {
      projectsPath,
      eventsPath,
      toleranceSeconds,
    },
    summary: {
      projectCount: projectRows.length,
      loadedCaptionProjectCount,
      loadErrors,
      positiveEventCount: positiveEventExamples.length,
      positiveEventsByFamily,
      cueCandidateCount: cueCandidates.length,
      cuePositiveCount,
      cueNegativeCount: negativeCueCandidates.length,
      topPositiveTextsByFamily,
      topNegativeTexts: topCounts(negativeCueCandidates, (example) => example.textFeatures.normalized, 30),
      ambiguousCueCount: cueCandidates.filter((example) => example.labels.length > 1).length,
      ambiguousCueExamples,
    },
    positiveEventExamples,
    cueCandidates,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  writeFileSync(summaryPath, markdownSummary(evidence), 'utf8');
  console.log(JSON.stringify({
    outputPath,
    summaryPath,
    positiveEventCount: evidence.summary.positiveEventCount,
    cueCandidateCount: evidence.summary.cueCandidateCount,
    cuePositiveCount: evidence.summary.cuePositiveCount,
    cueNegativeCount: evidence.summary.cueNegativeCount,
    loadErrors: evidence.summary.loadErrors.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
