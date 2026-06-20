export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

export function eventEndSeconds(startSeconds, duration) {
  return startSeconds + Math.max(0, duration);
}

export function eventAudibleStart(event) {
  return Number(event.startSeconds || 0) + Math.max(0, Number(event.audibleOffsetSeconds || 0));
}

export function buildSFXEvent(options) {
  const { category, file, project, playbackRate } = options;
  const rate = Math.max(0.001, Number(playbackRate) || 1);
  const audibleOffsetSeconds = Math.max(0, Number(file.onsetSeconds || 0) / rate);
  const targetStartSeconds = options.audibleStartSeconds !== undefined
    ? Number(options.audibleStartSeconds) - audibleOffsetSeconds
    : Number(options.startSeconds ?? 0);
  const startSeconds = clamp(targetStartSeconds, 0, Number(project.duration) || 0);
  const startFrame = Math.max(0, Math.round(startSeconds * Math.max(1, Number(project.fps) || 30)));
  const duration = Math.max(0.02, Number(file.duration || 0.3) / rate);
  const gainDb = Number.isFinite(Number(file.gainDb)) ? Number(file.gainDb) : 0;

  return {
    id: options.id ?? globalThis.crypto?.randomUUID?.() ?? `sfx-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    categoryId: String(category.id),
    categoryName: String(category.name),
    fileId: String(file.id),
    fileName: String(file.name),
    filePath: String(file.path),
    color: String(category.color || '#93a8d6'),
    startFrame,
    startSeconds,
    duration,
    baseDuration: duration,
    sourceOffsetSeconds: 0,
    audibleOffsetSeconds,
    playbackRate: rate,
    waveformPeaks: Array.isArray(file.waveformPeaks) ? file.waveformPeaks : undefined,
    gainDb,
    gainLinear: Number(file.gainLinear) > 0 ? Number(file.gainLinear) : dbToLinear(gainDb),
    track: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    snapZoomId: options.snapZoomId ? String(options.snapZoomId) : undefined,
  };
}

export function packEvents(events) {
  const laneEnds = [];
  return [...events]
    .sort((a, b) => Number(a.startSeconds) - Number(b.startSeconds) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .map((event) => {
      const start = Number(event.startSeconds) || 0;
      const end = eventEndSeconds(start, Number(event.duration) || 0);
      let laneIndex = laneEnds.findIndex((laneEnd) => start >= laneEnd - 0.001);
      if (laneIndex < 0) {
        laneIndex = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[laneIndex] = end;
      return { ...event, track: laneIndex + 1 };
    })
    .sort((a, b) => Number(a.startSeconds) - Number(b.startSeconds) || Number(a.track) - Number(b.track) || String(a.fileName || '').localeCompare(String(b.fileName || '')));
}

export function packNewEventsAroundFixedEvents(fixedEvents, newEvents, fps = 30) {
  const epsilon = 0.5 / Math.max(1, Number(fps) || 30);
  const occupiedByTrack = new Map();
  const addOccupied = (event) => {
    const track = Math.max(1, Math.round(Number(event.track) || 1));
    const intervals = occupiedByTrack.get(track) ?? [];
    intervals.push({
      start: Number(event.startSeconds) || 0,
      end: eventEndSeconds(Number(event.startSeconds) || 0, Number(event.duration) || 0),
    });
    occupiedByTrack.set(track, intervals);
  };

  fixedEvents.forEach(addOccupied);
  for (const intervals of occupiedByTrack.values()) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  const packedNewEvents = [...newEvents]
    .sort((a, b) => Number(a.startSeconds) - Number(b.startSeconds) || Number(b.duration) - Number(a.duration) || String(a.id).localeCompare(String(b.id)))
    .map((event) => {
      const start = Number(event.startSeconds) || 0;
      const end = eventEndSeconds(start, Number(event.duration) || 0);
      let track = 1;
      for (;;) {
        const intervals = occupiedByTrack.get(track) ?? [];
        const overlaps = intervals.some((interval) => start < interval.end - epsilon && end > interval.start + epsilon);
        if (!overlaps) {
          intervals.push({ start, end });
          intervals.sort((a, b) => a.start - b.start || a.end - b.end);
          occupiedByTrack.set(track, intervals);
          return { ...event, track };
        }
        track += 1;
      }
    });

  return [...fixedEvents, ...packedNewEvents]
    .sort((a, b) => Number(a.startSeconds) - Number(b.startSeconds) || Number(a.track) - Number(b.track) || String(a.fileName || '').localeCompare(String(b.fileName || '')));
}
