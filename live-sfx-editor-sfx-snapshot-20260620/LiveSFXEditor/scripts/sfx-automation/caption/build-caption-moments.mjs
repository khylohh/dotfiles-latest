import { createHash } from 'node:crypto';
import { formatCueWindow } from './text-features.mjs';
import { extractCaptionBeatFeatures } from './extract-caption-beat-features.mjs';
import { extractCaptionMomentFeatures } from './extract-caption-moment-features.mjs';

const beatFeatureCache = new WeakMap();

function stableHash(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function median(values) {
  const nums = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

export function flattenTimingOptions(candidates) {
  return (candidates || []).flatMap((candidate) => {
    const triggers = candidate.triggerOptions?.length
      ? candidate.triggerOptions
      : [{
        targetSec: candidate.targetSec,
        anchorType: candidate.features?.anchorType || '',
        source: candidate.features?.anchorType || '',
      }];
    return triggers
      .map((trigger) => {
        const targetSec = finite(trigger.targetSec);
        if (targetSec === null) return null;
        return {
          optionId: `${candidate.id}:${trigger.anchorType || ''}:${targetSec.toFixed(6)}`,
          candidateId: candidate.id,
          targetSec,
          anchorType: trigger.anchorType || '',
          source: trigger.source || '',
          cueIds: candidate.cueIds || [],
          wordIds: candidate.wordIds || [],
          zoomMarkerIds: candidate.zoomMarkerIds || [],
          parentFeatures: {
            cueStartSec: candidate.features?.cueStartSec ?? null,
            cueEndSec: candidate.features?.cueEndSec ?? null,
            nearestZoomStartSec: candidate.features?.nearestZoomStartSec ?? null,
            boundaryStrength: candidateBoundaryStrength(candidate),
            wordTimingAvailable: Boolean(candidate.features?.wordTimingAvailable),
          },
        };
      })
      .filter(Boolean);
  });
}

function candidateBoundaryStrength(candidate) {
  const direct = finite(candidate.features?.boundaryStrength);
  if (direct !== null) return direct;
  const dense = candidate.denseFeatures || cachedBeatFeatures(candidate).dense;
  return finite(dense['anchor.boundary_strength']);
}

function cachedBeatFeatures(candidate) {
  if (!candidate || typeof candidate !== 'object') return { dense: {}, lexical: [] };
  const existing = beatFeatureCache.get(candidate);
  if (existing) return existing;
  const extracted = extractCaptionBeatFeatures(candidate);
  beatFeatureCache.set(candidate, extracted);
  return extracted;
}

export function buildCaptionMoments(project, captionProject, candidates) {
  const groups = new Map();
  for (const candidate of candidates || []) {
    const key = candidate.beatGroupId || candidate.id;
    const values = groups.get(key) || [];
    values.push(candidate);
    groups.set(key, values);
  }

  const moments = [];
  for (const [beatGroupId, group] of groups) {
    const timingOptions = dedupeTimingOptions(flattenTimingOptions(group));
    const center = median(timingOptions.map((option) => option.targetSec));
    const representative = [...group].sort((a, b) => (
      Math.abs(Number(a.targetSec) - center) - Math.abs(Number(b.targetSec) - center)
      || String(a.id).localeCompare(String(b.id))
    ))[0];
    const moment = {
      schemaVersion: 3,
      featureVersion: 3,
      momentId: `caption_moment_${stableHash(`${representative.captionProjectId || ''}\0${beatGroupId}\0${(representative.cueIds || []).join(',')}`)}`,
      beatGroupId,
      kind: 'caption_moment',
      momentSec: center,
      cueIds: sortedUnique(group.flatMap((item) => item.cueIds || [])),
      captionPath: representative.captionPath || '',
      captionProjectId: representative.captionProjectId || '',
      text: representative.text || '',
      captionWindow: representative.captionWindow || '',
      candidates: group,
      timingOptions,
      resolver: representative.resolver || null,
    };
    moment.features = extractCaptionMomentFeatures(moment);
    moments.push(moment);
  }
  return addUnrepresentedZoomMoments(project, captionProject, moments);
}

export function dedupeTimingOptions(options) {
  const byKey = new Map();
  const sorted = [...(options || [])].sort((a, b) => (
    Number(a.targetSec) - Number(b.targetSec)
    || String(a.anchorType || '').localeCompare(String(b.anchorType || ''))
    || String(a.candidateId || '').localeCompare(String(b.candidateId || ''))
    || String(a.optionId || '').localeCompare(String(b.optionId || ''))
  ));
  for (const option of sorted) {
    const target = finite(option.targetSec);
    if (target === null) continue;
    const key = [
      target.toFixed(6),
      option.anchorType || '',
      sortedUnique(option.cueIds || []).join(','),
      sortedUnique(option.zoomMarkerIds || []).join(','),
    ].join('\0');
    if (!byKey.has(key)) byKey.set(key, { ...option, targetSec: target });
  }
  return [...byKey.values()];
}

function addUnrepresentedZoomMoments(project, captionProject, moments) {
  const representedZoomIds = new Set(
    moments.flatMap((moment) => moment.timingOptions || [])
      .flatMap((option) => option.zoomMarkerIds || []),
  );
  const zoomMarkers = Array.isArray(project?.zoomMarkers) ? project.zoomMarkers : [];
  if (!zoomMarkers.length) return moments;
  const cues = Array.isArray(captionProject?.cues) ? captionProject.cues : [];
  const captionPath = moments.find((moment) => moment.captionPath)?.captionPath || captionProject?.descriptorPath || '';
  const captionProjectId = moments.find((moment) => moment.captionProjectId)?.captionProjectId || captionProject?.projectFilePath || captionProject?.descriptorPath || '';
  const output = [...moments];
  for (const marker of zoomMarkers) {
    if (!marker?.id || representedZoomIds.has(marker.id)) continue;
    const start = finite(marker.startSeconds);
    if (start === null) continue;
    const nearestCue = nearestCueForTime(cues, start);
    const cueWindow = cueWindowForTime(cues, start, 2);
    const cueIds = nearestCue?.id ? [nearestCue.id] : [];
    const timingOption = {
      optionId: `zoom:${marker.id}:zoom_onset:${start.toFixed(6)}`,
      candidateId: `zoom:${marker.id}`,
      targetSec: start,
      anchorType: 'zoom_onset',
      source: 'zoom.start',
      cueIds,
      wordIds: [],
      zoomMarkerIds: [marker.id],
      parentFeatures: {
        cueStartSec: nearestCue?.start ?? null,
        cueEndSec: nearestCue?.end ?? null,
        nearestZoomStartSec: start,
        boundaryStrength: 0,
        wordTimingAvailable: false,
      },
    };
    const moment = {
      schemaVersion: 3,
      featureVersion: 3,
      momentId: `caption_moment_${stableHash(`${captionProjectId}\0orphan_zoom\0${marker.id}\0${start}`)}`,
      beatGroupId: `zoom_${marker.id}`,
      kind: 'caption_zoom_moment',
      momentSec: start,
      cueIds,
      captionPath,
      captionProjectId,
      text: nearestCue?.text || '',
      captionWindow: formatCueWindow(cueWindow),
      candidates: [],
      timingOptions: [timingOption],
      resolver: null,
    };
    moment.features = extractCaptionMomentFeatures(moment);
    output.push(moment);
  }
  return output.sort((a, b) => Number(a.momentSec) - Number(b.momentSec) || String(a.momentId).localeCompare(String(b.momentId)));
}

function nearestCueForTime(cues, seconds) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cue of cues) {
    const start = finite(cue.start);
    const end = finite(cue.end);
    if (start === null || end === null) continue;
    const distance = seconds >= start && seconds <= end ? 0 : Math.min(Math.abs(seconds - start), Math.abs(seconds - end));
    if (distance < bestDistance) {
      best = cue;
      bestDistance = distance;
    }
  }
  return best;
}

function cueWindowForTime(cues, seconds, radius) {
  const nearest = nearestCueForTime(cues, seconds);
  if (!nearest) return [];
  const index = Math.max(0, cues.findIndex((cue) => cue.id === nearest.id));
  return cues.slice(Math.max(0, index - radius), Math.min(cues.length, index + radius + 1));
}
