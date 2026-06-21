import { createHash } from 'node:crypto';
import { ROUTER_CLASSES } from '../editorial-router-taxonomy.mjs';
import { cueContext, formatCueWindow, textFeatureFlags, tokenize } from './text-features.mjs';

const cueEndOffsetSec = 0.08;
const internalWordPauseSec = 0.24;
const pauseBoundarySec = 0.30;
const anchorClusterSec = 0.12;
const beatGroupSec = 0.45;

const anchorPriority = {
  final_word_end: 1,
  cue_end_minus_80ms: 2,
  pause_boundary: 3,
  speaker_turn_start: 4,
  cue_start: 5,
  zoom_onset: 6,
  internal_pause_word_end: 7,
};

export const captionBeatCandidateConfig = {
  cueEndOffsetSec,
  internalWordPauseSec,
  pauseBoundarySec,
  anchorClusterSec,
  beatGroupSec,
};

function firstHex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function round(value, places = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** places;
  return Math.round(numeric * factor) / factor;
}

export function buildCaptionBeatCandidates(project, captionProject, options = {}) {
  const cues = captionProject?.cues || [];
  const words = captionProject?.words || [];
  const zoomMarkers = Array.isArray(project.zoomMarkers) ? project.zoomMarkers : [];
  const speakerKeys = buildSpeakerKeys(cues);
  const utterances = buildUtterances(cues);
  const utteranceByCueId = new Map();
  for (const utterance of utterances) {
    for (const cueId of utterance.cueIds) utteranceByCueId.set(cueId, utterance);
  }
  const wordsByCueId = buildWordsByCueId(cues, words);
  const rawAnchors = [];

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const previous = cues[index - 1] || null;
    const cueWords = wordsByCueId.get(cue.id) || [];
    rawAnchors.push(anchor('cue_start', cue.start, cue, index, { source: 'cue.start' }));
    rawAnchors.push(anchor('cue_end_minus_80ms', Math.max(0, cue.end - cueEndOffsetSec), cue, index, { source: 'cue.end_minus_80ms' }));
    if (cueWords.length) {
      const finalWord = cueWords[cueWords.length - 1];
      rawAnchors.push(anchor('final_word_end', finalWord.end, cue, index, { wordId: finalWord.id, source: 'final_word.end' }));
      for (let wordIndex = 0; wordIndex < cueWords.length - 1; wordIndex += 1) {
        const word = cueWords[wordIndex];
        const nextWord = cueWords[wordIndex + 1];
        const gap = Number(nextWord.start) - Number(word.end);
        const terminal = /[.?!]$/.test(String(word.text || ''));
        const zoomNear = nearestZoomDelta(zoomMarkers, Number(word.end)) <= 0.18;
        if (terminal || gap >= internalWordPauseSec || zoomNear) {
          rawAnchors.push(anchor('internal_pause_word_end', word.end, cue, index, {
            wordId: word.id,
            wordText: word.text,
            followingWordGapSec: round(gap),
            source: 'internal_word.end',
          }));
        }
      }
    }
    if (previous) {
      const gap = Number(cue.start) - Number(previous.end);
      if (previous.speaker && cue.speaker && previous.speaker !== cue.speaker) {
        rawAnchors.push(anchor('speaker_turn_start', cue.start, cue, index, { previousCueId: previous.id, source: 'speaker_turn.start' }));
      }
      if (gap >= pauseBoundarySec) {
        rawAnchors.push(anchor('pause_boundary', previous.end, previous, index - 1, {
          nextCueId: cue.id,
          followingGapSec: round(gap),
          source: 'pause_boundary.previous_end',
        }));
      }
    }
    for (const zoom of zoomMarkersNearCue(zoomMarkers, cue, 1.0)) {
      rawAnchors.push(anchor('zoom_onset', zoom.startSeconds, cue, index, {
        zoomMarkerId: zoom.id,
        zoomDistanceSec: round(zoom.distanceSec),
        source: 'zoom.start',
      }));
    }
  }

  const clusters = clusterAnchors(rawAnchors);
  const candidates = clusters.map((anchors, index) => buildCandidate({
    anchors,
    index,
    project,
    captionProject,
    cues,
    speakerKeys,
    utteranceByCueId,
    wordsByCueId,
    zoomMarkers,
    captionPath: options.captionPath || captionProject.descriptorPath || '',
    captionProjectId: options.captionProjectId || '',
    resolver: options.resolver || null,
  }));
  assignBeatGroups(candidates);
  return { candidates, utterances, speakerKeys };
}

function buildSpeakerKeys(cues) {
  const keys = new Map();
  for (const cue of cues) {
    const speaker = String(cue.speaker || '');
    if (!speaker || keys.has(speaker)) continue;
    keys.set(speaker, `speaker_${keys.size + 1}`);
  }
  return keys;
}

