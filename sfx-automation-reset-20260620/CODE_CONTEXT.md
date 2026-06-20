# Code Context

These are the key local implementation files as of the failed clean outer_04 run.

## scripts/sfx/build-positive-accent-codex-packets.mjs

```javascript
#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultMomentsPath = resolve(editorRoot, 'data/sfx-automation-v2/positive-accent-moments.jsonl');
const defaultCorpusPath = resolve(editorRoot, 'data/sfx-automation-v2/visible-caption-corpus.jsonl');
const defaultSplitsPath = resolve(editorRoot, 'validation/outer-splits-v1.json');
const defaultOutRoot = resolve(editorRoot, 'validation/codex-selector-packets');
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

function boolArg(args, key) {
  const value = args.get(key);
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function round(value, places = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.sqrt(a.size * b.size);
}

function assertNoProhibitedProjects(rows, sourceName, projectIdForRow) {
  for (const row of rows) {
    const projectId = projectIdForRow(row);
    if ([lockedHoldoutId, openedBlindCaptionId].includes(projectId)) {
      throw new Error(`Prohibited project appears in ${sourceName}: ${projectId}`);
    }
  }
}

function cueLine(cue, markers = []) {
  const markerText = markers.length ? ` ${markers.map((id) => `<${id}>`).join(' ')}` : '';
  return `[${formatTime(cue.startSec ?? cue.start)} ${cue.speakerKey || ''}] ${String(cue.text || '').trim()}${markerText}`.trim();
}

function formatTime(seconds) {
  const value = safeNumber(seconds);
  const minutes = Math.floor(value / 60);
  const sec = value - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function compactCue(cue) {
  return {
    cueId: cue.id,
    startSec: round(cue.start, 3),
    endSec: round(cue.end, 3),
    speakerKey: cue.speakerKey || '',
    text: String(cue.text || ''),
  };
}

function denseValue(candidate, key, fallback = null) {
  const dense = candidate?.denseFeatures || {};
  return dense[key] === undefined || dense[key] === null ? fallback : dense[key];
}

function anchorRank(candidate) {
  const types = new Set(candidate?.anchorTypes || []);
  const ranks = [];
  if (types.has('final_word_end')) ranks.push(0);
  if (types.has('cue_end_minus_80ms')) ranks.push(1);
  if (types.has('pause_boundary')) ranks.push(2);
  if (types.has('speaker_turn_start')) ranks.push(3);
  if (types.has('internal_pause_word_end')) ranks.push(4);
  if (types.has('zoom_onset')) ranks.push(5);
  if (types.has('cue_start')) ranks.push(6);
  return ranks.length ? Math.min(...ranks) : 9;
}

function canonicalCandidate(moment) {
  const options = moment.candidateOptions || [];
  const target = safeNumber(moment.targetSec);
  return [...options].sort((a, b) => (
    anchorRank(a) - anchorRank(b)
    || Math.abs(safeNumber(a.targetSec) - target) - Math.abs(safeNumber(b.targetSec) - target)
    || String(a.candidateId).localeCompare(String(b.candidateId))
  ))[0] || null;
}

function cueTextForCandidate(cuesById, candidate) {
  const cueIds = candidate?.cueIds || [];
  const text = cueIds
    .map((id) => cuesById.get(id))
    .filter(Boolean)
    .map((cue) => String(cue.text || '').trim())
    .filter(Boolean)
    .join(' ');
  return text.slice(0, 500);
}

function speakerForCandidate(cuesById, candidate) {
  const cue = (candidate?.cueIds || []).map((id) => cuesById.get(id)).find(Boolean);
  return cue?.speakerKey || '';
}

function candidatePacketRow(moment, coreStartSec, cuesById) {
  const candidate = canonicalCandidate(moment);
  if (!candidate) return null;
  const missingZoom = Number(denseValue(candidate, 'zoom.nearest_signed_delta_sec.missing', 1)) > 0;
  return {
    candidateId: candidate.candidateId,
    momentId: moment.momentId,
    beatGroupId: moment.beatGroupId,
    relativeTimeSec: round(safeNumber(candidate.targetSec) - coreStartSec, 3),
    absoluteTimeSec: round(candidate.targetSec, 3),
    targetFrame: Math.round(safeNumber(candidate.targetFrame)),
    cueIds: candidate.cueIds || [],
    speakerKey: speakerForCandidate(cuesById, candidate),
    captionText: cueTextForCandidate(cuesById, candidate),
    anchorTypes: candidate.anchorTypes || [],
    precedingGapSec: round(denseValue(candidate, 'anchor.preceding_gap_sec', null), 3),
    followingGapSec: round(denseValue(candidate, 'anchor.following_gap_sec', null), 3),
    boundaryStrength: round(denseValue(candidate, 'anchor.boundary_strength', null), 3),
    nearestZoomDeltaSec: missingZoom ? null : round(denseValue(candidate, 'zoom.nearest_signed_delta_sec', null), 3),
  };
}

function contextCues(cues, startSec, endSec) {
  return cues
    .filter((cue) => safeNumber(cue.end) >= startSec && safeNumber(cue.start) <= endSec)
    .map(compactCue);
}

function markedCaption(cues, candidates) {
  const markersByCue = new Map();
  for (const candidate of candidates) {
    for (const cueId of candidate.cueIds || []) {
      const existing = markersByCue.get(cueId) || [];
      existing.push(candidate.candidateId);
      markersByCue.set(cueId, existing);
    }
  }
  return cues.map((cue) => cueLine(cue, markersByCue.get(cue.cueId) || [])).join('\n');
}

function splitCore(startSec, endSec, moments, maxCandidates) {
  if (moments.length <= maxCandidates) return [{ startSec, endSec, moments }];
  const sorted = [...moments].sort((a, b) => safeNumber(a.targetSec) - safeNumber(b.targetSec));
  let best = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = safeNumber(sorted[index].targetSec) - safeNumber(sorted[index - 1].targetSec);
    if (!best || gap > best.gap) {
      best = {
        gap,
        leftTime: safeNumber(sorted[index - 1].targetSec),
        rightTime: safeNumber(sorted[index].targetSec),
      };
    }
  }
  const splitAt = best && best.gap > 0
    ? (best.leftTime + best.rightTime) / 2
    : (startSec + endSec) / 2;
  if (splitAt <= startSec + 0.1 || splitAt >= endSec - 0.1) {
    return [{ startSec, endSec, moments: sorted.slice(0, maxCandidates) }];
  }
  const left = sorted.filter((moment) => safeNumber(moment.targetSec) < splitAt);
  const right = sorted.filter((moment) => safeNumber(moment.targetSec) >= splitAt);
  return [
    ...splitCore(startSec, splitAt, left, maxCandidates),
    ...splitCore(splitAt, endSec, right, maxCandidates),
  ];
}

function labelDecision(moment) {
  const label = moment.label || {};
  if (label.kind === 'positive') {
    if (label.subtype === 'success') return { humanDecision: 'success', otherFamily: null };
    return { humanDecision: 'ding', otherFamily: null };
  }
  if (label.kind === 'hard_other') {
    return {
      humanDecision: 'other_sfx',
      otherFamily: (label.manualFamilies || []).find((family) => !positiveFamilies.has(family)) || (label.manualFamilies || [])[0] || 'other',
    };
  }
  if (label.kind === 'clean_negative') return { humanDecision: 'none', otherFamily: null };
  return null;
}

function editorDecision(moment) {
  const decision = labelDecision(moment);
  if (!decision) return 'skip';
  if (decision.humanDecision === 'ding' || decision.humanDecision === 'success') return decision.humanDecision;
  if (decision.humanDecision === 'other_sfx') return 'other_sfx';
  return 'skip';
}

function exampleBucket(moment) {
  const decision = labelDecision(moment);
  if (!decision) return '';
  if (decision.humanDecision === 'ding') return 'ding';
  if (decision.humanDecision === 'success') return 'success';
  if (decision.humanDecision === 'other_sfx') return 'hard_other';
  if (decision.humanDecision === 'none') return 'clean_negative';
  return '';
}

function buildRetrievalPool(moments, trainProjectIds) {
  const trainSet = new Set(trainProjectIds);
  return moments
    .filter((moment) => trainSet.has(moment.projectId))
    .filter((moment) => ['positive', 'hard_other', 'clean_negative'].includes(moment.label?.kind))
    .map((moment) => ({
      moment,
      bucket: exampleBucket(moment),
      tokens: tokenSet(moment.context?.markedText || ''),
    }))
    .filter((item) => item.bucket);
}

function retrieveExamples(pool, segmentTokens) {
  const targets = [
    ['ding', 2],
    ['success', 2],
    ['hard_other', 2],
    ['clean_negative', 2],
  ];
  const selected = [];
  const usedProjects = new Set();
  for (const [bucket, count] of targets) {
    const candidates = pool
      .filter((item) => item.bucket === bucket)
      .map((item) => ({ ...item, score: overlapScore(item.tokens, segmentTokens) }))
      .sort((a, b) => b.score - a.score || a.moment.projectId.localeCompare(b.moment.projectId) || a.moment.momentId.localeCompare(b.moment.momentId));
    const bucketRows = [];
    for (const item of candidates) {
      if (bucketRows.length >= count) break;
      if (usedProjects.has(item.moment.projectId) && candidates.length > count) continue;
      bucketRows.push(item);
      usedProjects.add(item.moment.projectId);
    }
    for (const item of candidates) {
      if (bucketRows.length >= count) break;
      if (!bucketRows.includes(item)) bucketRows.push(item);
    }
    selected.push(...bucketRows);
  }
  return selected.map((item) => {
    const decision = labelDecision(item.moment);
    return {
      exampleId: `${item.moment.projectId}:${item.moment.beatGroupId}`,
      projectId: item.moment.projectId,
      markedCaptionContext: item.moment.context?.markedText || '',
      humanDecision: decision.humanDecision,
      otherFamily: decision.otherFamily,
    };
  });
}

function buildStyleReferencePool({ momentsByProject, corpusByProject, trainProjectIds, options }) {
  const trainSet = new Set(trainProjectIds);
  const pool = [];
  for (const projectId of trainSet) {
    const corpusRow = corpusByProject.get(projectId);
    const projectMoments = momentsByProject.get(projectId) || [];
    if (!corpusRow || !projectMoments.length) continue;
    const duration = safeNumber(corpusRow.project?.durationSec);
    const cues = corpusRow.cues || [];
    const cuesById = new Map(cues.map((cue) => [cue.id, cue]));
    for (let coreStart = 0; coreStart < duration + 0.001; coreStart += options.coreSeconds) {
      const coreEnd = Math.min(duration, coreStart + options.coreSeconds);
      const coreMoments = projectMoments
        .filter((moment) => safeNumber(moment.targetSec) >= coreStart && safeNumber(moment.targetSec) < coreEnd)
        .sort((a, b) => safeNumber(a.targetSec) - safeNumber(b.targetSec));
      if (!coreMoments.length) continue;
      const splitCores = splitCore(coreStart, coreEnd, coreMoments, options.maxCandidatesPerSegment);
      for (let splitIndex = 0; splitIndex < splitCores.length; splitIndex += 1) {
        const split = splitCores[splitIndex];
        const contextStart = Math.max(0, split.startSec - options.contextSeconds);
        const contextEnd = Math.min(duration, split.endSec + options.contextSeconds);
        const cuesInContext = contextCues(cues, contextStart, contextEnd);
        const candidatePairs = split.moments
          .map((moment) => ({ moment, row: candidatePacketRow(moment, split.startSec, cuesById) }))
          .filter((pair) => pair.row);
        if (!candidatePairs.length) continue;
        const referenceCandidates = candidatePairs.map((pair, index) => ({
          ...pair.row,
          candidateId: `ref_${String(index + 1).padStart(2, '0')}`,
          editorDecision: editorDecision(pair.moment),
        }));
        const markedCaptionText = markedCaption(cuesInContext, referenceCandidates);
        const selectedCount = referenceCandidates.filter((candidate) => ['ding', 'success'].includes(candidate.editorDecision)).length;
        const otherSfxCount = referenceCandidates.filter((candidate) => candidate.editorDecision === 'other_sfx').length;
        const referenceSegmentId = sha256(`${projectId}\0${split.startSec}\0${split.endSec}\0${referenceCandidates.map((candidate) => candidate.captionText).join('\0')}`).slice(0, 16);
        pool.push({
          referenceSegmentId,
          projectId,
          coreStartSec: round(split.startSec, 3),
          coreEndSec: round(split.endSec, 3),
          selectedCount,
          otherSfxCount,
          skippedCount: referenceCandidates.length - selectedCount - otherSfxCount,
          markedCaptionText,
          candidates: referenceCandidates.map((candidate) => ({
            refId: candidate.candidateId,
            relativeTimeSec: candidate.relativeTimeSec,
            captionText: candidate.captionText,
            anchorTypes: candidate.anchorTypes,
            nearestZoomDeltaSec: candidate.nearestZoomDeltaSec,
            editorDecision: candidate.editorDecision,
          })),
          tokens: tokenSet(markedCaptionText),
        });
      }
    }
  }
  return pool;
}

function pickStyleSegments(items, maxCount, usedProjects) {
  const picked = [];
  for (const item of items) {
    if (picked.length >= maxCount) break;
    if (usedProjects.has(item.projectId) && items.length > maxCount) continue;
    picked.push(item);
    usedProjects.add(item.projectId);
  }
  for (const item of items) {
    if (picked.length >= maxCount) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

function retrieveStyleReferenceSegments(pool, segmentTokens, maxCount) {
  if (!maxCount || !pool.length) return [];
  const scored = pool
    .map((item) => ({ ...item, score: overlapScore(item.tokens, segmentTokens) }))
    .sort((a, b) => b.score - a.score || Math.abs(a.selectedCount - 1) - Math.abs(b.selectedCount - 1) || a.projectId.localeCompare(b.projectId));
  const usedProjects = new Set();
  const selected = [];
  const positiveSegments = scored.filter((item) => item.selectedCount > 0);
  const sparseSegments = scored.filter((item) => item.selectedCount === 0);
  selected.push(...pickStyleSegments(positiveSegments, Math.max(0, maxCount - 1), usedProjects));
  if (selected.length < maxCount) {
    selected.push(...pickStyleSegments(sparseSegments, 1, usedProjects));
  }
  if (selected.length < maxCount) {
    selected.push(...pickStyleSegments(scored.filter((item) => !selected.includes(item)), maxCount - selected.length, usedProjects));
  }
  return selected.slice(0, maxCount).map((item) => ({
    referenceSegmentId: item.referenceSegmentId,
    selectedCount: item.selectedCount,
    otherSfxCount: item.otherSfxCount,
    skippedCount: item.skippedCount,
    markedCaptionText: item.markedCaptionText,
    candidates: item.candidates,
  }));
}

function buildSegmentsForProject({ fold, projectId, moments, corpusRow, retrievalPool, options }) {
  const duration = safeNumber(corpusRow.project?.durationSec);
  const cues = corpusRow.cues || [];
  const cuesById = new Map(cues.map((cue) => [cue.id, cue]));
  const maxCandidates = options.maxCandidatesPerSegment;
  const coreSeconds = options.coreSeconds;
  const contextSeconds = options.contextSeconds;
  const packets = [];
  for (let coreStart = 0; coreStart < duration + 0.001; coreStart += coreSeconds) {
    const coreEnd = Math.min(duration, coreStart + coreSeconds);
    const coreMoments = moments
      .filter((moment) => safeNumber(moment.targetSec) >= coreStart && safeNumber(moment.targetSec) < coreEnd)
      .sort((a, b) => safeNumber(a.targetSec) - safeNumber(b.targetSec));
    if (!coreMoments.length) continue;
    const splitCores = splitCore(coreStart, coreEnd, coreMoments, maxCandidates);
    for (let splitIndex = 0; splitIndex < splitCores.length; splitIndex += 1) {
      const split = splitCores[splitIndex];
      const contextStart = Math.max(0, split.startSec - contextSeconds);
      const contextEnd = Math.min(duration, split.endSec + contextSeconds);
      const cuesInContext = contextCues(cues, contextStart, contextEnd);
      const packetCandidates = split.moments
        .map((moment) => candidatePacketRow(moment, split.startSec, cuesById))
        .filter(Boolean);
      if (!packetCandidates.length) continue;
      const segmentId = `${projectId}:${fold.foldId}:core_${String(Math.round(split.startSec * 1000)).padStart(9, '0')}_${String(splitIndex + 1).padStart(2, '0')}`;
      const markedCaptionText = markedCaption(cuesInContext, packetCandidates);
      const packetId = sha256(`${fold.foldId}\0${projectId}\0${split.startSec}\0${split.endSec}\0${packetCandidates.map((candidate) => candidate.candidateId).join(',')}`).slice(0, 20);
      const packet = {
        schemaVersion: 1,
        protocol: 'positive-accent-codex-selector-v1',
        packetId,
        foldId: fold.foldId,
        generalizationGroupId: fold.generalizationGroupId,
        projectId,
        segmentId,
        coreStartSec: round(split.startSec, 3),
        coreEndSec: round(split.endSec, 3),
        contextStartSec: round(contextStart, 3),
        contextEndSec: round(contextEnd, 3),
        allowedCandidateIds: packetCandidates.map((candidate) => candidate.candidateId),
        cues: cuesInContext,
        markedCaptionText,
        candidates: packetCandidates,
        retrievalExamples: retrieveExamples(retrievalPool, tokenSet(markedCaptionText)),
        styleReferenceSegments: retrieveStyleReferenceSegments(options.styleReferencePool || [], tokenSet(markedCaptionText), options.styleExamplesPerPacket),
      };
      packets.push(packet);
    }
  }
  return packets;
}

function main() {
  const args = parseArgs(process.argv);
  const momentsPath = resolve(String(args.get('moments') || defaultMomentsPath));
  const corpusPath = resolve(String(args.get('corpus') || defaultCorpusPath));
  const splitsPath = resolve(String(args.get('outer-splits') || defaultSplitsPath));
  const runId = String(args.get('run-id') || `positive-accent-codex-packets-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`);
  const runRoot = resolve(String(args.get('out-root') || defaultOutRoot), runId);
  const packetsDir = join(runRoot, 'packets');
  const clean = boolArg(args, 'clean');
  if (clean && existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });

  const moments = readJsonl(momentsPath);
  const corpusRows = readJsonl(corpusPath);
  const splits = readJson(splitsPath);
  assertNoProhibitedProjects(moments, 'moments', (row) => row.projectId);
  assertNoProhibitedProjects(corpusRows, 'corpus', (row) => row.project?.projectId);

  const corpusByProject = new Map(corpusRows.map((row) => [row.project.projectId, row]));
  const momentsByProject = new Map();
  for (const moment of moments) {
    if (!momentsByProject.has(moment.projectId)) momentsByProject.set(moment.projectId, []);
    momentsByProject.get(moment.projectId).push(moment);
  }

  let folds = splits.folds || [];
  if (args.get('fold')) {
    const requested = new Set(String(args.get('fold')).split(',').map((value) => value.trim()).filter(Boolean));
    folds = folds.filter((fold) => requested.has(fold.foldId));
  }
  if (args.get('project')) {
    const requested = new Set(String(args.get('project')).split(',').map((value) => value.trim()).filter(Boolean));
    folds = folds.map((fold) => ({
      ...fold,
      testProjectIds: fold.testProjectIds.filter((projectId) => requested.has(projectId)),
    })).filter((fold) => fold.testProjectIds.length);
  }
  if (!folds.length) throw new Error('No matching folds to packetize');

  const options = {
    coreSeconds: safeNumber(args.get('core-seconds'), 30),
    contextSeconds: safeNumber(args.get('context-seconds'), 8),
    maxCandidatesPerSegment: Math.max(1, Math.round(safeNumber(args.get('max-candidates'), 32))),
    styleExamplesPerPacket: Math.max(0, Math.round(safeNumber(args.get('style-examples'), 0))),
  };
  const limitPackets = Math.max(0, Math.round(safeNumber(args.get('limit-packets'), 0)));
  mkdirSync(packetsDir, { recursive: true });

  const manifestPackets = [];
  for (const fold of folds) {
    const retrievalPool = buildRetrievalPool(moments, fold.trainProjectIds);
    const styleReferencePool = buildStyleReferencePool({ momentsByProject, corpusByProject, trainProjectIds: fold.trainProjectIds, options });
    const foldOptions = { ...options, styleReferencePool };
    for (const projectId of fold.testProjectIds) {
      const corpusRow = corpusByProject.get(projectId);
      if (!corpusRow) throw new Error(`No corpus row for test project ${projectId}`);
      const projectMoments = momentsByProject.get(projectId) || [];
      const packets = buildSegmentsForProject({ fold, projectId, moments: projectMoments, corpusRow, retrievalPool, options: foldOptions });
      for (const packet of packets) {
        if (limitPackets && manifestPackets.length >= limitPackets) break;
        const fileName = `${packet.foldId}__${packet.projectId}__${packet.packetId}.json`;
        const path = join(packetsDir, fileName);
        writeJson(path, packet);
        manifestPackets.push({
          packetId: packet.packetId,
          path,
          fileName,
          foldId: packet.foldId,
          projectId: packet.projectId,
          segmentId: packet.segmentId,
          coreStartSec: packet.coreStartSec,
          coreEndSec: packet.coreEndSec,
          candidateCount: packet.candidates.length,
        });
      }
      if (limitPackets && manifestPackets.length >= limitPackets) break;
    }
    if (limitPackets && manifestPackets.length >= limitPackets) break;
  }

  const manifest = {
    schemaVersion: 1,
    protocol: 'positive-accent-codex-selector-packet-manifest-v1',
    createdAt: new Date().toISOString(),
    runId,
    runRoot,
    packetsDir,
    momentsPath,
    corpusPath,
    splitsPath,
    lockedFinalHoldout: lockedHoldoutId,
    openedBlindVideoExcluded: true,
    options,
    limited: Boolean(limitPackets),
    requestedLimitPackets: limitPackets || null,
    packetCount: manifestPackets.length,
    packets: manifestPackets,
  };
  writeJson(join(runRoot, 'selector-packet-manifest.json'), manifest);
  console.log(JSON.stringify({
    runRoot,
    packetsDir,
    packetCount: manifestPackets.length,
    limited: manifest.limited,
    samplePacket: manifestPackets[0]?.path || null,
  }, null, 2));
}

main();

```

