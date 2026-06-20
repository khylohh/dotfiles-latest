#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultCorpusPath = resolve(editorRoot, 'data/sfx-automation-v2/visible-caption-corpus.jsonl');
const defaultManifestPath = resolve(editorRoot, 'validation/project-manifest-v1.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v2/positive-accent-moments.jsonl');
const defaultSummaryPath = resolve(editorRoot, 'data/sfx-automation-v2/positive-accent-moments-summary.md');
const lockedHoldoutId = 'footage_06_10_26_sfx';
const openedBlindCaptionId = 'blind_caption_only_06_17_26';
const positiveFamilies = new Set(['ding', 'success']);

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

function round(value, places = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeFamily(value) {
  const raw = String(value || '').trim().toLowerCase();
  const withoutNamespace = raw.startsWith('manual:') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return withoutNamespace.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readCorpusRows(path) {
  const rows = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const prohibited = rows.find((row) => [lockedHoldoutId, openedBlindCaptionId].includes(row.project?.projectId));
  if (prohibited) throw new Error(`Prohibited project appears in corpus: ${prohibited.project.projectId}`);
  return rows;
}

function median(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function clusterManualBeats(events) {
  const normalized = (events || [])
    .filter((event) => !event.isAutomation)
    .map((event) => ({
      ...event,
      family: normalizeFamily(event.family),
      time: Number(event.audibleStartSeconds),
    }))
    .filter((event) => event.family && Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const beats = [];
  for (const event of normalized) {
    const last = beats[beats.length - 1];
    if (!last) {
      beats.push({ events: [event] });
      continue;
    }
    const lastTime = median(last.events.map((item) => item.time));
    if (Math.abs(event.time - lastTime) <= 0.300) last.events.push(event);
    else beats.push({ events: [event] });
  }
  return beats.map((beat, index) => {
    const families = [...new Set(beat.events.map((event) => event.family))].sort();
    return {
      id: `manual_beat_${index + 1}`,
      time: median(beat.events.map((event) => event.time)),
      families,
      positiveAccent: families.some((family) => positiveFamilies.has(family)),
    };
  });
}

function anchorPenalty(candidate, family) {
  const types = new Set(candidate.anchorTypes || []);
  const values = [];
  if (types.has('final_word_end')) values.push(0.00);
  if (types.has('cue_end_minus_80ms')) values.push(0.03);
  if (types.has('pause_boundary')) values.push(0.03);
  if (types.has('speaker_turn_start')) values.push(0.05);
  if (types.has('internal_pause_word_end')) values.push(0.06);
  if (types.has('cue_start')) values.push(0.10);
  if (types.has('zoom_onset')) values.push(0.08);
  let base = values.length ? Math.min(...values) : 0.12;
  if (family === 'record_scratch') base += types.has('speaker_turn_start') || types.has('cue_start') ? -0.04 : 0.04;
  else if (types.has('cue_start') && types.size === 1) base += 0.04;
  return Math.max(0, base);
}

function structuralPenalty(candidate) {
  const dense = candidate.denseFeatures || {};
  let penalty = 0;
  const boundary = Number(dense['anchor.boundary_strength']) || 0;
  if (boundary < 0.20) penalty += 0.10;
  if ((Number(dense['anchor.word_timing_available']) || 0) <= 0) penalty += 0.05;
  if ((Number(dense['anchor.is_cue_start']) || 0) > 0 && boundary < 0.30) penalty += 0.08;
  return penalty;
}

function assignmentCost(candidate, beat) {
  const family = beat.families[0] || 'ding';
  return Math.abs(Number(candidate.targetSec) - beat.time) + anchorPenalty(candidate, family) + structuralPenalty(candidate);
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates || []) {
    const key = candidate.beatGroupId || candidate.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.entries()].map(([beatGroupId, items]) => ({
    beatGroupId,
    candidates: items.sort((a, b) => Number(a.targetSec) - Number(b.targetSec) || String(a.id).localeCompare(String(b.id))),
    time: median(items.map((candidate) => Number(candidate.targetSec))),
  })).sort((a, b) => a.time - b.time || a.beatGroupId.localeCompare(b.beatGroupId));
}

function assignLabels(beats, groups) {
  const assignments = new Map();
  const assignedBeats = new Set();
  const possible = [];
  for (const beat of beats) {
    for (const group of groups) {
      let best = null;
      for (const candidate of group.candidates) {
        const delta = Number(candidate.targetSec) - beat.time;
        if (Math.abs(delta) > 0.750) continue;
        const cost = assignmentCost(candidate, beat);
        if (!best || cost < best.cost || (cost === best.cost && Math.abs(delta) < Math.abs(best.delta))) {
          best = { candidate, delta, cost };
        }
      }
      if (best) possible.push({ beat, group, ...best });
    }
  }
  possible.sort((a, b) => a.cost - b.cost || Math.abs(a.delta) - Math.abs(b.delta));
  const usedGroups = new Set();
  for (const item of possible) {
    if (usedGroups.has(item.group.beatGroupId) || assignedBeats.has(item.beat.id)) continue;
    usedGroups.add(item.group.beatGroupId);
    assignedBeats.add(item.beat.id);
    assignments.set(item.group.beatGroupId, item);
  }
  return assignments;
}

function cueWindow(cues, cueIds, radius = 3) {
  const cueIdSet = new Set(cueIds || []);
  const indexes = cues
    .map((cue, index) => (cueIdSet.has(cue.id) ? index : -1))
    .filter((index) => index >= 0);
  const center = indexes.length ? indexes[0] : 0;
  const start = Math.max(0, center - radius);
  const end = Math.min(cues.length, center + radius + 1);
  return {
    previousCues: cues.slice(start, center).map(compactCue),
    currentCues: cues.slice(center, Math.max(center + 1, Math.min(end, indexes[indexes.length - 1] + 1))).map(compactCue),
    nextCues: cues.slice(Math.max(center + 1, Math.min(end, indexes[indexes.length - 1] + 1)), end).map(compactCue),
    markedText: cues.slice(start, end).map((cue) => {
      const text = `${formatTime(cue.start)} ${cue.speakerKey || ''}: ${cue.text}`.trim();
      return cueIdSet.has(cue.id) ? `<CANDIDATE>${text}</CANDIDATE>` : text;
    }).join('\n'),
  };
}

function compactCue(cue) {
  return {
    id: cue.id,
    index: cue.index,
    start: cue.start,
    end: cue.end,
    speakerKey: cue.speakerKey || '',
    text: cue.text || '',
  };
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '0.000';
  return value.toFixed(3);
}

function segmentIdFor(projectId, time) {
  return `${projectId}:segment_${String(Math.floor(Math.max(0, Number(time) || 0) / 45) + 1).padStart(4, '0')}`;
}

function subtypeFor(families) {
  const set = new Set(families);
  if (set.size === 1 && set.has('ding')) return 'ding';
  if (set.size === 1 && set.has('success')) return 'success';
  return null;
}

function labelFor(group, assignments, beats) {
  const assigned = assignments.get(group.beatGroupId);
  if (assigned) {
    return {
      kind: assigned.beat.positiveAccent ? 'positive' : 'hard_other',
      manualBeatId: assigned.beat.id,
      manualTime: round(assigned.beat.time),
      manualFamilies: assigned.beat.families,
      subtype: assigned.beat.positiveAccent ? subtypeFor(assigned.beat.families) : null,
      deltaSec: round(assigned.delta),
      assignmentCost: round(assigned.cost),
    };
  }
  const nearest = Math.min(...beats.map((beat) => Math.abs(beat.time - group.time)), Number.POSITIVE_INFINITY);
  return {
    kind: nearest > 1.250 ? 'clean_negative' : 'ignore',
    manualBeatId: '',
    manualTime: null,
    manualFamilies: [],
    subtype: null,
    deltaSec: null,
    assignmentCost: null,
  };
}

function candidateOption(candidate) {
  return {
    candidateId: candidate.id,
    targetSec: candidate.targetSec,
    targetFrame: candidate.targetFrame,
    anchorTypes: candidate.anchorTypes || [],
    cueIds: candidate.cueIds || [],
    wordIds: candidate.wordIds || [],
    zoomMarkerIds: candidate.zoomMarkerIds || [],
    denseFeatures: candidate.denseFeatures || {},
  };
}

function buildMoments(rows, manifestById) {
  const moments = [];
  const summary = {
    projectCount: 0,
    trainEligibleProjectCount: 0,
    momentCount: 0,
    labelKinds: {},
    positiveSubtypes: {},
    hardOtherFamilies: {},
  };
  for (const row of rows) {
    summary.projectCount += 1;
    if (!row.trainEligible) continue;
    summary.trainEligibleProjectCount += 1;
    const projectId = row.project.projectId;
    const manifest = manifestById.get(projectId) || {};
    const cues = row.cues || [];
    const beats = clusterManualBeats(row.manualEvents || []);
    const groups = groupCandidates(row.candidates || []);
    const assignments = assignLabels(beats, groups);
    for (const group of groups) {
      const representative = group.candidates[Math.floor(group.candidates.length / 2)] || group.candidates[0];
      const cueIds = [...new Set(group.candidates.flatMap((candidate) => candidate.cueIds || []))];
      const label = labelFor(group, assignments, beats);
      summary.labelKinds[label.kind] = (summary.labelKinds[label.kind] || 0) + 1;
      if (label.kind === 'positive') {
        const subtype = label.subtype || 'either';
        summary.positiveSubtypes[subtype] = (summary.positiveSubtypes[subtype] || 0) + 1;
      } else if (label.kind === 'hard_other') {
        for (const family of label.manualFamilies) summary.hardOtherFamilies[family] = (summary.hardOtherFamilies[family] || 0) + 1;
      }
      moments.push({
        schemaVersion: 1,
        projectId,
        generalizationGroupId: manifest.generalizationGroupId || projectId,
        segmentId: segmentIdFor(projectId, group.time),
        momentId: `${projectId}:${group.beatGroupId}`,
        beatGroupId: group.beatGroupId,
        targetSec: round(group.time),
        candidateOptions: group.candidates.map(candidateOption),
        context: cueWindow(cues, cueIds, 3),
        timingFeatures: {
          candidateOptionCount: group.candidates.length,
          representativeAnchorTypes: representative?.anchorTypes || [],
          representativeBoundaryStrength: representative?.denseFeatures?.['anchor.boundary_strength'] ?? null,
        },
        zoomFeatures: {
          zoomMarkerIds: [...new Set(group.candidates.flatMap((candidate) => candidate.zoomMarkerIds || []))],
        },
        label,
      });
    }
  }
  summary.momentCount = moments.length;
  return { moments, summary };
}

function main() {
  const args = parseArgs(process.argv);
  const corpusPath = resolve(String(args.get('corpus') || defaultCorpusPath));
  const manifestPath = resolve(String(args.get('project-manifest') || defaultManifestPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryPath = resolve(String(args.get('summary-out') || defaultSummaryPath));
  const rows = readCorpusRows(corpusPath);
  const manifest = readJson(manifestPath);
  const manifestById = new Map((manifest.projects || []).map((project) => [project.projectId, project]));
  const { moments, summary } = buildMoments(rows, manifestById);
  const content = `${moments.map((moment) => JSON.stringify(moment)).join('\n')}\n`;
  summary.datasetSha256 = sha256(content);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
  writeFileSync(summaryPath, [
    '# Positive Accent Moments V1',
    '',
    `Projects: ${summary.projectCount}`,
    `Train-eligible projects: ${summary.trainEligibleProjectCount}`,
    `Moments: ${summary.momentCount}`,
    `Label kinds: ${JSON.stringify(summary.labelKinds)}`,
    `Positive subtypes: ${JSON.stringify(summary.positiveSubtypes)}`,
    `Hard-other families: ${JSON.stringify(summary.hardOtherFamilies)}`,
    `Dataset SHA-256: ${summary.datasetSha256}`,
    '',
  ].join('\n'), 'utf8');
  console.log(JSON.stringify({ outputPath, summaryPath, ...summary }, null, 2));
}

main();
