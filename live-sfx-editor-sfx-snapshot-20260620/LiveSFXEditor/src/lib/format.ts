export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function secondsToClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const msTotal = Math.round(safe * 1000);
  const ms = msTotal % 1000;
  const totalSeconds = Math.floor(msTotal / 1000);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const hour = Math.floor(totalSeconds / 3600);
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function secondsToShortClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalSeconds = Math.floor(safe);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function frameLabel(seconds: number, fps: number): string {
  return `F${Math.round(Math.max(0, seconds) * Math.max(1, fps || 1))}`;
}

export function eventEndSeconds(startSeconds: number, duration: number): number {
  return Math.max(startSeconds, startSeconds + Math.max(0.02, duration || 0.02));
}

export function trackName(track: number): string {
  return `SFX ${track}`;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