## scripts/sfx/run-positive-accent-codex-worker.mjs

```javascript
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSchemaPath = resolve(editorRoot, 'config/sfx-automation-v1/positive-accent-selector-schema.json');

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

function boolArg(args, key) {
  const value = args.get(key);
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function compactPacketForPrompt(packet) {
  const styleReferenceSegments = packet.styleReferenceSegments || [];
  return {
    schemaVersion: packet.schemaVersion,
    protocol: packet.protocol,
    packetId: packet.packetId,
    segmentId: packet.segmentId,
    projectId: packet.projectId,
    coreStartSec: packet.coreStartSec,
    coreEndSec: packet.coreEndSec,
    markedCaptionText: packet.markedCaptionText,
    allowedCandidateIds: packet.allowedCandidateIds,
    candidates: (packet.candidates || []).map((candidate) => ({
      candidateId: candidate.candidateId,
      relativeTimeSec: candidate.relativeTimeSec,
      captionText: candidate.captionText,
      speakerKey: candidate.speakerKey,
      anchorTypes: candidate.anchorTypes,
      precedingGapSec: candidate.precedingGapSec,
      followingGapSec: candidate.followingGapSec,
      boundaryStrength: candidate.boundaryStrength,
      nearestZoomDeltaSec: candidate.nearestZoomDeltaSec,
    })),
    styleReferenceSegments,
    retrievalExamples: styleReferenceSegments.length ? [] : packet.retrievalExamples || [],
  };
}

function workerPrompt(packet) {
  const coreDurationSec = Math.max(1, Number(packet.coreEndSec || 0) - Number(packet.coreStartSec || 0));
  const typicalUpper = Math.max(2, Math.ceil(coreDurationSec / 30) * 2);
  return [
    'You are the Command Center positive-accent SFX selector.',
    '',
    'The selector packet is embedded below. Do not run shell commands or read files.',
    '',
    'Your task is to choose which supplied candidate IDs deserve a ding or success sound effect.',
    'You must only choose candidate IDs listed in allowedCandidateIds for this exact packet.',
    'Do not invent timestamps. Do not output confidence. Do not output commentary.',
    'Return only JSON matching the provided output schema.',
    'Default to no selections. A missed good moment is better than adding a bad sound.',
    `This packet core is about ${Math.round(coreDurationSec)} seconds. Most 30-second spans should have 0, 1, or 2 selections; for this packet, more than ${typicalUpper} selections should be rare and only for separate, unmistakable payoffs.`,
    '',
    'Definitions:',
    '- success: completed task, achieved result, solved problem, correct answer, win, finished outcome.',
    '- ding: reveal, positive detail, pleasant discovery, item attribute, specific answer, count/value, selection confirmation.',
    '- If ding and success feel interchangeable, choose ding unless completion/result is clearly the point.',
    '',
    'Reject:',
    '- future plans, attempts, or setup without realized payoff',
    '- generic yeah/cool/good reactions without a specific editorial point',
    '- failure, suspense, mishap, dramatic escalation, or comedy beats',
    '- moments whose meaning requires an unseen visual unless the caption names the actual revealed detail',
    '- generic commands, counting, birthday singing, filler narration, or routine activity',
    '- bare reactions like "oh my god", "what?", "what is this?", "look", or "no way" unless the caption itself gives the revealed object/detail',
    '- positive-sounding lines that are only setup, transition, or encouragement',
    '- multiple accents for the same payoff',
    '',
    'When a payoff spans several candidate IDs, choose only the single best final/payoff candidate.',
    '',
    'Use styleReferenceSegments as the strongest taste guide when present.',
    'They are training-project segments: editorDecision=ding/success means the human placed a positive-accent sound; editorDecision=skip means the human skipped that candidate; editorDecision=other_sfx means another sound family was used and you should not choose ding/success for that pattern.',
    'Notice the density: many plausible positive/reveal/detail captions are skipped. Select current candidates only when they are as strong as the selected reference candidates and clearly stronger than skipped reference candidates.',
    'First decide the few real editorial payoff moments in the current segment, then map each payoff to one allowed candidate ID.',
    '',
    'Use retrievalExamples only as examples from training projects. They are not from this test project.',
    'The packet candidates do not include labels. Judge the current segment from captions, timing, anchors, and examples.',
    '',
    'PACKET_JSON:',
    JSON.stringify(compactPacketForPrompt(packet)),
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const packetPath = args.get('packet') ? resolve(String(args.get('packet'))) : '';
  const outPath = args.get('out') ? resolve(String(args.get('out'))) : '';
  const schemaPath = args.get('schema') ? resolve(String(args.get('schema'))) : defaultSchemaPath;
  const model = args.get('model') ? String(args.get('model')) : 'gpt-5.5';
  const quiet = boolArg(args, 'quiet');
  if (!packetPath) throw new Error('--packet is required');
  if (!outPath) throw new Error('--out is required');
  if (!existsSync(packetPath)) throw new Error(`Packet not found: ${packetPath}`);
  if (!existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  mkdirSync(dirname(outPath), { recursive: true });

  const commandArgs = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--config',
    'service_tier="fast"',
    '--config',
    'model_reasoning_effort="medium"',
    '--sandbox',
    'read-only',
    '--cd',
    editorRoot,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outPath,
    '--color',
    'never',
  ];
  commandArgs.push('--model', model);
  commandArgs.push(workerPrompt(packet));

  const result = spawnSync('codex', commandArgs, {
    cwd: editorRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codex exec failed with exit code ${result.status}`);
  }
  if (!quiet) console.log(JSON.stringify({ output: outPath, packet: packetPath }, null, 2));
}

