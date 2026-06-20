import { createHash } from 'node:crypto';
import { readCaptionProject } from '../caption/load-caption-project.mjs';
import { resolveCaptionProjectForMedia } from '../caption/find-caption-project.mjs';
import { cueContext, formatCueWindow, textFeatureFlags } from '../caption/text-features.mjs';

function firstHex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function loadCaptionProjectForSFXProject(project, options = {}) {
  const resolver = resolveCaptionProjectForMedia(project, options);
  if (!resolver.captionPath) {
    return { captionPath: '', captionProject: null, resolver };
  }
  return { captionPath: resolver.captionPath, captionProject: readCaptionProject(resolver.captionPath), resolver };
}

export function buildCaptionCandidates(project, options = {}) {
  const { captionPath, captionProject, resolver } = options.captionProject
    ? {
      captionPath: options.captionPath || options.captionProject.descriptorPath || '',
      captionProject: options.captionProject,
      resolver: {
        status: 'ok',
        reason: 'provided_caption_project',
        captionPath: options.captionPath || options.captionProject.descriptorPath || '',
        captionProjectId: firstHex(`${options.captionPath || options.captionProject.descriptorPath || ''}\0${options.captionProject.duration || ''}`),
        resolverConfidence: 100,
        durationDeltaSec: Math.abs((Number(project.duration) || 0) - (Number(options.captionProject.duration) || 0)),
        captionDurationSec: Number(options.captionProject.duration) || 0,
        projectDurationSec: Number(project.duration) || 0,
        candidates: [],
      },
    }
    : loadCaptionProjectForSFXProject(project, options);
  if (!captionProject) {
    return { captionPath: '', captionProject: null, resolver, candidates: [] };
  }

  const mediaIdentity = String(project.sourceMediaPath || captionProject.sourceMediaPath || project.name || 'project');
  const cues = captionProject.cues || [];
  const zoomMarkers = Array.isArray(project.zoomMarkers) ? project.zoomMarkers : [];
  const candidates = cues.map((cue, index) => {
    const previous = cues[index - 1] || null;
    const next = cues[index + 1] || null;
    const previous2 = cues[index - 2] || null;
    const next2 = cues[index + 2] || null;
    const context = cueContext(cues, index, 3);
    const textFeatures = textFeatureFlags(cue.text);
    const zoom = nearestZoomMarker(zoomMarkers, cue);
    const anchor = preferredAnchor(cue, zoom);
    return {
      id: `cand_caption_${firstHex(`${mediaIdentity}\0${cue.id}\0${cue.start}`)}`,
      featureVersion: 1,
      kind: 'caption',
      targetSec: anchor.targetSec,
      targetFrame: Math.max(0, Math.round(Number(anchor.targetSec) * Math.max(1, Number(project.fps) || 30))),
      allowedFamilies: ['none', 'ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch'],
      cueIds: [cue.id],
      wordIds: cue.wordIds || [],
      beatIds: [],
      zoomMarkerIds: zoom?.id ? [zoom.id] : [],
      triggerOptions: triggerOptions(cue, zoom),
      text: cue.text,
      speaker: cue.speaker,
      captionPath,
      captionProjectId: resolver?.captionProjectId || '',
      resolver,
      context,
      captionWindow: formatCueWindow(context),
      features: {
        ...textFeatures,
        cueStartSec: cue.start,
        cueEndSec: cue.end,
        cueDurationSec: Math.max(0, Number(cue.end) - Number(cue.start)),
        cueIndex: index,
        cueCount: cues.length,
        anchorType: anchor.anchorType,
        previousGapSec: previous ? cue.start - previous.end : null,
        nextGapSec: next ? next.start - cue.end : null,
        previousText: previous?.text || '',
        nextText: next?.text || '',
        previous2Text: previous2?.text || '',
        next2Text: next2?.text || '',
        previousSpeaker: previous?.speaker || '',
        nextSpeaker: next?.speaker || '',
        speakerChangedFromPrevious: Boolean(previous && previous.speaker && cue.speaker && previous.speaker !== cue.speaker),
        speakerChangesToNext: Boolean(next && next.speaker && cue.speaker && next.speaker !== cue.speaker),
        hasNearbyZoom: Boolean(zoom),
        nearestZoomId: zoom?.id || '',
        nearestZoomStartSec: zoom?.startSeconds ?? null,
        nearestZoomEndSec: zoom?.endSeconds ?? null,
        nearestZoomStartDeltaSec: zoom ? zoom.startSeconds - cue.start : null,
        nearestZoomDistanceSec: zoom?.distanceSec ?? null,
        cueOverlapsZoom: Boolean(zoom?.overlapsCue),
        projectFraction: Number(project.duration) > 0 ? cue.start / Number(project.duration) : 0,
      },
    };
  });
  return { captionPath, captionProject, resolver, candidates };
}

function nearestZoomMarker(zoomMarkers, cue) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of zoomMarkers) {
    const startSeconds = Number(marker.startSeconds);
    const endSeconds = Number(marker.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) continue;
    const overlapsCue = startSeconds <= cue.end + 0.12 && endSeconds >= cue.start - 0.12;
    const distanceSec = overlapsCue
      ? 0
      : Math.min(Math.abs(startSeconds - cue.start), Math.abs(startSeconds - cue.end), Math.abs(endSeconds - cue.start), Math.abs(endSeconds - cue.end));
    if (distanceSec < bestDistance) {
      best = { ...marker, startSeconds, endSeconds, distanceSec, overlapsCue };
      bestDistance = distanceSec;
    }
  }
  return best && bestDistance <= 2 ? best : null;
}

function preferredAnchor(cue, zoom) {
  if (zoom?.overlapsCue || (zoom && Math.abs(Number(zoom.startSeconds) - Number(cue.start)) <= 0.35)) {
    return { targetSec: Number(zoom.startSeconds), anchorType: 'zoom_onset' };
  }
  return { targetSec: Math.max(0, Number(cue.end) - 0.08), anchorType: 'cue_end_minus_80ms' };
}

function triggerOptions(cue, zoom) {
  const options = [
    { text: cue.text, targetSec: cue.start, source: 'caption-cue-start' },
    { text: cue.text, targetSec: Math.max(0, Number(cue.end) - 0.08), source: 'caption-cue-end-minus-80ms' },
  ];
  if (zoom) options.push({ text: cue.text, targetSec: Number(zoom.startSeconds), source: 'nearby-zoom-onset', zoomMarkerId: zoom.id });
  return options;
}