function buildWordsByCueId(cues, words) {
  const byId = new Map(words.map((word) => [word.id, word]));
  const output = new Map();
  for (const cue of cues) {
    const cueWords = [];
    if (Array.isArray(cue.wordIds) && cue.wordIds.length) {
      for (const wordId of cue.wordIds) {
        const word = byId.get(String(wordId));
        if (word) cueWords.push(word);
      }
    } else {
      cueWords.push(...words.filter((word) => word.start >= cue.start - 0.05 && word.end <= cue.end + 0.05));
    }
    output.set(cue.id, cueWords.sort((a, b) => a.start - b.start || a.end - b.end));
  }
  return output;
}

function buildUtterances(cues) {
  const utterances = [];
  for (const cue of cues) {
    const tokens = tokenize(cue.text);
    const last = utterances[utterances.length - 1];
    const gap = last ? Number(cue.start) - Number(last.end) : Number.POSITIVE_INFINITY;
    const combinedTokens = last ? last.tokenCount + tokens.length : tokens.length;
    const combinedDuration = last ? Number(cue.end) - Number(last.start) : Number(cue.end) - Number(cue.start);
    if (
      last
      && last.speaker === cue.speaker
      && gap <= 0.18
      && combinedDuration <= 4.0
      && combinedTokens <= 24
      && isContinuation(last.text)
    ) {
      last.cueIds.push(cue.id);
      last.end = cue.end;
      last.text = `${last.text} ${cue.text}`.trim();
      last.tokenCount = combinedTokens;
    } else {
      utterances.push({
        id: `utt_${utterances.length + 1}`,
        cueIds: [cue.id],
        speaker: cue.speaker,
        start: cue.start,
        end: cue.end,
        text: cue.text,
        tokenCount: tokens.length,
      });
    }
  }
  return utterances;
}

function isContinuation(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/[.?!]$/.test(value)) return false;
  return true;
}

function anchor(type, seconds, cue, cueIndex, extra = {}) {
  return {
    type,
    seconds: round(seconds),
    cueId: cue.id,
    cueIndex,
    ...extra,
  };
}

function nearestZoomDelta(zoomMarkers, seconds) {
  let best = Number.POSITIVE_INFINITY;
  for (const marker of zoomMarkers) {
    const start = Number(marker.startSeconds);
    if (!Number.isFinite(start)) continue;
    best = Math.min(best, Math.abs(start - seconds));
  }
  return best;
}

function zoomMarkersNearCue(zoomMarkers, cue, seconds) {
  return zoomMarkers
    .map((marker) => {
      const start = Number(marker.startSeconds);
      const end = Number(marker.endSeconds);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const overlapsCue = start <= cue.end && end >= cue.start;
      const distanceSec = overlapsCue ? 0 : Math.min(Math.abs(start - cue.start), Math.abs(start - cue.end));
      return { ...marker, startSeconds: start, endSeconds: end, overlapsCue, distanceSec };
    })
    .filter((marker) => marker && marker.distanceSec <= seconds)
    .sort((a, b) => a.distanceSec - b.distanceSec || a.startSeconds - b.startSeconds);
}