main();

```

## scripts/sfx/validate-positive-accent-codex-selections.py

```python
#!/usr/bin/env python3
import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
OPENED_BLIND_CAPTION_ID = "blind_caption_only_06_17_26"
POSITIVE_FAMILIES = {"ding", "success"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, default=json_default) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, default=json_default) + "\n")


def json_default(value):
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    return str(value)


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def read_jsonl(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def normalize_family(value):
    family = str(value or "").strip().lower()
    if family.startswith("manual:"):
        family = family.split(":", 1)[1]
    return "".join(ch if ch.isalnum() else "_" for ch in family).strip("_")


def median(values):
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return 0.0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2


def cluster_manual_beats(events):
    normalized = []
    for event in events or []:
        if event.get("isAutomation"):
            continue
        family = normalize_family(event.get("family"))
        time = safe_float(event.get("audibleStartSeconds"), None)
        if family and time is not None:
            normalized.append({"family": family, "time": time})
    normalized.sort(key=lambda item: item["time"])
    beats = []
    for event in normalized:
        if not beats:
            beats.append([event])
            continue
        if abs(event["time"] - median(item["time"] for item in beats[-1])) <= 0.300:
            beats[-1].append(event)
        else:
            beats.append([event])
    return [
        {"time": median(event["time"] for event in beat), "families": sorted({event["family"] for event in beat})}
        for beat in beats
    ]


def manual_positive_counts(corpus_rows, project_ids):
    counts = Counter()
    durations = {}
    requested = set(project_ids)
    for row in corpus_rows:
        project_id = row["project"]["projectId"]
        if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
            raise SystemExit(f"Prohibited project appears in corpus: {project_id}")
        if requested and project_id not in requested:
            continue
        durations[project_id] = safe_float(row["project"].get("durationSec"))
        for beat in cluster_manual_beats(row.get("manualEvents") or []):
            if set(beat["families"]) & POSITIVE_FAMILIES:
                counts[project_id] += 1
    return counts, durations


def load_moment_maps(path):
    by_candidate = {}
    by_moment = {}
    for moment in read_jsonl(path):
        project_id = moment["projectId"]
        if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
            raise SystemExit(f"Prohibited project appears in moments: {project_id}")
        by_moment[moment["momentId"]] = moment
        for candidate in moment.get("candidateOptions") or []:
            candidate_id = candidate.get("candidateId")
            if candidate_id:
                by_candidate[candidate_id] = moment
    return by_candidate, by_moment


def iter_packet_files(packets_root):
    root = Path(packets_root)
    if root.is_file():
        yield root
        return
    packets_dir = root / "packets"
    if packets_dir.exists():
        yield from sorted(packets_dir.glob("*.json"))
    else:
        yield from sorted(root.glob("*.json"))


def selection_path_for_packet(packet_path, selections_root):
    base = Path(packet_path).stem
    root = Path(selections_root)
    candidates = [
        root / f"{base}.selection.json",
        root / f"{base}.json",
        root / f"{base}.out.json",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def caption_context(packet, candidate_id):
    candidate = next((row for row in packet.get("candidates", []) if row.get("candidateId") == candidate_id), {})
    cue_ids = set(candidate.get("cueIds") or [])
    lines = []
    for cue in packet.get("cues") or []:
        prefix = ">" if cue.get("cueId") in cue_ids else " "
        lines.append(f"{prefix} [{cue.get('startSec')}] {cue.get('speakerKey')}: {cue.get('text')}")
    return "\n".join(lines)


def validate_selection_object(selection):
    if not isinstance(selection, dict):
        return "selection is not an object"
    forbidden = {"timestamp", "targetSec", "targetFrame", "time", "confidence", "score"}
    overlap = sorted(forbidden & set(selection))
    if overlap:
        return f"forbidden fields present: {', '.join(overlap)}"
    if not isinstance(selection.get("candidateId"), str) or not selection["candidateId"]:
        return "candidateId missing"
    if selection.get("family") not in {"ding", "success"}:
        return "family must be ding or success"
    if not isinstance(selection.get("momentType"), str) or not selection["momentType"]:
        return "momentType missing"
    return ""


def validate_outputs(packet_files, selections_root, by_candidate):
    valid_rows = []
    invalid_rows = []
    missing_outputs = []
    model_errors = 0
    for packet_path in packet_files:
        packet = read_json(packet_path)
        allowed = set(packet.get("allowedCandidateIds") or [])
        output_path = selection_path_for_packet(packet_path, selections_root)
        if not output_path.exists():
            missing_outputs.append({"packetPath": str(packet_path), "expectedOutputPath": str(output_path)})
            model_errors += 1
            continue
        try:
            output = read_json(output_path)
        except Exception as exc:
            invalid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "reason": f"invalid json: {exc}",
            })
            model_errors += 1
            continue
        if output.get("segmentId") != packet.get("segmentId"):
            invalid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "reason": "segmentId mismatch",
                "expectedSegmentId": packet.get("segmentId"),
                "actualSegmentId": output.get("segmentId"),
            })
            model_errors += 1
            continue
        seen = set()
        for selection in output.get("selections") or []:
            error = validate_selection_object(selection)
            candidate_id = selection.get("candidateId") if isinstance(selection, dict) else ""
            if not error and candidate_id not in allowed:
                error = "candidateId not in packet allow-list"
            if not error and candidate_id in seen:
                error = "duplicate candidateId"
            if error:
                invalid_rows.append({
                    "packetPath": str(packet_path),
                    "outputPath": str(output_path),
                    "segmentId": packet.get("segmentId"),
                    "candidateId": candidate_id,
                    "reason": error,
                })
                continue
            seen.add(candidate_id)
            moment = by_candidate.get(candidate_id)
            if not moment:
                invalid_rows.append({
                    "packetPath": str(packet_path),
                    "outputPath": str(output_path),
                    "segmentId": packet.get("segmentId"),
                    "candidateId": candidate_id,
                    "reason": "candidateId not found in moments map",
                })
                continue
            label = moment.get("label") or {}
            manual_families = label.get("manualFamilies") or []
            selected_family = selection["family"]
            matched = label.get("kind") == "positive"
            exact_family = matched and selected_family in manual_families
            valid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "foldId": packet.get("foldId"),
                "projectId": packet.get("projectId"),
                "segmentId": packet.get("segmentId"),
                "candidateId": candidate_id,
                "momentId": moment.get("momentId"),
                "beatGroupId": moment.get("beatGroupId"),
                "targetSec": safe_float(moment.get("targetSec")),
                "family": selected_family,
                "momentType": selection.get("momentType"),
                "labelKind": label.get("kind"),
                "labelFamilies": manual_families,
                "labelSubtype": label.get("subtype"),
                "combinedMatched": matched,
                "exactFamilyMatched": exact_family,
                "captionContext": caption_context(packet, candidate_id),
            })
    return valid_rows, invalid_rows, missing_outputs, model_errors


