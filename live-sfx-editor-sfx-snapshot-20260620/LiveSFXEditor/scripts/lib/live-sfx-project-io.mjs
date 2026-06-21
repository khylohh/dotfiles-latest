import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp, packEvents } from '../../shared/sfx-event-core.mjs';

export const projectFileExtension = '.sfxinterface';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultOutputDir = join(process.env.HOME || '', 'Desktop', 'Live SFX Projects');
const defaultLibraryRoot = '/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX';
const defaultManualRoot = '/Users/kyle/Desktop/2026 SFX/Categories/Manual SFX';

export function ensureProjectFileExtension(filePath) {
  const trimmed = String(filePath || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith(projectFileExtension) ? trimmed : `${trimmed}${projectFileExtension}`;
}

export function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function normalizeProject(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const fps = Number(candidate.fps) > 0 ? Number(candidate.fps) : 30;
  const duration = Number(candidate.duration) > 0 ? Number(candidate.duration) : 60;
  const masterGainDb = Number(candidate.masterGainDb);
  const events = Array.isArray(candidate.events) ? candidate.events : [];

  return {
    version: 1,
    name: String(candidate.name || 'Live SFX Project'),
    sourceMediaPath: String(candidate.sourceMediaPath || ''),
    outputDir: String(candidate.outputDir || defaultOutputDir),
    libraryRoot: String(candidate.libraryRoot || defaultLibraryRoot),
    manualRoot: String(candidate.manualRoot || defaultManualRoot),
    fps,
    duration,
    sampleRate: Number(candidate.sampleRate) > 0 ? Number(candidate.sampleRate) : 48000,
    zoomXmlPath: String(candidate.zoomXmlPath || ''),
    zoomMarkers: normalizeZoomMarkers(candidate.zoomMarkers, duration),
    captionProjectPath: candidate.captionProjectPath ? String(candidate.captionProjectPath) : '',
    captionProjectId: candidate.captionProjectId ? String(candidate.captionProjectId) : '',
    reactionOffsetFrames: Math.max(0, Math.round(Number(candidate.reactionOffsetFrames ?? 5) || 5)),
    maxPlaybackRate: Math.min(1.4, Math.max(1.1, Number(candidate.maxPlaybackRate ?? 1.4) || 1.4)),
    masterGainDb: Number.isFinite(masterGainDb) ? Math.min(6, Math.max(-24, masterGainDb)) : -12,
    savedPlayheadSeconds: Number.isFinite(candidate.savedPlayheadSeconds)
      ? clamp(Number(candidate.savedPlayheadSeconds), 0, duration)
      : undefined,
    lastExportPath: candidate.lastExportPath ? String(candidate.lastExportPath) : undefined,
    projectFilePath: candidate.projectFilePath ? String(candidate.projectFilePath) : undefined,
    projectLauncherPath: candidate.projectLauncherPath ? String(candidate.projectLauncherPath) : undefined,
    events: packEvents(events.map((event) => normalizeEvent(event))),
    decks: normalizeDecks(candidate.decks),
  };
}

function normalizeEvent(event) {
  const startSeconds = Math.max(0, Number(event?.startSeconds) || 0);
  const duration = Math.max(0.02, Number(event?.duration) || 0.3);
  const baseDuration = Math.max(duration, Number(event?.baseDuration) || duration);
  const sourceOffsetSeconds = Math.max(0, Number(event?.sourceOffsetSeconds) || 0);
  const categoryId = String(event?.categoryId || 'unknown');
  const categoryKey = categoryId.toLowerCase();
  const fixedRate = categoryKey === 'bruh';
  const minPlaybackRate = categoryKey === 'scare' ? 0.5 : 1.1;
  const playbackRate = fixedRate
    ? 1
    : Math.min(1.4, Math.max(minPlaybackRate, Number(event?.playbackRate) || minPlaybackRate));
  return {
    id: typeof event?.id === 'string' ? event.id : `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    categoryId,
    categoryName: String(event?.categoryName || 'Unknown'),
    fileId: String(event?.fileId || ''),
    fileName: String(event?.fileName || 'SFX'),
    filePath: String(event?.filePath || ''),
    color: String(event?.color || '#93a8d6'),
    startFrame: Math.max(0, Math.round(Number(event?.startFrame) || 0)),
    startSeconds,
    duration,
    baseDuration,
    sourceOffsetSeconds,
    audibleOffsetSeconds: Math.max(0, Number(event?.audibleOffsetSeconds) || 0),
    playbackRate,
    waveformPeaks: Array.isArray(event?.waveformPeaks)
      ? event.waveformPeaks.map(Number).filter((value) => Number.isFinite(value) && value >= 0).slice(0, 160)
      : undefined,
    gainDb: Number.isFinite(Number(event?.gainDb)) ? Number(event.gainDb) : 0,
    gainLinear: Number(event?.gainLinear) > 0 ? Number(event.gainLinear) : 1,
    track: Math.max(1, Math.round(Number(event?.track) || 1)),
    createdAt: String(event?.createdAt || new Date().toISOString()),
    snapZoomId: event?.snapZoomId ? String(event.snapZoomId) : undefined,
    automation: event?.automation && typeof event.automation === 'object' && !Array.isArray(event.automation)
      ? event.automation
      : undefined,
  };
}

function normalizeZoomMarkers(raw, projectDuration) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((marker, index) => {
      const startSeconds = Math.max(0, Number(marker?.startSeconds) || 0);
      const endSeconds = Math.max(startSeconds, Number(marker?.endSeconds) || startSeconds);
      return {
        id: String(marker?.id || `zoom-${index + 1}`),
        name: String(marker?.name || `Zoom ${index + 1}`),
        startFrame: Math.max(0, Math.round(Number(marker?.startFrame) || 0)),
        endFrame: Math.max(0, Math.round(Number(marker?.endFrame) || 0)),
        startSeconds: Math.min(projectDuration, startSeconds),
        endSeconds: Math.min(projectDuration, endSeconds),
        durationSeconds: Math.max(0, Number(marker?.durationSeconds) || endSeconds - startSeconds),
      };
    })
    .filter((marker) => marker.endSeconds > marker.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function normalizeDecks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    output[key] = {
      remainingIds: Array.isArray(value?.remainingIds) ? value.remainingIds.map(String) : [],
      usedIds: Array.isArray(value?.usedIds) ? value.usedIds.map(String) : [],
      cycle: Math.max(0, Math.round(Number(value?.cycle) || 0)),
    };
  }
  return output;
}

export function readLiveSFXDescriptor(filePath) {
  const resolvedPath = resolve(filePath);
  const descriptor = readJson(resolvedPath);
  const rawProject = descriptor?.kind === 'LiveSFXInterfaceProject'
    ? descriptor.projectSnapshot
    : descriptor;
  if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) {
    throw new Error(`No LiveSFX project snapshot found in ${resolvedPath}`);
  }
  const project = normalizeProject({
    ...rawProject,
    captionProjectPath: rawProject.captionProjectPath || descriptor?.captionProjectPath || '',
    captionProjectId: rawProject.captionProjectId || descriptor?.captionProjectId || '',
    projectFilePath: rawProject.projectFilePath || (descriptor?.kind === 'LiveSFXInterfaceProject' ? resolvedPath : rawProject.projectFilePath),
  });
  return {
    descriptor,
    project,
    descriptorPath: resolvedPath,
    backingProjectPath: descriptor?.projectPath ? resolve(String(descriptor.projectPath)) : '',
  };
}

export function defaultBackingProjectPath(projectFilePath) {
  const withExtension = ensureProjectFileExtension(projectFilePath);
  const base = basename(withExtension, extname(withExtension));
  return join(dirname(withExtension), `${base}.live_sfx_project.json`);
}

export function writeLiveSFXDescriptorCopy(project, outPath, options = {}) {
  const projectFilePath = ensureProjectFileExtension(resolve(outPath));
  const backingProjectPath = resolve(options.backingProjectPath || defaultBackingProjectPath(projectFilePath));
  const nextProject = normalizeProject({
    ...project,
    projectFilePath,
  });
  atomicWriteJson(backingProjectPath, nextProject);
  const descriptor = {
    kind: 'LiveSFXInterfaceProject',
    version: 1,
    name: nextProject.name || 'Live SFX Project',
    projectPath: backingProjectPath,
    outputDir: nextProject.outputDir || dirname(projectFilePath),
    mediaPath: nextProject.sourceMediaPath || '',
    zoomXmlPath: nextProject.zoomXmlPath || '',
    captionProjectPath: nextProject.captionProjectPath || '',
    captionProjectId: nextProject.captionProjectId || '',
    libraryRoot: nextProject.libraryRoot || defaultLibraryRoot,
    manualRoot: nextProject.manualRoot || defaultManualRoot,
    fps: nextProject.fps || 30,
    duration: nextProject.duration || 60,
    sampleRate: nextProject.sampleRate || 48000,
    savedPlayheadSeconds: nextProject.savedPlayheadSeconds || 0,
    eventCount: Array.isArray(nextProject.events) ? nextProject.events.length : 0,
    zoomCount: Array.isArray(nextProject.zoomMarkers) ? nextProject.zoomMarkers.length : 0,
    projectSnapshot: nextProject,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(projectFilePath, descriptor);
  return { descriptor, project: nextProject, projectFilePath, backingProjectPath };
}

export function assertReloads(filePath) {
  const { project } = readLiveSFXDescriptor(filePath);
  return project;
}

export function projectRootDir() {
  return root;
}
