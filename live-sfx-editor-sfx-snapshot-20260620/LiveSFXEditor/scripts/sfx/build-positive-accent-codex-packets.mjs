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