def load_ranker_scores(path):
    if not path:
        return {}
    scores = {}
    for row in read_jsonl(path):
        moment_id = row.get("momentId")
        if not moment_id:
            continue
        scores[moment_id] = safe_float(row.get("score"), None)
    return scores


def apply_ranker_filter(rows, ranker_scores, min_score):
    if min_score is None:
        return rows, []
    kept = []
    filtered = []
    for row in rows:
        score = ranker_scores.get(row["momentId"])
        row = {**row, "rankerScore": score}
        if score is not None and score >= min_score:
            kept.append(row)
        else:
            filtered.append(row)
    return kept, filtered


def score_rows(rows, manual_counts, durations):
    manual_total = sum(manual_counts.values())
    generated = len(rows)
    matched = sum(1 for row in rows if row["combinedMatched"])
    exact = sum(1 for row in rows if row["exactFamilyMatched"])
    wrong = generated - matched
    duration_minutes = sum(durations.get(project_id, 0) for project_id in manual_counts) / 60.0
    by_project = defaultdict(list)
    for row in rows:
        by_project[row["projectId"]].append(row)
    project_rows = []
    coverages = []
    positive_net = 0
    for project_id, manual in sorted(manual_counts.items()):
        project_selected = by_project.get(project_id, [])
        project_generated = len(project_selected)
        project_matched = sum(1 for row in project_selected if row["combinedMatched"])
        project_exact = sum(1 for row in project_selected if row["exactFamilyMatched"])
        project_wrong = project_generated - project_matched
        net = project_matched - project_wrong
        coverage = project_matched / manual if manual else None
        if coverage is not None:
            coverages.append(coverage)
        if net > 0:
            positive_net += 1
        project_rows.append({
            "projectId": project_id,
            "manualPositive": manual,
            "generated": project_generated,
            "combinedMatched": project_matched,
            "exactFamilyMatched": project_exact,
            "combinedCoverage": coverage,
            "exactFamilyCoverage": project_exact / manual if manual else None,
            "precision": project_matched / project_generated if project_generated else None,
            "falseAdditions": project_wrong,
            "netSavedEdits": net,
        })
    return {
        "manualPositive": manual_total,
        "generated": generated,
        "combinedMatched": matched,
        "exactFamilyMatched": exact,
        "combinedCoverage": matched / manual_total if manual_total else None,
        "exactFamilyCoverage": exact / manual_total if manual_total else None,
        "precision": matched / generated if generated else None,
        "falseAdditions": wrong,
        "falseAdditionsPerMinute": wrong / duration_minutes if duration_minutes else None,
        "netSavedEdits": matched - wrong,
        "medianProjectCoverage": float(np.median(coverages)) if coverages else None,
        "positiveNetProjectFraction": positive_net / len(project_rows) if project_rows else None,
        "projectRows": project_rows,
    }