function clusterAnchors(anchors) {
  const sorted = anchors
    .filter((item) => Number.isFinite(Number(item.seconds)))
    .sort((a, b) => Number(a.seconds) - Number(b.seconds) || anchorPriority[a.type] - anchorPriority[b.type]);
  const clusters = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    const canJoin = last
      && Math.abs(Number(item.seconds) - Number(last[0].seconds)) <= anchorClusterSec
      && last.some((existing) => Math.abs(Number(existing.cueIndex) - Number(item.cueIndex)) <= 1);
    if (canJoin) last.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

function buildCandidate(input) {
  const {
    anchors,
    index,
    project,
    captionProject,
    cues,
    speakerKeys,
    utteranceByCueId,
    wordsByCueId,
    zoomMarkers,
    captionPath,
    captionProjectId,
    resolver,
  } = input;
  const canonical = [...anchors].sort((a, b) => anchorPriority[a.type] - anchorPriority[b.type] || Number(a.seconds) - Number(b.seconds))[0];
  const focalCue = cues[canonical.cueIndex] || cues.find((cue) => cue.id === canonical.cueId) || cues[0];
  const focalIndex = cues.findIndex((cue) => cue.id === focalCue.id);
  const context = cueContext(cues, focalIndex, 2);
  const utterance = utteranceByCueId.get(focalCue.id) || null;
  const nearestZoom = nearestZoomMarker(zoomMarkers, Number(canonical.seconds), focalCue);
  const anchorTypes = [...new Set(anchors.map((item) => item.type))].sort();
  const cueIds = [...new Set(anchors.map((item) => item.cueId))].sort();
  const textFeatures = textFeatureFlags(focalCue.text);
  const targetSec = Number(canonical.seconds);
  return {
    id: `cand_caption_beat_${firstHex(`${project.sourceMediaPath || project.name || 'project'}\0${targetSec}\0${cueIds.join(',')}\0${anchorTypes.join(',')}`)}`,
    featureVersion: 2,
    kind: 'caption',
    targetSec,
    targetFrame: Math.max(0, Math.round(targetSec * Math.max(1, Number(project.fps) || 30))),
    allowedFamilies: ROUTER_CLASSES,
    cueIds,
    wordIds: [...new Set(anchors.map((item) => item.wordId).filter(Boolean))],
    beatIds: [],
    beatGroupId: '',
    zoomMarkerIds: nearestZoom?.id ? [nearestZoom.id] : [],
    anchors,
    anchorTypes,
    triggerOptions: anchors.map((item) => ({ targetSec: item.seconds, source: item.source || item.type, anchorType: item.type })),
    text: focalCue.text,
    speaker: speakerKeys.get(focalCue.speaker) || '',
    captionPath,
    captionProjectId,
    resolver,
    context,
    captionWindow: formatCueWindow(context.map((cue) => ({ ...cue, speaker: speakerKeys.get(cue.speaker) || cue.speaker }))),
    utterance: utterance ? {
      id: utterance.id,
      cueIds: utterance.cueIds,
      start: utterance.start,
      end: utterance.end,
      text: utterance.text,
      tokenCount: utterance.tokenCount,
    } : null,
    features: {
      ...textFeatures,
      cueStartSec: focalCue.start,
      cueEndSec: focalCue.end,
      cueDurationSec: Math.max(0, Number(focalCue.end) - Number(focalCue.start)),
      cueIndex: focalIndex,
      cueCount: cues.length,
      anchorType: canonical.type,
      anchorTypes,
      targetSec,
      previousText: cues[focalIndex - 1]?.text || '',
      nextText: cues[focalIndex + 1]?.text || '',
      previous2Text: cues[focalIndex - 2]?.text || '',
      next2Text: cues[focalIndex + 2]?.text || '',
      previousSpeaker: speakerKeys.get(cues[focalIndex - 1]?.speaker) || '',
      nextSpeaker: speakerKeys.get(cues[focalIndex + 1]?.speaker) || '',
      speakerChangedFromPrevious: Boolean(cues[focalIndex - 1] && cues[focalIndex - 1].speaker && focalCue.speaker && cues[focalIndex - 1].speaker !== focalCue.speaker),
      speakerChangesToNext: Boolean(cues[focalIndex + 1] && cues[focalIndex + 1].speaker && focalCue.speaker && cues[focalIndex + 1].speaker !== focalCue.speaker),
      previousGapSec: cues[focalIndex - 1] ? focalCue.start - cues[focalIndex - 1].end : null,
      nextGapSec: cues[focalIndex + 1] ? cues[focalIndex + 1].start - focalCue.end : null,
      hasNearbyZoom: Boolean(nearestZoom),
      nearestZoomId: nearestZoom?.id || '',
      nearestZoomStartSec: nearestZoom?.startSeconds ?? null,
      nearestZoomEndSec: nearestZoom?.endSeconds ?? null,
      nearestZoomStartDeltaSec: nearestZoom ? nearestZoom.startSeconds - targetSec : null,
      nearestZoomDistanceSec: nearestZoom?.distanceSec ?? null,
      cueOverlapsZoom: Boolean(nearestZoom?.overlapsCue),
      wordTimingAvailable: Boolean((wordsByCueId.get(focalCue.id) || []).length),
      wordTimingCoverage: wordTimingCoverage(captionProject),
      projectFraction: Number(project.duration) > 0 ? targetSec / Number(project.duration) : 0,
    },
  };
}

function nearestZoomMarker(zoomMarkers, seconds, cue) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of zoomMarkers) {
    const start = Number(marker.startSeconds);
    const end = Number(marker.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const overlapsCue = start <= cue.end && end >= cue.start;
    const distanceSec = Math.abs(start - seconds);
    if (distanceSec < bestDistance) {
      best = { ...marker, startSeconds: start, endSeconds: end, distanceSec, overlapsCue };
      bestDistance = distanceSec;
    }
  }
  return bestDistance <= 1.5 ? best : null;
}

function wordTimingCoverage(captionProject) {
  const cueCount = captionProject?.cues?.length || 0;
  if (!cueCount) return 0;
  const withWords = captionProject.cues.filter((cue) => Array.isArray(cue.wordIds) && cue.wordIds.length).length;
  return withWords / cueCount;
}

function assignBeatGroups(candidates) {
  let nextGroup = 1;
  for (const candidate of candidates.sort((a, b) => a.targetSec - b.targetSec)) {
    if (candidate.beatGroupId) continue;
    const groupId = `beat_group_${nextGroup++}`;
    candidate.beatGroupId = groupId;
    candidate.beatIds = [groupId];
    const focalCueIds = new Set(candidate.cueIds);
    const utteranceCueIds = new Set(candidate.utterance?.cueIds || []);
    for (const other of candidates) {
      if (other.beatGroupId || other === candidate) continue;
      const close = Math.abs(Number(other.targetSec) - Number(candidate.targetSec)) <= beatGroupSec;
      const sharesCue = other.cueIds.some((cueId) => focalCueIds.has(cueId) || utteranceCueIds.has(cueId));
      const sharesUtterance = (other.utterance?.cueIds || []).some((cueId) => focalCueIds.has(cueId) || utteranceCueIds.has(cueId));
      if (close && (sharesCue || sharesUtterance)) {
        other.beatGroupId = groupId;
        other.beatIds = [groupId];
      }
    }
  }
}
