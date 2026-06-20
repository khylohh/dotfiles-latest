import { createHash } from 'node:crypto';

function firstHex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function buildZoomCandidates(project) {
  const markers = Array.isArray(project.zoomMarkers) ? project.zoomMarkers : [];
  const mediaIdentity = String(project.sourceMediaPath || project.name || 'project');
  return markers.map((marker, index) => {
    const previous = markers[index - 1] ?? null;
    const next = markers[index + 1] ?? null;
    const previousGapSec = previous ? marker.startSeconds - previous.startSeconds : null;
    const nextGapSec = next ? next.startSeconds - marker.startSeconds : null;
    return {
      id: `cand_zoom_${firstHex(`${mediaIdentity}\0${marker.id}\0${marker.startSeconds}`)}`,
      featureVersion: 1,
      kind: 'zoom',
      targetSec: marker.startSeconds,
      targetFrame: Math.max(0, Math.round(Number(marker.startSeconds) * Math.max(1, Number(project.fps) || 30))),
      allowedFamilies: ['none', 'pop'],
      cueIds: [],
      wordIds: [],
      beatIds: [],
      zoomMarkerIds: [marker.id],
      triggerOptions: [{ text: marker.name, targetSec: marker.startSeconds, source: 'zoom-nearest' }],
      features: {
        zoomDurationSec: marker.durationSeconds,
        previousGapSec,
        nextGapSec,
        denseRun: (previousGapSec !== null && previousGapSec <= 3) || (nextGapSec !== null && nextGapSec <= 3),
        adjacentNameEqual: Boolean((previous && previous.name === marker.name) || (next && next.name === marker.name)),
        projectFraction: Number(project.duration) > 0 ? marker.startSeconds / Number(project.duration) : 0,
        zoomIndex: index,
        zoomCount: markers.length,
      },
    };
  });
}