def gate_passed(metrics, partial):
    if partial:
        return False
    return (
        (metrics.get("combinedCoverage") or 0) >= 0.20
        and (metrics.get("precision") or 0) >= 0.70
        and (metrics.get("falseAdditionsPerMinute") or float("inf")) <= 0.50
        and (metrics.get("netSavedEdits") or 0) > 0
        and (metrics.get("medianProjectCoverage") or 0) >= 0.15
        and (metrics.get("positiveNetProjectFraction") or 0) >= 0.75
    )


def write_project_csv(path, rows):
    fields = [
        "projectId", "manualPositive", "generated", "combinedMatched", "exactFamilyMatched",
        "combinedCoverage", "exactFamilyCoverage", "precision", "falseAdditions", "netSavedEdits",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_false_audit_csv(path, rows):
    fields = ["projectId", "segmentId", "candidateId", "family", "momentType", "labelKind", "labelFamilies", "targetSec", "captionContext"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            if row["combinedMatched"]:
                continue
            writer.writerow({field: row.get(field) for field in fields})


def markdown_report(report):
    m = report["metrics"]
    partial_line = "This is a partial diagnostic run, not a product score." if report["partialEvaluation"] else "This is a full packet run for the evaluated projects."
    ranker = report.get("rankerFilter") or {}
    ranker_line = (
        f"- Ranker filter: enabled, score >= {ranker.get('scoreMin')}, filtered selections: {ranker.get('filteredSelectionCount')}"
        if ranker.get("enabled")
        else "- Ranker filter: disabled"
    )
    return "\n".join([
        "# Positive Accent Codex Selector Validation",
        "",
        partial_line,
        "",
        ranker_line,
        f"- Product score: {m['combinedMatched']}/{m['manualPositive']} human ding/success placements found",
        f"- Exact family score: {m['exactFamilyMatched']}/{m['manualPositive']}",
        f"- Generated attempts: {m['generated']}",
        f"- Precision: {m['precision']}",
        f"- False additions: {m['falseAdditions']}",
        f"- False additions per minute: {m['falseAdditionsPerMinute']}",
        f"- Net saved edits: {m['netSavedEdits']}",
        f"- Median project coverage: {m['medianProjectCoverage']}",
        f"- Positive net project fraction: {m['positiveNetProjectFraction']}",
        f"- Product materialization gate passed: {report['productMaterializationGatePassed']}",
        "",
    ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets-root", required=True)
    parser.add_argument("--selections-root", required=True)
    parser.add_argument("--moments", default=str(EDITOR_ROOT / "data/sfx-automation-v2/positive-accent-moments.jsonl"))
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--ranker-predictions", default="")
    parser.add_argument("--ranker-score-min", type=float, default=None)
    args = parser.parse_args()

    packet_files = list(iter_packet_files(args.packets_root))
    if not packet_files:
        raise SystemExit(f"No packet files found under {args.packets_root}")
    manifest_path = Path(args.packets_root) / "selector-packet-manifest.json"
    packet_manifest = read_json(manifest_path) if manifest_path.exists() else {}
    by_candidate, _by_moment = load_moment_maps(args.moments)
    valid_rows, invalid_rows, missing_outputs, model_errors = validate_outputs(packet_files, args.selections_root, by_candidate)
    ranker_scores = load_ranker_scores(args.ranker_predictions)
    valid_rows, ranker_filtered_rows = apply_ranker_filter(valid_rows, ranker_scores, args.ranker_score_min)
    project_ids = sorted({read_json(path).get("projectId") for path in packet_files})
    corpus_rows = read_jsonl(args.corpus)
    manual_counts, durations = manual_positive_counts(corpus_rows, project_ids)
    metrics = score_rows(valid_rows, manual_counts, durations)
    partial = bool(packet_manifest.get("limited")) or bool(missing_outputs)
    passed = gate_passed(metrics, partial)

    run_id = args.run_id or datetime.now(timezone.utc).strftime("positive-accent-codex-selector-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "protocol": "positive-accent-codex-selector-validation-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "packetsRoot": str(args.packets_root),
        "selectionsRoot": str(args.selections_root),
        "packetCount": len(packet_files),
        "selectionOutputCount": len(packet_files) - len(missing_outputs),
        "partialEvaluation": partial,
        "lockedFinalHoldout": HOLDOUT_ID,
        "openedBlindVideoExcluded": True,
        "metrics": {key: value for key, value in metrics.items() if key != "projectRows"},
        "modelErrors": model_errors,
        "invalidSelectionCount": len(invalid_rows),
        "missingOutputCount": len(missing_outputs),
        "rankerFilter": {
            "enabled": args.ranker_score_min is not None,
            "predictionsPath": args.ranker_predictions or None,
            "scoreMin": args.ranker_score_min,
            "filteredSelectionCount": len(ranker_filtered_rows),
        },
        "productMaterializationGatePassed": passed,
        "gate": {
            "combinedCoverageMin": 0.20,
            "precisionMin": 0.70,
            "falseAdditionsPerMinuteMax": 0.50,
            "netSavedEditsMinExclusive": 0,
            "medianProjectCoverageMin": 0.15,
            "positiveNetProjectFractionMin": 0.75,
        },
    }
    write_json(run_dir / "positive-accent-codex-selector-validation-report.json", report)
    (run_dir / "positive-accent-codex-selector-validation-report.md").write_text(markdown_report(report), encoding="utf-8")
    write_jsonl(run_dir / "positive-accent-codex-selector-valid-selections.jsonl", valid_rows)
    write_jsonl(run_dir / "positive-accent-codex-selector-ranker-filtered-selections.jsonl", ranker_filtered_rows)
    write_jsonl(run_dir / "positive-accent-codex-selector-invalid-selections.jsonl", invalid_rows)
    write_json(run_dir / "positive-accent-codex-selector-missing-outputs.json", missing_outputs)
    write_project_csv(run_dir / "per-project-positive-accent-codex-selector-metrics.csv", metrics["projectRows"])
    write_false_audit_csv(run_dir / "false-addition-audit.csv", valid_rows)
    print(json.dumps({
        "runDir": str(run_dir),
        "productScore": f"{metrics['combinedMatched']}/{metrics['manualPositive']}",
        "generated": metrics["generated"],
        "precision": metrics["precision"],
        "falseAdditions": metrics["falseAdditions"],
        "netSavedEdits": metrics["netSavedEdits"],
        "medianProjectCoverage": metrics["medianProjectCoverage"],
        "partialEvaluation": partial,
        "productMaterializationGatePassed": passed,
    }, indent=2))


if __name__ == "__main__":
    main()

```

## scripts/sfx/run-positive-accent-codex-project-filter.mjs

```javascript
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSchemaPath = resolve(editorRoot, 'config/sfx-automation-v1/positive-accent-project-filter-schema.json');

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

function boolArg(args, key) {
  const value = args.get(key);
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packetFilesFromRoot(rootPath) {
  const root = resolve(rootPath);
  const manifestPath = join(root, 'selector-packet-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing selector-packet-manifest.json under ${root}`);
  const manifest = readJson(manifestPath);
  return (manifest.packets || []).map((packet) => resolve(packet.path));
}

function selectionPathForPacket(packetPath, selectionsRoot) {
  const base = basename(packetPath, '.json');
  return join(resolve(selectionsRoot), `${base}.selection.json`);
}

function captionContext(packet, candidate) {
  const cueIds = new Set(candidate?.cueIds || []);
  const cueIndexes = (packet.cues || [])
    .map((cue, index) => (cueIds.has(cue.cueId) ? index : -1))
    .filter((index) => index >= 0);
  if (!cueIndexes.length) return String(candidate?.captionText || '');
  const start = Math.max(0, Math.min(...cueIndexes) - 3);
  const end = Math.min((packet.cues || []).length, Math.max(...cueIndexes) + 4);
  return (packet.cues || []).slice(start, end).map((cue) => {
    const marker = cueIds.has(cue.cueId) ? '>' : ' ';
    return `${marker} [${cue.startSec}] ${cue.speakerKey}: ${cue.text}`;
  }).join('\n');
}

function buildProjectPacket(packetFiles, selectionsRoot) {
  const proposals = [];
  const packetByCandidate = new Map();
  let projectId = '';
  for (const packetPath of packetFiles) {
    const packet = readJson(packetPath);
    projectId = projectId || packet.projectId;
    if (packet.projectId !== projectId) throw new Error('Project filter only supports one project per run');
    const outputPath = selectionPathForPacket(packetPath, selectionsRoot);
    if (!existsSync(outputPath)) throw new Error(`Missing selection output: ${outputPath}`);
    const output = readJson(outputPath);
    const candidatesById = new Map((packet.candidates || []).map((candidate) => [candidate.candidateId, candidate]));
    for (const selection of output.selections || []) {
      const candidate = candidatesById.get(selection.candidateId);
      if (!candidate) continue;
      packetByCandidate.set(selection.candidateId, {
        packetPath,
        packet,
        selection,
      });
      proposals.push({
        candidateId: selection.candidateId,
        segmentId: packet.segmentId,
        absoluteTimeSec: candidate.absoluteTimeSec,
        selectedFamily: selection.family,
        momentType: selection.momentType,
        captionText: candidate.captionText,
        anchorTypes: candidate.anchorTypes || [],
        nearestZoomDeltaSec: candidate.nearestZoomDeltaSec,
        context: captionContext(packet, candidate),
      });
    }
  }
  proposals.sort((a, b) => Number(a.absoluteTimeSec) - Number(b.absoluteTimeSec) || a.candidateId.localeCompare(b.candidateId));
  return { projectId, proposals, packetByCandidate };
}

function filterPrompt(projectPacket) {
  return [
    'You are the final Command Center positive-accent SFX selector.',
    '',
    'A first pass over-selected possible ding/success moments for one project. Your job is to keep only the proposals that should become editable SFX Interface items.',
    'Return only JSON matching the schema. Do not output commentary.',
    '',
    'High precision matters more than coverage. Reject any proposal that feels merely positive, cute, explanatory, visual-only, setup, filler, comedy, dramatic, pop, boom, scary, suspense, or another SFX family.',
    'Keep a proposal only when the caption itself names a clear ding/success-style payoff that a human editor would likely accent in this project.',
    'Prefer final/payoff wording over setup wording. If several proposals are the same payoff, keep only the single best one.',
    'Most accepted items should be ding. Use success only for a completed task, solved problem, result, or win.',
    'For a normal project, accepting a small subset is expected; do not try to make every minute have a sound.',
    '',
    'PROJECT_PACKET_JSON:',
    JSON.stringify({
      schemaVersion: 1,
      projectId: projectPacket.projectId,
      proposalCount: projectPacket.proposals.length,
      proposals: projectPacket.proposals,
    }),
  ].join('\n');
}

function writeFilteredSelections(packetFiles, selectionsRoot, projectPacket, filterResult, outRoot) {
  const acceptedByCandidate = new Map();
  for (const item of filterResult.accepted || []) {
    acceptedByCandidate.set(item.candidateId, item);
  }
  const filteredRoot = join(outRoot, 'selections-filtered');
  mkdirSync(filteredRoot, { recursive: true });
  for (const packetPath of packetFiles) {
    const packet = readJson(packetPath);
    const original = readJson(selectionPathForPacket(packetPath, selectionsRoot));
    const selections = [];
    for (const selection of original.selections || []) {
      const accepted = acceptedByCandidate.get(selection.candidateId);
      if (!accepted) continue;
      selections.push({
        candidateId: selection.candidateId,
        family: accepted.family,
        momentType: accepted.momentType,
      });
    }
    writeJson(join(filteredRoot, `${basename(packetPath, '.json')}.selection.json`), {
      schemaVersion: 1,
      segmentId: packet.segmentId,
      selections,
    });
  }
  return filteredRoot;
}

function main() {
  const args = parseArgs(process.argv);
  const packetsRoot = args.get('packets-root') ? resolve(String(args.get('packets-root'))) : '';
  const selectionsRoot = args.get('selections-root') ? resolve(String(args.get('selections-root'))) : '';
  const outRoot = args.get('out-root') ? resolve(String(args.get('out-root'))) : '';
  const schemaPath = args.get('schema') ? resolve(String(args.get('schema'))) : defaultSchemaPath;
  const model = args.get('model') ? String(args.get('model')) : 'gpt-5.5';
  const quiet = boolArg(args, 'quiet');
  if (!packetsRoot) throw new Error('--packets-root is required');
  if (!selectionsRoot) throw new Error('--selections-root is required');
  if (!outRoot) throw new Error('--out-root is required');
  if (!existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);

  const packetFiles = packetFilesFromRoot(packetsRoot);
  const projectPacket = buildProjectPacket(packetFiles, selectionsRoot);
  mkdirSync(outRoot, { recursive: true });
  const rawOutPath = join(outRoot, 'project-filter-output.json');

  const commandArgs = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--config',
    'service_tier="fast"',
    '--config',
    'model_reasoning_effort="medium"',
    '--sandbox',
    'read-only',
    '--cd',
    editorRoot,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    rawOutPath,
    '--color',
    'never',
    '--model',
    model,
    filterPrompt(projectPacket),
  ];
  const result = spawnSync('codex', commandArgs, {
    cwd: editorRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codex exec failed with exit code ${result.status}`);
  const filterResult = readJson(rawOutPath);
  if (filterResult.projectId !== projectPacket.projectId) {
    throw new Error(`Project mismatch: expected ${projectPacket.projectId}, got ${filterResult.projectId}`);
  }
  const allowed = new Set(projectPacket.proposals.map((proposal) => proposal.candidateId));
  for (const item of filterResult.accepted || []) {
    if (!allowed.has(item.candidateId)) throw new Error(`Accepted unknown candidateId: ${item.candidateId}`);
  }
  const filteredRoot = writeFilteredSelections(packetFiles, selectionsRoot, projectPacket, filterResult, outRoot);
  writeJson(join(outRoot, 'project-filter-summary.json'), {
    schemaVersion: 1,
    projectId: projectPacket.projectId,
    proposalCount: projectPacket.proposals.length,
    acceptedCount: (filterResult.accepted || []).length,
    filteredSelectionsRoot: filteredRoot,
    outputPath: rawOutPath,
  });
  console.log(JSON.stringify({
    projectId: projectPacket.projectId,
    proposalCount: projectPacket.proposals.length,
    acceptedCount: (filterResult.accepted || []).length,
    filteredSelectionsRoot: filteredRoot,
    outputPath: rawOutPath,
  }, null, 2));
}

main();

```

## config/sfx-automation-v1/positive-accent-selector-schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "positive_accent_segment_selection",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "segmentId", "selections"],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "segmentId": {
      "type": "string",
      "minLength": 1
    },
    "selections": {
      "type": "array",
      "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["candidateId", "family", "momentType"],
        "properties": {
          "candidateId": {
            "type": "string",
            "minLength": 1
          },
          "family": {
            "type": "string",
            "enum": ["ding", "success"]
          },
          "momentType": {
            "type": "string",
            "enum": [
              "reveal",
              "positive_detail",
              "selection_confirmation",
              "specific_answer",
              "completed_result",
              "correct_result",
              "achievement"
            ]
          }
        }
      }
    }
  }
}

```

## config/sfx-automation-v1/positive-accent-project-filter-schema.json

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "projectId", "accepted"],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "projectId": {
      "type": "string"
    },
    "accepted": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["candidateId", "family", "momentType"],
        "properties": {
          "candidateId": {
            "type": "string"
          },
          "family": {
            "type": "string",
            "enum": ["ding", "success"]
          },
          "momentType": {
            "type": "string"
          }
        }
      }
    }
  }
}

```
