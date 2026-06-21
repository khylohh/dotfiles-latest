import type { LiveSFXProject, SFXDeckState, SFXEvent } from './types';

const DEFAULT_LIBRARY_ROOT = '/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX';
const DEFAULT_MANUAL_ROOT = '/Users/kyle/Desktop/2026 SFX/Categories/Manual SFX';

export function emptyProject(): LiveSFXProject {
  return normalizeProject({
    version: 1,
    name: 'Live SFX Project',
    sourceMediaPath: '',
    outputDir: '',
    libraryRoot: DEFAULT_LIBRARY_ROOT,
    manualRoot: DEFAULT_MANUAL_ROOT,
    fps: 30,
    duration: 60,
    sampleRate: 48000,
    zoomXmlPath: '',
    zoomMarkers: [],
    captionProjectPath: '',
    captionProjectId: '',
    reactionOffsetFrames: 5,
    maxPlaybackRate: 1.4,
    masterGainDb: -12,
    events: [],
    decks: {},
  });
}

export function normalizeProject(raw: unknown): LiveSFXProject {
  const candidate = raw as Partial<LiveSFXProject> | null;
  const fps = Number(candidate?.fps) > 0 ? Number(candidate?.fps) : 30;
  const duration = Number(candidate?.duration) > 0 ? Number(candidate?.duration) : 60;
  const masterGainDb = Number(candidate?.masterGainDb);
  const events = Array.isArray(candidate?.events) ? candidate.events : [];

  return {
    version: 1,
    name: String(candidate?.name || 'Live SFX Project'),
    sourceMediaPath: String(candidate?.sourceMediaPath || ''),
    outputDir: String(candidate?.outputDir || ''),
    libraryRoot: String(candidate?.libraryRoot || DEFAULT_LIBRARY_ROOT),
    manualRoot: String(candidate?.manualRoot || DEFAULT_MANUAL_ROOT),
    fps,
    duration,
    sampleRate: Number(candidate?.sampleRate) > 0 ? Number(candidate?.sampleRate) : 48000,
    zoomXmlPath: String(candidate?.zoomXmlPath || ''),
    zoomMarkers: normalizeZoomMarkers(candidate?.zoomMarkers, duration),
    captionProjectPath: candidate?.captionProjectPath ? String(candidate.captionProjectPath) : '',
    captionProjectId: candidate?.captionProjectId ? String(candidate.captionProjectId) : '',
    reactionOffsetFrames: Math.max(0, Math.round(Number(candidate?.reactionOffsetFrames ?? 5) || 5)),
    maxPlaybackRate: Math.min(1.4, Math.max(1.1, Number(candidate?.maxPlaybackRate ?? 1.4) || 1.4)),
    masterGainDb: Number.isFinite(masterGainDb) ? Math.min(6, Math.max(-24, masterGainDb)) : -12,
    savedPlayheadSeconds: Number.isFinite(candidate?.savedPlayheadSeconds)
      ? Math.min(duration, Math.max(0, Number(candidate?.savedPlayheadSeconds)))
      : undefined,
    lastExportPath: candidate?.lastExportPath ? String(candidate.lastExportPath) : undefined,
    projectFilePath: candidate?.projectFilePath ? String(candidate.projectFilePath) : undefined,
    projectLauncherPath: candidate?.projectLauncherPath ? String(candidate.projectLauncherPath) : undefined,
    events: events.map(normalizeEvent).sort((a, b) => a.startSeconds - b.startSeconds || a.track - b.track),
    decks: normalizeDecks(candidate?.decks),
  };
}

function normalizeEvent(event: Partial<SFXEvent>): SFXEvent {
  const startSeconds = Math.max(0, Number(event.startSeconds) || 0);
  const duration = Math.max(0.02, Number(event.duration) || 0.3);
  const baseDuration = Math.max(duration, Number(event.baseDuration) || duration);
  const sourceOffsetSeconds = Math.max(0, Number(event.sourceOffsetSeconds) || 0);
  const categoryId = String(event.categoryId || 'unknown');
  const categoryKey = categoryId.toLowerCase();
  const fixedRate = categoryKey === 'bruh';
  const minPlaybackRate = categoryKey === 'scare' ? 0.5 : 1.1;
  const playbackRate = fixedRate
    ? 1
    : Math.min(1.4, Math.max(minPlaybackRate, Number(event.playbackRate) || minPlaybackRate));
  return {
    id: typeof event.id === 'string' ? event.id : crypto.randomUUID(),
    categoryId,
    categoryName: String(event.categoryName || 'Unknown'),
    fileId: String(event.fileId || ''),
    fileName: String(event.fileName || 'SFX'),
    filePath: String(event.filePath || ''),
    color: String(event.color || '#93a8d6'),
    startFrame: Math.max(0, Math.round(Number(event.startFrame) || 0)),
    startSeconds,
    duration,
    baseDuration,
    sourceOffsetSeconds,
    audibleOffsetSeconds: Math.max(0, Number(event.audibleOffsetSeconds) || 0),
    playbackRate,
    waveformPeaks: Array.isArray(event.waveformPeaks)
      ? event.waveformPeaks.map(Number).filter((value) => Number.isFinite(value) && value >= 0).slice(0, 160)
      : undefined,
    gainDb: Number.isFinite(event.gainDb) ? Number(event.gainDb) : 0,
    gainLinear: Number(event.gainLinear) > 0 ? Number(event.gainLinear) : 1,
    track: Math.max(1, Math.round(Number(event.track) || 1)),
    createdAt: String(event.createdAt || new Date().toISOString()),
    snapZoomId: event.snapZoomId ? String(event.snapZoomId) : undefined,
    automation: event.automation && typeof event.automation === 'object' && !Array.isArray(event.automation)
      ? event.automation
      : undefined,
  };
}

function normalizeZoomMarkers(raw: unknown, projectDuration: number) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((marker, index) => {
      const value = marker as {
        id?: unknown;
        name?: unknown;
        startFrame?: unknown;
        endFrame?: unknown;
        startSeconds?: unknown;
        endSeconds?: unknown;
        durationSeconds?: unknown;
      };
      const startSeconds = Math.max(0, Number(value.startSeconds) || 0);
      const endSeconds = Math.max(startSeconds, Number(value.endSeconds) || startSeconds);
      return {
        id: String(value.id || `zoom-${index + 1}`),
        name: String(value.name || `Zoom ${index + 1}`),
        startFrame: Math.max(0, Math.round(Number(value.startFrame) || 0)),
        endFrame: Math.max(0, Math.round(Number(value.endFrame) || 0)),
        startSeconds: Math.min(projectDuration, startSeconds),
        endSeconds: Math.min(projectDuration, endSeconds),
        durationSeconds: Math.max(0, Number(value.durationSeconds) || endSeconds - startSeconds),
      };
    })
    .filter((marker) => marker.endSeconds > marker.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function normalizeDecks(raw: unknown): Record<string, SFXDeckState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const output: Record<string, SFXDeckState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, Partial<SFXDeckState>>)) {
    output[key] = {
      remainingIds: Array.isArray(value?.remainingIds) ? value.remainingIds.map(String) : [],
      usedIds: Array.isArray(value?.usedIds) ? value.usedIds.map(String) : [],
      cycle: Math.max(0, Math.round(Number(value?.cycle) || 0)),
    };
  }
  return output;
}
