import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SFXTimelineCanvas } from './components/SFXTimelineCanvas';
import { clamp, eventEndSeconds, frameLabel, secondsToClock } from './lib/format';
import { emptyProject, normalizeProject } from './lib/project';
import type {
  LibraryResponse,
  LiveSFXProject,
  ManualLibraryResponse,
  ManualSFXFolder,
  SFXCategory,
  SFXDeckState,
  SFXEvent,
  SFXFile,
  ZoomMarker,
} from './lib/types';
import './App.css';

type ProjectUpdater = (project: LiveSFXProject) => LiveSFXProject;
type SelectionMode = 'replace' | 'toggle' | 'range';
type SaveReason = 'manual-save' | 'edit' | 'periodic-backup' | 'pagehide';
type TimelinePlayback = { stop: () => void; timeoutId: number };
type InspectorTab = 'soundboard' | 'manual' | 'automation';
type ExportedSFXFile = {
  kind: 'master' | 'stem';
  id: string;
  label: string;
  fileName: string;
  outputPath: string;
  eventCount?: number;
};
type ExportPackageResponse = {
  outputPath?: string;
  outputDir?: string;
  files?: ExportedSFXFile[];
};
type ExportJobResponse = ExportPackageResponse & {
  jobId?: string;
  status?: 'running' | 'done' | 'failed' | 'cancelled';
  totalFiles?: number;
  error?: string;
  currentFileName?: string;
  currentLabel?: string;
};
type ExportFolderResponse = {
  ok?: boolean;
  folderPath?: string;
  cancelled?: boolean;
  error?: string;
};
type SaveProjectFileResponse = {
  project?: LiveSFXProject;
  projectFilePath?: string;
  cancelled?: boolean;
};
type AutomationPassResponse = {
  ok?: boolean;
  project?: LiveSFXProject;
  stats?: {
    regionZoomCandidates?: number;
    selectedDecisions?: number;
    generatedEvents?: number;
    generatedEventIds?: string[];
    packReleaseId?: string;
  };
  error?: string;
};

const ZOOM_SNAP_FRAMES = 10;
const MIN_PLAYBACK_RATE = 1.1;
const SCARE_MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 1.4;
const EMPTY_MANUAL_LIBRARY: ManualLibraryResponse = { root: '', folders: [] };
const recentRateBuckets = new Map<string, number[]>();

function mediaEndpoint(path: string): string {
  if (!path) return '';
  return `/api/media?path=${encodeURIComponent(path)}`;
}

function randomId(): string {
  return crypto.randomUUID();
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function randomUnit(): number {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const values = new Uint32Array(1);
    cryptoApi.getRandomValues(values);
    return values[0] / 0x100000000;
  }
  return Math.random();
}

function shuffle<T>(items: T[]): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomUnit() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function normalizeDeckForFiles(deck: SFXDeckState | undefined, files: SFXFile[]): SFXDeckState {
  const ids = new Set(files.map((file) => file.id));
  const remainingIds = (deck?.remainingIds ?? []).filter((id) => ids.has(id));
  const usedIds = (deck?.usedIds ?? []).filter((id) => ids.has(id) && !remainingIds.includes(id));
  const accounted = new Set([...remainingIds, ...usedIds]);
  const newIds = files.map((file) => file.id).filter((id) => !accounted.has(id));
  return {
    remainingIds: [...remainingIds, ...shuffle(newIds)],
    usedIds,
    cycle: Math.max(0, Math.round(Number(deck?.cycle) || 0)),
  };
}

function drawDeckFile(category: SFXCategory, deck: SFXDeckState | undefined): { file: SFXFile | null; deck: SFXDeckState; resetCycle: boolean } {
  const files = category.files;
  if (files.length === 0) {
    return { file: null, deck: { remainingIds: [], usedIds: [], cycle: deck?.cycle ?? 0 }, resetCycle: false };
  }
  let nextDeck = normalizeDeckForFiles(deck, files);
  let resetCycle = false;
  if (nextDeck.remainingIds.length === 0) {
    nextDeck = { remainingIds: shuffle(files.map((file) => file.id)), usedIds: [], cycle: nextDeck.cycle + 1 };
    resetCycle = true;
  }
  const drawIndex = Math.floor(randomUnit() * nextDeck.remainingIds.length);
  const fileId = nextDeck.remainingIds[drawIndex];
  const file = files.find((item) => item.id === fileId) ?? null;
  const remainingIds = nextDeck.remainingIds.filter((_, index) => index !== drawIndex);
  const usedIds = file ? [...nextDeck.usedIds, file.id] : nextDeck.usedIds;
  return {
    file,
    deck: { remainingIds, usedIds, cycle: nextDeck.cycle },
    resetCycle,
  };
}

function readyCategory(category: SFXCategory): SFXCategory {
  return {
    ...category,
    files: category.files.filter((file) => file.levelStatus === 'ready'),
  };
}

function categoryReadyCount(category: SFXCategory): number {
  return category.files.filter((file) => file.levelStatus === 'ready').length;
}

function packEvents(events: SFXEvent[]): SFXEvent[] {
  const laneEnds: number[] = [];
  return [...events]
    .sort((a, b) => a.startSeconds - b.startSeconds || a.createdAt.localeCompare(b.createdAt))
    .map((event) => {
      const start = event.startSeconds;
      const end = eventEndSeconds(event.startSeconds, event.duration);
      let laneIndex = laneEnds.findIndex((laneEnd) => start >= laneEnd - 0.001);
      if (laneIndex < 0) {
        laneIndex = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[laneIndex] = end;
      return { ...event, track: laneIndex + 1 };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds || a.track - b.track || a.fileName.localeCompare(b.fileName));
}

function moveEventsInProject(project: LiveSFXProject, eventIds: string[], anchorEventId: string, targetStartSeconds: number): LiveSFXProject {
  const selectedSet = new Set(eventIds);
  const selected = project.events.filter((event) => selectedSet.has(event.id));
  const anchor = selected.find((event) => event.id === anchorEventId);
  if (!anchor || selected.length === 0) return project;
  const minStart = Math.min(...selected.map((event) => event.startSeconds));
  const maxEnd = Math.max(...selected.map((event) => eventEndSeconds(event.startSeconds, event.duration)));
  const rawDelta = targetStartSeconds - anchor.startSeconds;
  const delta = clamp(rawDelta, -minStart, project.duration - maxEnd);
  if (Math.abs(delta) < 0.0005) return project;
  const nextEvents = project.events.map((event) => {
    if (!selectedSet.has(event.id)) return event;
    const startSeconds = clamp(event.startSeconds + delta, 0, project.duration);
    const startFrame = Math.max(0, Math.round(startSeconds * project.fps));
    return { ...event, startSeconds, startFrame };
  });
  return { ...project, events: packEvents(nextEvents) };
}

function resizeEventInProject(project: LiveSFXProject, eventId: string, edge: 'left' | 'right', targetSeconds: number): LiveSFXProject {
  const fps = Math.max(1, project.fps);
  const minDuration = 1 / fps;
  const event = project.events.find((item) => item.id === eventId);
  if (!event) return project;

  const rate = Math.max(0.001, event.playbackRate || 1);
  const sourceOffset = Math.max(0, event.sourceOffsetSeconds || 0);
  const rawOnsetSeconds = sourceOffset + Math.max(0, event.audibleOffsetSeconds || 0) * rate;
  const baseDuration = Math.max(event.baseDuration || event.duration, event.duration);
  const endSeconds = eventEndSeconds(event.startSeconds, event.duration);

  let nextStart = event.startSeconds;
  let nextDuration = event.duration;
  let nextSourceOffset = sourceOffset;

  if (edge === 'right') {
    const maxDuration = Math.max(minDuration, baseDuration - sourceOffset / rate);
    nextDuration = clamp(targetSeconds - event.startSeconds, minDuration, maxDuration);
  } else {
    const maxVisibleDuration = Math.max(minDuration, baseDuration - sourceOffset / rate);
    const earliestStart = Math.max(0, endSeconds - maxVisibleDuration);
    nextStart = clamp(targetSeconds, earliestStart, endSeconds - minDuration);
    const deltaSeconds = nextStart - event.startSeconds;
    nextSourceOffset = Math.max(0, sourceOffset + deltaSeconds * rate);
    nextDuration = Math.max(minDuration, endSeconds - nextStart);
  }

  if (
    Math.abs(nextStart - event.startSeconds) < 0.0005
    && Math.abs(nextDuration - event.duration) < 0.0005
    && Math.abs(nextSourceOffset - sourceOffset) < 0.0005
  ) {
    return project;
  }

  const nextAudibleOffsetSeconds = Math.max(0, rawOnsetSeconds - nextSourceOffset) / rate;
  const nextEvents = project.events.map((item) => item.id === eventId
    ? {
      ...item,
      startSeconds: nextStart,
      startFrame: Math.max(0, Math.round(nextStart * fps)),
      duration: nextDuration,
      sourceOffsetSeconds: nextSourceOffset,
      audibleOffsetSeconds: nextAudibleOffsetSeconds,
    }
    : item);

  return { ...project, events: packEvents(nextEvents) };
}

function splitEventsInProject(project: LiveSFXProject, eventIds: string[], splitSeconds: number): { project: LiveSFXProject; splitIds: string[] } {
  const selectedSet = new Set(eventIds);
  const fps = Math.max(1, project.fps);
  const minDuration = 1 / fps;
  const splitIds: string[] = [];
  const nextEvents: SFXEvent[] = [];

  for (const event of project.events) {
    const endSeconds = eventEndSeconds(event.startSeconds, event.duration);
    if (
      !selectedSet.has(event.id)
      || splitSeconds <= event.startSeconds + minDuration * 0.5
      || splitSeconds >= endSeconds - minDuration * 0.5
    ) {
      nextEvents.push(event);
      continue;
    }

    const leftDuration = Math.max(minDuration, splitSeconds - event.startSeconds);
    const rightDuration = Math.max(minDuration, endSeconds - splitSeconds);
    const rightSourceOffsetSeconds = Math.max(0, event.sourceOffsetSeconds + leftDuration * Math.max(0.001, event.playbackRate));
    const audibleStartSeconds = eventAudibleStart(event);
    const rightId = randomId();
    splitIds.push(rightId);

    nextEvents.push({
      ...event,
      duration: leftDuration,
      snapZoomId: undefined,
    });
    nextEvents.push({
      ...event,
      id: rightId,
      startSeconds: splitSeconds,
      startFrame: Math.max(0, Math.round(splitSeconds * fps)),
      duration: rightDuration,
      sourceOffsetSeconds: rightSourceOffsetSeconds,
      audibleOffsetSeconds: Math.max(0, audibleStartSeconds - splitSeconds),
      createdAt: new Date().toISOString(),
      snapZoomId: undefined,
    });
  }

  if (splitIds.length === 0) return { project, splitIds };
  return { project: { ...project, events: packEvents(nextEvents) }, splitIds };
}

function projectWithSavedPlayhead(project: LiveSFXProject, currentSeconds: number): LiveSFXProject {
  return { ...project, savedPlayheadSeconds: clamp(currentSeconds, 0, project.duration) };
}

function findNearestZoomSnap(zoomMarkers: ZoomMarker[], audibleStartSeconds: number, fps: number): ZoomMarker | null {
  if (zoomMarkers.length === 0) return null;
  const toleranceSeconds = ZOOM_SNAP_FRAMES / Math.max(1, fps);
  let best: ZoomMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of zoomMarkers) {
    const distance = Math.abs(marker.startSeconds - audibleStartSeconds);
    if (distance <= toleranceSeconds && distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

function isScareCategory(categoryId: string): boolean {
  return categoryId.toLowerCase() === 'scare';
}

function isFixedRateCategory(categoryId: string): boolean {
  return categoryId.toLowerCase() === 'bruh';
}

function randomPlaybackRate(categoryId: string, maxPlaybackRate: number): number {
  if (isFixedRateCategory(categoryId)) return 1;
  const maxRate = clamp(maxPlaybackRate || MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  const minRate = isScareCategory(categoryId) ? SCARE_MIN_PLAYBACK_RATE : MIN_PLAYBACK_RATE;
  const categoryKey = categoryId.toLowerCase();
  const recentBuckets = recentRateBuckets.get(categoryKey) ?? [];
  const bucketSpan = Math.max(1, Math.round((maxRate - minRate) * 100));
  const recentLimit = Math.min(12, Math.max(6, Math.floor(bucketSpan * 0.28)));

  let chosenRate = minRate;
  let chosenBucket = Math.round(chosenRate * 100);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shapedRandom = isScareCategory(categoryId)
      ? randomUnit()
      : (randomUnit() + Math.sqrt(randomUnit())) / 2;
    const candidate = minRate + shapedRandom * (maxRate - minRate);
    const candidateBucket = Math.round(candidate * 100);
    chosenRate = candidate;
    chosenBucket = candidateBucket;
    if (!recentBuckets.includes(candidateBucket) || recentBuckets.length >= bucketSpan) break;
  }

  recentRateBuckets.set(categoryKey, [chosenBucket, ...recentBuckets.filter((bucket) => bucket !== chosenBucket)].slice(0, recentLimit));
  return chosenRate;
}

function buildSFXEvent(options: {
  category: SFXCategory;
  file: SFXFile;
  project: LiveSFXProject;
  playbackRate: number;
  startSeconds?: number;
  audibleStartSeconds?: number;
  id?: string;
  createdAt?: string;
  snapZoomId?: string;
}): SFXEvent {
  const { category, file, project, playbackRate } = options;
  const audibleOffsetSeconds = Math.max(0, (file.onsetSeconds || 0) / playbackRate);
  const targetStartSeconds = options.audibleStartSeconds !== undefined
    ? options.audibleStartSeconds - audibleOffsetSeconds
    : options.startSeconds ?? 0;
  const startSeconds = clamp(targetStartSeconds, 0, project.duration);
  const startFrame = Math.max(0, Math.round(startSeconds * project.fps));
  return {
    id: options.id ?? randomId(),
    categoryId: category.id,
    categoryName: category.name,
    fileId: file.id,
    fileName: file.name,
    filePath: file.path,
    color: category.color,
    startFrame,
    startSeconds,
    duration: Math.max(0.02, file.duration / playbackRate),
    baseDuration: Math.max(0.02, file.duration / playbackRate),
    sourceOffsetSeconds: 0,
    audibleOffsetSeconds,
    playbackRate,
    waveformPeaks: file.waveformPeaks,
    gainDb: file.gainDb,
    gainLinear: file.gainLinear,
    track: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    snapZoomId: options.snapZoomId,
  };
}

function parseTimeInput(value: string, fallbackSeconds: number): number {
  const trimmed = value.trim();
  if (!trimmed) return fallbackSeconds;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return fallbackSeconds;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds : fallbackSeconds;
}

function formatRegionTime(seconds: number): string {
  return Math.max(0, seconds).toFixed(3);
}

function hotkeyForSoundboardIndex(index: number): string {
  if (index >= 0 && index <= 8) return String(index + 1);
  if (index === 9) return '0';
  return index === 10 ? '-' : '';
}

function soundboardIndexForHotkey(key: string): number {
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  if (key === '0') return 9;
  return key === '-' ? 10 : -1;
}

function eventAudibleStart(event: SFXEvent): number {
  return event.startSeconds + Math.max(0, event.audibleOffsetSeconds || 0);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    window.setTimeout(resolveWait, ms);
  });
}

function collectManualFolders(folders: ManualSFXFolder[]): ManualSFXFolder[] {
  const output: ManualSFXFolder[] = [];
  const visit = (folder: ManualSFXFolder) => {
    output.push(folder);
    folder.folders.forEach(visit);
  };
  folders.forEach(visit);
  return output;
}

function fileMatchesSearch(file: SFXFile, folder: ManualSFXFolder, query: string): boolean {
  if (!query) return true;
  const haystack = `${file.name} ${folder.name} ${folder.relativePath}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function folderHasSearchMatch(folder: ManualSFXFolder, query: string): boolean {
  if (!query) return true;
  return folder.files.some((file) => fileMatchesSearch(file, folder, query))
    || folder.folders.some((child) => folderHasSearchMatch(child, query));
}

function collectWaveformsFromCategories(categories: SFXCategory[], output: Record<string, number[]>) {
  for (const category of categories) {
    for (const file of category.files) {
      if (file.waveformPeaks?.length) output[file.path] = file.waveformPeaks;
    }
  }
}

function collectWaveformsFromManualFolders(folders: ManualSFXFolder[], output: Record<string, number[]>) {
  for (const folder of folders) {
    for (const file of folder.files) {
      if (file.waveformPeaks?.length) output[file.path] = file.waveformPeaks;
    }
    collectWaveformsFromManualFolders(folder.folders, output);
  }
}

export default function App() {
  const [project, setProject] = useState<LiveSFXProject>(() => emptyProject());
  const [library, setLibrary] = useState<LibraryResponse>({ root: '', categories: [] });
  const [manualLibrary, setManualLibrary] = useState<ManualLibraryResponse>(EMPTY_MANUAL_LIBRARY);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(64);
  const [dirty, setDirty] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [focusPlayheadSignal] = useState(0);
  const [status, setStatus] = useState('Live SFX Board ready.');
  const [exporting, setExporting] = useState(false);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('soundboard');
  const [automationStartDraft, setAutomationStartDraft] = useState('0.000');
  const [automationEndDraft, setAutomationEndDraft] = useState('');
  const [manualSearch, setManualSearch] = useState('');
  const [expandedManualFolders, setExpandedManualFolders] = useState<string[]>([]);
  const projectRef = useRef(project);
  const dirtyRef = useRef(false);
  const currentSecondsRef = useRef(0);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const previewAudiosRef = useRef<HTMLAudioElement[]>([]);
  const timelinePlaybacksRef = useRef<Map<string, TimelinePlayback>>(new Map());
  const lastTimelineSecondsRef = useRef<number | null>(null);
  const playbackSessionRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const undoStackRef = useRef<LiveSFXProject[]>([]);
  const redoStackRef = useRef<LiveSFXProject[]>([]);
  const saveTimerRef = useRef<number | null>(null);
  const timingEditBaselineRef = useRef<LiveSFXProject | null>(null);
  const projectLoadedRef = useRef(false);
  const selectedEventIdRef = useRef<string | null>(null);
  const selectedEventIdsRef = useRef<string[]>([]);
  const editRevisionRef = useRef(0);

  const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(project.sourceMediaPath);
  const selectedCount = selectedEventIds.length || (selectedEventId ? 1 : 0);
  const leveling = library.leveling ?? { ready: 0, total: 0, pending: 0, targetMeanDb: -18 };
  const manualLeveling = manualLibrary.leveling ?? { ready: 0, total: 0, pending: 0, targetMeanDb: -18 };
  const zoomMarkers = project.zoomMarkers;
  const waveformByPath = useMemo(() => {
    const output: Record<string, number[]> = {};
    collectWaveformsFromCategories(library.categories, output);
    collectWaveformsFromManualFolders(manualLibrary.folders, output);
    return output;
  }, [library.categories, manualLibrary.folders]);
  const automationRegion = useMemo(() => {
    const start = clamp(parseTimeInput(automationStartDraft, 0), 0, project.duration);
    const end = clamp(parseTimeInput(automationEndDraft, project.duration), start, project.duration);
    return { start, end };
  }, [automationEndDraft, automationStartDraft, project.duration]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    currentSecondsRef.current = currentSeconds;
  }, [currentSeconds]);

  useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
    selectedEventIdsRef.current = selectedEventIds;
  }, [selectedEventId, selectedEventIds]);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialState() {
      try {
        const [projectResponse, libraryResponse, manualResponse] = await Promise.all([
          fetch('/api/project'),
          fetch('/api/library'),
          fetch('/api/manual-library'),
        ]);
        const nextProject = projectResponse.ok ? normalizeProject(await projectResponse.json()) : emptyProject();
        const nextLibrary = libraryResponse.ok ? (await libraryResponse.json()) as LibraryResponse : { root: '', categories: [] };
        const nextManualLibrary = manualResponse.ok ? (await manualResponse.json()) as ManualLibraryResponse : EMPTY_MANUAL_LIBRARY;
        if (cancelled) return;
        setProject(nextProject);
        projectLoadedRef.current = true;
        setLibrary(nextLibrary);
        setManualLibrary(nextManualLibrary);
        setExpandedManualFolders(collectManualFolders(nextManualLibrary.folders).map((folder) => folder.id).slice(0, 4));
        const savedPlayhead = nextProject.savedPlayheadSeconds ?? 0;
        setCurrentSeconds(clamp(savedPlayhead, 0, nextProject.duration));
        setAutomationStartDraft('0.000');
        setAutomationEndDraft(formatRegionTime(nextProject.duration));
        setStatus(
          nextLibrary.leveling?.pending
            ? `Analyzing SFX library: ${nextLibrary.leveling.ready}/${nextLibrary.leveling.total} ready.`
            : nextProject.sourceMediaPath ? 'Project loaded. Soundboard armed.' : 'Choose a source video or use the launcher with a media path.',
        );
      } catch (error) {
        if (!cancelled) setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    void loadInitialState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!library.leveling || library.leveling.pending <= 0) return;
    const timer = window.setInterval(async () => {
      const response = await fetch('/api/library').catch(() => null);
      if (!response?.ok) return;
      const nextLibrary = (await response.json()) as LibraryResponse;
      setLibrary(nextLibrary);
      if (nextLibrary.leveling?.pending) {
        setStatus(`Analyzing SFX library: ${nextLibrary.leveling.ready}/${nextLibrary.leveling.total} ready.`);
      } else {
        setStatus('SFX library analyzed. Soundboard armed.');
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [library.leveling]);

  useEffect(() => {
    if (!manualLibrary.leveling || manualLibrary.leveling.pending <= 0) return;
    const timer = window.setInterval(async () => {
      const response = await fetch('/api/manual-library').catch(() => null);
      if (!response?.ok) return;
      const nextManualLibrary = (await response.json()) as ManualLibraryResponse;
      setManualLibrary(nextManualLibrary);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [manualLibrary.leveling]);

  const saveProjectSnapshot = useCallback(async (saveReason: SaveReason, options: { createBackup?: boolean } = {}) => {
    if (!projectLoadedRef.current) return false;
    const currentProject = projectWithSavedPlayhead(projectRef.current, currentSecondsRef.current);
    const saveRevision = editRevisionRef.current;
    if (saveReason === 'manual-save' && !currentProject.projectFilePath) {
      const projectFileResponse = await fetch('/api/save-project-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: currentProject, createBackup: Boolean(options.createBackup) }),
      }).catch(() => null);
      if (!projectFileResponse?.ok) {
        const details = projectFileResponse ? await projectFileResponse.text().catch(() => '') : '';
        setStatus(details || 'Project file save was cancelled or failed.');
        return false;
      }
      const payload = await projectFileResponse.json() as SaveProjectFileResponse;
      if (payload.cancelled) {
        setStatus('Project file save cancelled.');
        return false;
      }
      const savedProject = normalizeProject(payload.project ?? { ...currentProject, projectFilePath: payload.projectFilePath });
      setProject(savedProject);
      projectRef.current = savedProject;
      setDirty(false);
      dirtyRef.current = false;
      setStatus(`Project saved. File: ${savedProject.projectFilePath ?? payload.projectFilePath ?? 'created'}.`);
      return true;
    }
    const response = await fetch('/api/save-project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: currentProject,
        saveReason,
        createBackup: Boolean(options.createBackup),
      }),
    }).catch(() => null);
    if (!response?.ok) {
      setStatus('Save bridge is not running. Project state remains live in the editor.');
      return false;
    }
    if (editRevisionRef.current === saveRevision) {
      setDirty(false);
      dirtyRef.current = false;
      setStatus(saveReason === 'manual-save' ? 'Project saved.' : status);
    } else if (saveReason === 'manual-save') {
      setStatus('Project saved. Newer edits are still live.');
    }
    return true;
  }, [status]);

  const scheduleAutosave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveProjectSnapshot('edit', { createBackup: true });
    }, 1200);
  }, [saveProjectSnapshot]);

  const commitProject = useCallback((updater: ProjectUpdater, nextStatus?: string) => {
    setProject((current) => {
      const next = updater(current);
      if (next === current) return current;
      projectRef.current = next;
      undoStackRef.current = [...undoStackRef.current.slice(-79), current];
      redoStackRef.current = [];
      editRevisionRef.current += 1;
      setDirty(true);
      dirtyRef.current = true;
      if (nextStatus) setStatus(nextStatus);
      window.requestAnimationFrame(scheduleAutosave);
      return next;
    });
  }, [scheduleAutosave]);

  useEffect(() => {
    const handlePageHide = () => {
      if (!projectLoadedRef.current || !dirtyRef.current) return;
      const currentProject = projectWithSavedPlayhead(projectRef.current, currentSecondsRef.current);
      const body = JSON.stringify({
        project: currentProject,
        saveReason: 'pagehide',
        createBackup: false,
      });
      navigator.sendBeacon('/api/save-project', new Blob([body], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  const stopTimelinePlaybacks = useCallback(() => {
    playbackSessionRef.current += 1;
    for (const playback of timelinePlaybacksRef.current.values()) {
      window.clearTimeout(playback.timeoutId);
      playback.stop();
    }
    timelinePlaybacksRef.current.clear();
  }, []);

  const masterGainLinear = useCallback((): number => dbToLinear(projectRef.current.masterGainDb), []);

  const playSFXAudio = useCallback(async (
    filePath: string,
    playbackRate: number,
    gainLinear: number,
    sourceOffsetSeconds = 0,
  ): Promise<() => void> => {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor) {
      const context = audioContextRef.current ?? new AudioContextCtor();
      audioContextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      let buffer = audioBufferCacheRef.current.get(filePath);
      if (!buffer) {
        const response = await fetch(mediaEndpoint(filePath));
        const arrayBuffer = await response.arrayBuffer();
        buffer = await context.decodeAudioData(arrayBuffer.slice(0));
        audioBufferCacheRef.current.set(filePath, buffer);
      }
      const sourceOffset = clamp(sourceOffsetSeconds, 0, Math.max(0, buffer.duration - 0.001));
      if (sourceOffset >= buffer.duration - 0.001) return () => {};
      const source = context.createBufferSource();
      const gain = context.createGain();
      const compressor = context.createDynamicsCompressor();
      source.buffer = buffer;
      source.playbackRate.value = playbackRate;
      gain.gain.value = clamp(gainLinear, 0.001, 8);
      compressor.threshold.value = -2;
      compressor.knee.value = 4;
      compressor.ratio.value = 10;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.08;
      source.connect(gain).connect(compressor).connect(context.destination);
      source.start(0, sourceOffset);
      return () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        source.disconnect();
        gain.disconnect();
        compressor.disconnect();
      };
    }

    const audio = new Audio(mediaEndpoint(filePath));
    audio.playbackRate = playbackRate;
    audio.volume = clamp(gainLinear, 0, 1);
    audio.addEventListener('ended', () => {
      previewAudiosRef.current = previewAudiosRef.current.filter((item) => item !== audio);
    });
    previewAudiosRef.current.push(audio);
    audio.currentTime = Math.max(0, sourceOffsetSeconds);
    void audio.play().catch(() => {
      previewAudiosRef.current = previewAudiosRef.current.filter((item) => item !== audio);
    });
    return () => {
      audio.pause();
      previewAudiosRef.current = previewAudiosRef.current.filter((item) => item !== audio);
    };
  }, []);

  const startTimelineEventPlayback = useCallback((event: SFXEvent, atSeconds: number): boolean => {
    const end = eventEndSeconds(event.startSeconds, event.duration);
    if (atSeconds < event.startSeconds - 0.002 || atSeconds >= end - 0.002) return false;

    const existingPlayback = timelinePlaybacksRef.current.get(event.id);
    if (existingPlayback) {
      window.clearTimeout(existingPlayback.timeoutId);
      existingPlayback.stop();
      timelinePlaybacksRef.current.delete(event.id);
    }

    const session = playbackSessionRef.current;
    const elapsedSeconds = Math.max(0, atSeconds - event.startSeconds);
    const sourceOffsetSeconds = Math.max(0, event.sourceOffsetSeconds || 0) + elapsedSeconds * event.playbackRate;
    const remainingSeconds = Math.max(0.02, event.duration - elapsedSeconds);
    const pendingTimeoutId = window.setTimeout(() => {
      timelinePlaybacksRef.current.delete(event.id);
    }, remainingSeconds * 1000 + 3000);

    timelinePlaybacksRef.current.set(event.id, { stop: () => {}, timeoutId: pendingTimeoutId });
    void playSFXAudio(
      event.filePath,
      event.playbackRate,
      event.gainLinear * masterGainLinear(),
      sourceOffsetSeconds,
    ).then((stop) => {
      const pendingPlayback = timelinePlaybacksRef.current.get(event.id);
      if (playbackSessionRef.current !== session || !pendingPlayback) {
        stop();
        return;
      }
      window.clearTimeout(pendingPlayback.timeoutId);
      const timeoutId = window.setTimeout(() => {
        stop();
        timelinePlaybacksRef.current.delete(event.id);
      }, remainingSeconds * 1000 + 120);
      timelinePlaybacksRef.current.set(event.id, { stop, timeoutId });
    }).catch(() => {
      const pendingPlayback = timelinePlaybacksRef.current.get(event.id);
      if (pendingPlayback?.timeoutId === pendingTimeoutId) {
        timelinePlaybacksRef.current.delete(event.id);
      }
    });
    return true;
  }, [masterGainLinear, playSFXAudio]);

  const playTimelineEventsIfRunning = useCallback((events: SFXEvent[]) => {
    const media = mediaRef.current;
    if (!media || media.paused) return;
    const now = clamp(media.currentTime || currentSecondsRef.current, 0, projectRef.current.duration);
    for (const event of events) {
      startTimelineEventPlayback(event, now);
    }
  }, [startTimelineEventPlayback]);

  const triggerTimelineSFX = useCallback((previousSeconds: number, nextSeconds: number, includeActive: boolean) => {
    const current = projectRef.current;
    if (nextSeconds < 0 || current.events.length === 0) return;
    const forward = nextSeconds >= previousSeconds - 0.05;
    const eventsToPlay = current.events.filter((event) => {
      const end = eventEndSeconds(event.startSeconds, event.duration);
      if (includeActive && event.startSeconds <= nextSeconds + 0.002 && end > nextSeconds + 0.002) return true;
      return forward && event.startSeconds > previousSeconds + 0.002 && event.startSeconds <= nextSeconds + 0.018;
    });

    for (const event of eventsToPlay) {
      if (timelinePlaybacksRef.current.has(event.id)) continue;
      startTimelineEventPlayback(event, nextSeconds);
    }
  }, [startTimelineEventPlayback]);

  const attachMedia = useCallback((node: HTMLVideoElement | null) => {
    mediaRef.current = node;
  }, []);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    let animationFrame = 0;

    const syncTime = () => {
      const next = clamp(media.currentTime || 0, 0, projectRef.current.duration);
      const previous = lastTimelineSecondsRef.current;
      if (!media.paused && previous !== null) {
        const jumped = next < previous - 0.05 || next - previous > 1.25;
        if (jumped) {
          stopTimelinePlaybacks();
          lastTimelineSecondsRef.current = next;
          triggerTimelineSFX(next, next, true);
        } else {
          triggerTimelineSFX(previous, next, false);
          lastTimelineSecondsRef.current = next;
        }
      }
      currentSecondsRef.current = next;
      setCurrentSeconds(next);
      if (!media.paused) animationFrame = window.requestAnimationFrame(syncTime);
    };
    const handlePlay = () => {
      setIsPlaying(true);
      stopTimelinePlaybacks();
      const now = clamp(media.currentTime || 0, 0, projectRef.current.duration);
      lastTimelineSecondsRef.current = now;
      triggerTimelineSFX(now, now, true);
      animationFrame = window.requestAnimationFrame(syncTime);
    };
    const handlePause = () => {
      setIsPlaying(false);
      window.cancelAnimationFrame(animationFrame);
      stopTimelinePlaybacks();
      lastTimelineSecondsRef.current = null;
      syncTime();
    };
    const handleTimeUpdate = () => syncTime();
    const handleSeeked = () => {
      const now = clamp(media.currentTime || 0, 0, projectRef.current.duration);
      currentSecondsRef.current = now;
      setCurrentSeconds(now);
      stopTimelinePlaybacks();
      lastTimelineSecondsRef.current = media.paused ? null : now;
      if (!media.paused) triggerTimelineSFX(now, now, true);
    };

    media.addEventListener('play', handlePlay);
    media.addEventListener('pause', handlePause);
    media.addEventListener('timeupdate', handleTimeUpdate);
    media.addEventListener('seeked', handleSeeked);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      stopTimelinePlaybacks();
      media.removeEventListener('play', handlePlay);
      media.removeEventListener('pause', handlePause);
      media.removeEventListener('timeupdate', handleTimeUpdate);
      media.removeEventListener('seeked', handleSeeked);
    };
  }, [project.sourceMediaPath, stopTimelinePlaybacks, triggerTimelineSFX]);

  const seekTo = useCallback((seconds: number) => {
    const target = clamp(seconds, 0, projectRef.current.duration);
    const media = mediaRef.current;
    if (media && Number.isFinite(target)) {
      media.currentTime = target;
    }
    stopTimelinePlaybacks();
    lastTimelineSecondsRef.current = media?.paused ? null : target;
    currentSecondsRef.current = target;
    setCurrentSeconds(target);
  }, [stopTimelinePlaybacks]);

  const togglePlayback = useCallback(() => {
    const media = mediaRef.current;
    if (!media) {
      setStatus('No source video is attached yet.');
      return;
    }
    if (media.paused) {
      void media.play().catch((error: unknown) => {
        setStatus(`Playback failed: ${error instanceof Error ? error.message : 'unknown media error'}`);
      });
    } else {
      media.pause();
    }
  }, []);

  const placeSFX = useCallback((category: SFXCategory) => {
    const current = projectRef.current;
    const activeCategory = readyCategory(category);
    if (category.files.length === 0) {
      setStatus(`${category.name} has no playable files.`);
      return;
    }
    if (activeCategory.files.length === 0) {
      setStatus(`${category.name} is still loading: 0/${category.files.length} ready.`);
      return;
    }
    const refSelectedIds = selectedEventIdsRef.current;
    const refPrimaryId = selectedEventIdRef.current;
    const selectedIds = refSelectedIds.length > 0 ? refSelectedIds : refPrimaryId ? [refPrimaryId] : [];
    const validSelectedIds = selectedIds.filter((id) => current.events.some((event) => event.id === id));
    let deckState = current.decks[category.id];

    if (validSelectedIds.length > 0) {
      const selectedSet = new Set(validSelectedIds);
      const replacementEvents: SFXEvent[] = [];
      let resetCount = 0;

      for (const existingEvent of current.events.filter((event) => selectedSet.has(event.id))) {
        const draw = drawDeckFile(activeCategory, deckState);
        deckState = draw.deck;
        if (draw.resetCycle) resetCount += 1;
        if (!draw.file) {
          setStatus(`${category.name} has no playable files.`);
          return;
        }
        const playbackRate = randomPlaybackRate(category.id, current.maxPlaybackRate);
        replacementEvents.push(buildSFXEvent({
          category: activeCategory,
          file: draw.file,
          project: current,
          playbackRate,
          audibleStartSeconds: eventAudibleStart(existingEvent),
          id: existingEvent.id,
          createdAt: existingEvent.createdAt,
          snapZoomId: existingEvent.snapZoomId,
        }));
      }

      if (replacementEvents.length === 0) {
        setStatus('Select an event on the timeline to replace it.');
        return;
      }

      const replacements = new Map(replacementEvents.map((event) => [event.id, event]));
      commitProject(
        (projectValue) => ({
          ...projectValue,
          decks: {
            ...projectValue.decks,
            [category.id]: deckState,
          },
          events: packEvents(projectValue.events.map((event) => replacements.get(event.id) ?? event)),
        }),
        `Replaced ${replacementEvents.length} selected event${replacementEvents.length === 1 ? '' : 's'} with ${category.name}.${resetCount ? ' Cycle reset.' : ''}`,
      );
      const replacementIds = replacementEvents.map((event) => event.id);
      const primaryReplacementId = replacementIds[0] ?? null;
      selectedEventIdsRef.current = replacementIds;
      selectedEventIdRef.current = primaryReplacementId;
      setSelectedEventId(primaryReplacementId);
      setSelectedEventIds(replacementIds);
      playTimelineEventsIfRunning(replacementEvents);
      return;
    }

    const { file, deck, resetCycle } = drawDeckFile(activeCategory, deckState);
    if (!file) {
      setStatus(`${category.name} has no playable files.`);
      return;
    }
    const playbackRate = randomPlaybackRate(category.id, current.maxPlaybackRate);
    const placementFrame = Math.max(0, Math.round(currentSecondsRef.current * current.fps) - current.reactionOffsetFrames);
    const rawStartSeconds = placementFrame / Math.max(1, current.fps);
    const audibleOffsetSeconds = Math.max(0, (file.onsetSeconds || 0) / playbackRate);
    const rawAudibleStart = rawStartSeconds + audibleOffsetSeconds;
    const snapMarker = findNearestZoomSnap(current.zoomMarkers, rawAudibleStart, current.fps);
    const event = buildSFXEvent({
      category: activeCategory,
      file,
      project: current,
      playbackRate,
      startSeconds: rawStartSeconds,
      audibleStartSeconds: snapMarker?.startSeconds,
      snapZoomId: snapMarker?.id,
    });
    commitProject(
      (projectValue) => ({
        ...projectValue,
        decks: {
          ...projectValue.decks,
          [category.id]: deck,
        },
        events: packEvents([...projectValue.events, event]),
      }),
      `${category.name} placed at ${secondsToClock(event.startSeconds)} (${playbackRate.toFixed(3)}x).${snapMarker ? ` Audible start snapped to zoom ${secondsToClock(snapMarker.startSeconds)}.` : ''}${resetCycle ? ' Cycle reset.' : ''}`,
    );
    playTimelineEventsIfRunning([event]);
  }, [commitProject, playTimelineEventsIfRunning]);

  const placeManualSFX = useCallback((file: SFXFile, folder: ManualSFXFolder) => {
    const current = projectRef.current;
    if (file.levelStatus !== 'ready') {
      setStatus(`Manual SFX is analyzing first: ${manualLeveling.ready}/${manualLeveling.total} ready.`);
      return;
    }
    const category: SFXCategory = {
      id: file.categoryId || `manual:${folder.id}`,
      name: folder.name,
      path: folder.path,
      color: folder.color,
      files: [file],
    };
    const refSelectedIds = selectedEventIdsRef.current;
    const refPrimaryId = selectedEventIdRef.current;
    const selectedIds = refSelectedIds.length > 0 ? refSelectedIds : refPrimaryId ? [refPrimaryId] : [];
    const validSelectedIds = selectedIds.filter((id) => current.events.some((event) => event.id === id));

    if (validSelectedIds.length > 0) {
      const selectedSet = new Set(validSelectedIds);
      const replacementEvents = current.events
        .filter((event) => selectedSet.has(event.id))
        .map((existingEvent) => buildSFXEvent({
          category,
          file,
          project: current,
          playbackRate: randomPlaybackRate(category.id, current.maxPlaybackRate),
          audibleStartSeconds: eventAudibleStart(existingEvent),
          id: existingEvent.id,
          createdAt: existingEvent.createdAt,
          snapZoomId: existingEvent.snapZoomId,
        }));
      const replacements = new Map(replacementEvents.map((event) => [event.id, event]));
      commitProject(
        (projectValue) => ({
          ...projectValue,
          events: packEvents(projectValue.events.map((event) => replacements.get(event.id) ?? event)),
        }),
        `Replaced ${replacementEvents.length} selected event${replacementEvents.length === 1 ? '' : 's'} with ${file.name}.`,
      );
      const replacementIds = replacementEvents.map((event) => event.id);
      const primaryReplacementId = replacementIds[0] ?? null;
      selectedEventIdsRef.current = replacementIds;
      selectedEventIdRef.current = primaryReplacementId;
      setSelectedEventId(primaryReplacementId);
      setSelectedEventIds(replacementIds);
      playTimelineEventsIfRunning(replacementEvents);
      return;
    }

    const playbackRate = randomPlaybackRate(category.id, current.maxPlaybackRate);
    const placementFrame = Math.max(0, Math.round(currentSecondsRef.current * current.fps) - current.reactionOffsetFrames);
    const rawStartSeconds = placementFrame / Math.max(1, current.fps);
    const audibleOffsetSeconds = Math.max(0, (file.onsetSeconds || 0) / playbackRate);
    const rawAudibleStart = rawStartSeconds + audibleOffsetSeconds;
    const snapMarker = findNearestZoomSnap(current.zoomMarkers, rawAudibleStart, current.fps);
    const event = buildSFXEvent({
      category,
      file,
      project: current,
      playbackRate,
      startSeconds: rawStartSeconds,
      audibleStartSeconds: snapMarker?.startSeconds,
      snapZoomId: snapMarker?.id,
    });
    commitProject(
      (projectValue) => ({
        ...projectValue,
        events: packEvents([...projectValue.events, event]),
      }),
      `${file.name} placed at ${secondsToClock(event.startSeconds)} (${playbackRate.toFixed(3)}x).${snapMarker ? ` Audible start snapped to zoom ${secondsToClock(snapMarker.startSeconds)}.` : ''}`,
    );
    playTimelineEventsIfRunning([event]);
  }, [commitProject, manualLeveling.ready, manualLeveling.total, playTimelineEventsIfRunning]);

  const applySFXAutomationPass = useCallback(async () => {
    if (automationRunning) return;
    const current = projectRef.current;
    if (current.zoomMarkers.length === 0) {
      setStatus('No zoom moments loaded.');
      return;
    }

    setAutomationRunning(true);
    setStatus(`Generating SFX pass for ${secondsToClock(automationRegion.start)} to ${secondsToClock(automationRegion.end)}...`);
    try {
      const response = await fetch('/api/sfx-automation-v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: projectWithSavedPlayhead(current, currentSecondsRef.current),
          regionStart: automationRegion.start,
          regionEnd: automationRegion.end,
          createBackup: true,
          scorer: 'local',
          seed: 'sfx-v1',
        }),
      }).catch(() => null);
      if (!response?.ok) {
        const details = response ? await response.text().catch(() => '') : '';
        throw new Error(details || 'SFX automation bridge is not running.');
      }
      const payload = await response.json() as AutomationPassResponse;
      if (payload.error) throw new Error(payload.error);
      if (!payload.project || !payload.stats) throw new Error('SFX automation did not return a project.');

      const generatedCount = payload.stats.generatedEvents ?? 0;
      const scannedCount = payload.stats.regionZoomCandidates ?? 0;
      if (generatedCount <= 0) {
        setStatus(`SFX pass found no new high-confidence moments in this region (${scannedCount} zooms scanned).`);
        return;
      }

      const nextProject = normalizeProject(payload.project);
      const generatedIds = (payload.stats.generatedEventIds ?? []).filter((id) => (
        nextProject.events.some((event) => event.id === id)
      ));
      commitProject(
        () => nextProject,
        `SFX pass placed ${generatedCount} event${generatedCount === 1 ? '' : 's'} from ${scannedCount} zooms.`,
      );
      selectedEventIdsRef.current = generatedIds;
      selectedEventIdRef.current = generatedIds[0] ?? null;
      setSelectedEventIds(generatedIds);
      setSelectedEventId(generatedIds[0] ?? null);
    } catch (error) {
      setStatus(`SFX pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAutomationRunning(false);
    }
  }, [automationRegion.end, automationRegion.start, automationRunning, commitProject]);

  const applySelection = useCallback((ids: string[], primaryId: string | null = null) => {
    const validIds = ids.filter((id) => projectRef.current.events.some((event) => event.id === id));
    const nextPrimaryId = primaryId && validIds.includes(primaryId) ? primaryId : validIds[0] ?? null;
    selectedEventIdsRef.current = validIds;
    selectedEventIdRef.current = nextPrimaryId;
    setSelectedEventIds(validIds);
    setSelectedEventId(nextPrimaryId);
  }, []);

  const selectEvent = useCallback((id: string, mode: SelectionMode = 'replace') => {
    setSelectedEventIds((current) => {
      if (mode === 'toggle') {
        const exists = current.includes(id);
        const next = exists ? current.filter((item) => item !== id) : [...current, id];
        const primaryId = next[0] ?? null;
        selectedEventIdsRef.current = next;
        selectedEventIdRef.current = primaryId;
        setSelectedEventId(primaryId);
        return next;
      }
      if (mode === 'range') {
        const anchorId = selectedEventId ?? current[0];
        const anchorIndex = projectRef.current.events.findIndex((event) => event.id === anchorId);
        const targetIndex = projectRef.current.events.findIndex((event) => event.id === id);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          const next = projectRef.current.events.slice(start, end + 1).map((event) => event.id);
          selectedEventIdsRef.current = next;
          selectedEventIdRef.current = id;
          setSelectedEventId(id);
          return next;
        }
      }
      selectedEventIdsRef.current = [id];
      selectedEventIdRef.current = id;
      setSelectedEventId(id);
      return [id];
    });
  }, [selectedEventId]);

  const selectEvents = useCallback((ids: string[], primaryId: string | null = null, mode: 'replace' | 'toggle' = 'replace') => {
    const validIds = ids.filter((id) => projectRef.current.events.some((event) => event.id === id));
    if (mode === 'toggle') {
      setSelectedEventIds((current) => {
        const next = new Set(current);
        for (const id of validIds) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        const output = [...next];
        const nextPrimaryId = primaryId && output.includes(primaryId) ? primaryId : output[0] ?? null;
        selectedEventIdsRef.current = output;
        selectedEventIdRef.current = nextPrimaryId;
        setSelectedEventId(nextPrimaryId);
        return output;
      });
      return;
    }
    applySelection(validIds, primaryId);
  }, [applySelection]);

  const clearSelection = useCallback(() => {
    applySelection([]);
  }, [applySelection]);

  const deleteSelected = useCallback(() => {
    const selectedIds = selectedEventIdsRef.current;
    const primaryId = selectedEventIdRef.current;
    const ids = selectedIds.length > 0 ? selectedIds : primaryId ? [primaryId] : [];
    if (ids.length === 0) return;
    const targetSet = new Set(ids);
    commitProject(
      (current) => ({ ...current, events: packEvents(current.events.filter((event) => !targetSet.has(event.id))) }),
      `Deleted ${ids.length} SFX event${ids.length === 1 ? '' : 's'}.`,
    );
    clearSelection();
  }, [clearSelection, commitProject]);

  const nudgeSelectedEvents = useCallback((frameDelta: number): boolean => {
    const selectedIds = selectedEventIdsRef.current;
    const primaryId = selectedEventIdRef.current;
    const ids = selectedIds.length > 0 ? selectedIds : primaryId ? [primaryId] : [];
    if (ids.length === 0 || frameDelta === 0) return false;
    const current = projectRef.current;
    const selectedSet = new Set(ids);
    const selected = current.events.filter((event) => selectedSet.has(event.id));
    if (selected.length === 0) return false;

    const fps = Math.max(1, current.fps);
    const requestedDeltaSeconds = frameDelta / fps;
    const minStart = Math.min(...selected.map((event) => event.startSeconds));
    const maxEnd = Math.max(...selected.map((event) => eventEndSeconds(event.startSeconds, event.duration)));
    const deltaSeconds = clamp(requestedDeltaSeconds, -minStart, current.duration - maxEnd);
    if (Math.abs(deltaSeconds) < 0.000001) {
      setStatus('Selected SFX is at the timeline boundary.');
      return true;
    }

    commitProject(
      (projectValue) => ({
        ...projectValue,
        events: packEvents(projectValue.events.map((event) => {
          if (!selectedSet.has(event.id)) return event;
          const startSeconds = clamp(event.startSeconds + deltaSeconds, 0, projectValue.duration);
          return {
            ...event,
            startSeconds,
            startFrame: Math.max(0, Math.round(startSeconds * projectValue.fps)),
          };
        })),
      }),
      `Nudged ${selected.length} selected SFX ${frameDelta < 0 ? 'left' : 'right'} ${Math.abs(frameDelta)} frame${Math.abs(frameDelta) === 1 ? '' : 's'}.`,
    );
    return true;
  }, [commitProject]);

  const stepFrame = useCallback((frameDelta: number) => {
    const current = projectRef.current;
    const fps = Math.max(1, current.fps);
    const currentFrame = Math.round(currentSecondsRef.current * fps);
    const nextSeconds = clamp((currentFrame + frameDelta) / fps, 0, current.duration);
    seekTo(nextSeconds);
    setStatus(`${frameDelta < 0 ? 'Back' : 'Forward'} 1 frame.`);
  }, [seekTo]);

  const splitSelectedEventsAtPlayhead = useCallback(() => {
    const selectedIds = selectedEventIdsRef.current;
    const primaryId = selectedEventIdRef.current;
    const ids = selectedIds.length > 0 ? selectedIds : primaryId ? [primaryId] : [];
    if (ids.length === 0) {
      setStatus('Select an SFX clip to split.');
      return;
    }

    const current = projectRef.current;
    const fps = Math.max(1, current.fps);
    const splitSeconds = clamp(Math.round(currentSecondsRef.current * fps) / fps, 0, current.duration);
    const result = splitEventsInProject(current, ids, splitSeconds);
    const nextSplitIds = result.splitIds;

    if (nextSplitIds.length === 0) {
      setStatus('Move the playhead inside the selected clip to split it.');
      return;
    }

    commitProject(() => result.project);

    selectedEventIdsRef.current = nextSplitIds;
    selectedEventIdRef.current = nextSplitIds[0] ?? null;
    setSelectedEventIds(nextSplitIds);
    setSelectedEventId(nextSplitIds[0] ?? null);
    setStatus(`Split ${nextSplitIds.length} SFX clip${nextSplitIds.length === 1 ? '' : 's'} at ${secondsToClock(splitSeconds)}.`);
  }, [commitProject]);

  const undo = useCallback(() => {
    setProject((current) => {
      const previous = undoStackRef.current.pop();
      if (!previous) {
        setStatus('Nothing to undo.');
        return current;
      }
      redoStackRef.current = [...redoStackRef.current.slice(-79), current];
      editRevisionRef.current += 1;
      setDirty(true);
      dirtyRef.current = true;
      selectedEventIdRef.current = null;
      selectedEventIdsRef.current = [];
      setSelectedEventId(null);
      setSelectedEventIds([]);
      setStatus('Undo.');
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setProject((current) => {
      const next = redoStackRef.current.pop();
      if (!next) {
        setStatus('Nothing to redo.');
        return current;
      }
      undoStackRef.current = [...undoStackRef.current.slice(-79), current];
      editRevisionRef.current += 1;
      setDirty(true);
      dirtyRef.current = true;
      selectedEventIdRef.current = null;
      selectedEventIdsRef.current = [];
      setSelectedEventId(null);
      setSelectedEventIds([]);
      setStatus('Redo.');
      return next;
    });
  }, []);

  const beginTimingEdit = useCallback(() => {
    if (!timingEditBaselineRef.current) timingEditBaselineRef.current = projectRef.current;
  }, []);

  const moveEvents = useCallback((eventIds: string[], anchorEventId: string, targetStartSeconds: number) => {
    setProject((current) => {
      const next = moveEventsInProject(current, eventIds, anchorEventId, targetStartSeconds);
      if (next !== current) {
        editRevisionRef.current += 1;
      }
      projectRef.current = next;
      return next;
    });
    setDirty(true);
    dirtyRef.current = true;
  }, []);

  const resizeEvent = useCallback((eventId: string, edge: 'left' | 'right', targetSeconds: number) => {
    setProject((current) => {
      const next = resizeEventInProject(current, eventId, edge, targetSeconds);
      if (next !== current) {
        editRevisionRef.current += 1;
      }
      projectRef.current = next;
      return next;
    });
    setDirty(true);
    dirtyRef.current = true;
  }, []);

  const endTimingEdit = useCallback(() => {
    const baseline = timingEditBaselineRef.current;
    timingEditBaselineRef.current = null;
    if (!baseline || baseline === projectRef.current) return;
    undoStackRef.current = [...undoStackRef.current.slice(-79), baseline];
    redoStackRef.current = [];
    scheduleAutosave();
    setStatus('Timing adjusted.');
  }, [scheduleAutosave]);

  const jumpZoom = useCallback((direction: 'next' | 'previous') => {
    const markers = projectRef.current.zoomMarkers;
    if (markers.length === 0) {
      setStatus('No zoom moments loaded.');
      return;
    }
    const fps = Math.max(1, projectRef.current.fps);
    const guard = 0.5 / fps;
    const current = currentSecondsRef.current;
    const marker = direction === 'next'
      ? markers.find((item) => item.startSeconds > current + guard)
      : [...markers].reverse().find((item) => item.startSeconds < current - guard);
    if (!marker) {
      setStatus(direction === 'next' ? 'No later zoom moment.' : 'No earlier zoom moment.');
      return;
    }
    seekTo(marker.startSeconds);
    setStatus(`Jumped to zoom ${secondsToClock(marker.startSeconds)}.`);
  }, [seekTo]);

  const exportAudio = useCallback(async () => {
    if (exporting) return;
    const projectToExport = projectWithSavedPlayhead(projectRef.current, currentSecondsRef.current);
    let exportDir: string;
    try {
      const folderResponse = await fetch('/api/choose-export-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: projectToExport }),
      }).catch(() => null);
      if (!folderResponse?.ok) {
        const details = folderResponse ? await folderResponse.text().catch(() => '') : '';
        throw new Error(details || 'Export folder dialog failed.');
      }
      const folderPayload = await folderResponse.json() as ExportFolderResponse;
      if (folderPayload.cancelled) {
        setStatus('Export cancelled.');
        return;
      }
      exportDir = folderPayload.folderPath || '';
      if (!exportDir) throw new Error('No export folder was selected.');
    } catch (error) {
      setStatus(`Folder picker failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    setExporting(true);
    setStatus(`Starting 320 kbps MP3 export to ${exportDir}...`);

    let jobId = '';
    let exportFinished = false;

    try {
      const response = await fetch('/api/export-audio-job', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: projectToExport, exportDir }),
      }).catch(() => null);
      if (!response?.ok) {
        const details = response ? await response.text().catch(() => '') : '';
        throw new Error(details || 'Check bridge log for ffmpeg details.');
      }
      let payload = await response.json() as ExportJobResponse;
      jobId = payload.jobId || '';
      if (!jobId) throw new Error('Export bridge did not start a render job.');

      while (true) {
        const readyCount = payload.files?.length || 0;
        if (payload.status === 'done') {
          exportFinished = true;
          break;
        }
        if (payload.status === 'failed' || payload.status === 'cancelled') {
          throw new Error(payload.error || `Export ${payload.status}.`);
        }
        const current = payload.currentFileName ? ` Now rendering ${payload.currentFileName}.` : '';
        setStatus(`Rendering MP3 package directly to disk... ${readyCount}/${payload.totalFiles || '?'} files ready.${current}`);
        await wait(1000);
        const pollResponse = await fetch(`/api/export-audio-job?id=${encodeURIComponent(jobId)}`).catch(() => null);
        if (!pollResponse?.ok) {
          const details = pollResponse ? await pollResponse.text().catch(() => '') : '';
          throw new Error(details || 'Export progress could not be read.');
        }
        payload = await pollResponse.json() as ExportJobResponse;
      }

      const exportedProject = normalizeProject({ ...projectToExport, lastExportPath: payload.outputDir || exportDir });
      await fetch('/api/save-project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: exportedProject, saveReason: 'edit', createBackup: false }),
      }).catch(() => null);
      setProject(exportedProject);
      projectRef.current = exportedProject;
      setDirty(false);
      dirtyRef.current = false;
      setStatus(`Exported ${payload.files?.length || 0} MP3 files at 320 kbps to ${payload.outputDir || exportDir}. Drop stems at the source start in Premiere.`);
    } catch (error) {
      if (jobId && !exportFinished) {
        await fetch(`/api/export-audio-job?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => null);
      }
      setStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (isTextInput) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProjectSnapshot('manual-save', { createBackup: true });
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void exportAudio();
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        splitSelectedEventsAtPlayhead();
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        jumpZoom('next');
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        jumpZoom('previous');
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        if ((event.shiftKey || event.altKey) && nudgeSelectedEvents(direction * (event.shiftKey ? 5 : 1))) {
          event.preventDefault();
          return;
        }
        stepFrame(direction);
        return;
      }
      const soundboardIndex = soundboardIndexForHotkey(event.key);
      if (soundboardIndex >= 0 && soundboardIndex < library.categories.length) {
        event.preventDefault();
        placeSFX(library.categories[soundboardIndex]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection, deleteSelected, exportAudio, jumpZoom, library.categories, nudgeSelectedEvents, placeSFX, redo, saveProjectSnapshot, splitSelectedEventsAtPlayhead, stepFrame, togglePlayback, undo]);

  const toggleManualFolder = useCallback((folderId: string) => {
    setExpandedManualFolders((current) => (
      current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId]
    ));
  }, []);

  function renderManualFolder(folder: ManualSFXFolder, depth = 0): ReactNode {
    const query = manualSearch.trim();
    if (!folderHasSearchMatch(folder, query)) return null;
    const expanded = Boolean(query) || expandedManualFolders.includes(folder.id);
    const visibleFiles = folder.files.filter((file) => fileMatchesSearch(file, folder, query));
    const visibleChildren = folder.folders
      .map((child) => renderManualFolder(child, depth + 1))
      .filter(Boolean);
    const fileCount = folder.files.length + folder.folders.reduce((total, child) => total + collectManualFolders([child]).reduce((sum, item) => sum + item.files.length, 0), 0);

    return (
      <div className="manual-folder" key={folder.id} style={{ '--folder-depth': depth } as CSSProperties}>
        <button type="button" className="manual-folder-row" onClick={() => toggleManualFolder(folder.id)}>
          <span>{expanded ? '▾' : '▸'}</span>
          <strong>{folder.name}</strong>
          <em>{fileCount}</em>
        </button>
        {expanded && (
          <div className="manual-folder-body">
            {visibleFiles.length > 0 && (
              <div className="manual-file-grid">
                {visibleFiles.map((file) => (
                  <button
                    type="button"
                    key={file.id}
                    className="manual-file-pad"
                    style={{ '--manual-pad-color': folder.color } as CSSProperties}
                    onClick={() => placeManualSFX(file, folder)}
                    disabled={file.levelStatus !== 'ready'}
                    title={file.levelStatus === 'ready' ? file.name : `Analyzing Manual SFX: ${manualLeveling.ready}/${manualLeveling.total} ready`}
                  >
                    <span>{file.name}</span>
                  </button>
                ))}
              </div>
            )}
            {visibleChildren}
          </div>
        )}
      </div>
    );
  }

  return (
    <main className="editor-shell">
      <section className="topbar">
        <div className="title-block">
          <div className="eyebrow">Live SFX Board</div>
          <h1>{project.name}</h1>
        </div>
        <div className="toolbelt">
          <div className="transport">
            <button onClick={togglePlayback} title="Play or pause source video">
              {isPlaying ? '⏸ Pause' : '▶ Play'} <kbd>Space</kbd>
            </button>
            <label className="numeric-control" title="Human reaction compensation in source frames">
              <span>Offset</span>
              <input
                value={project.reactionOffsetFrames}
                type="number"
                min={0}
                max={30}
                onChange={(event) => {
                  const value = Math.max(0, Math.round(Number(event.target.value) || 0));
                  commitProject((current) => ({ ...current, reactionOffsetFrames: value }), `Reaction offset set to ${value} frames.`);
                }}
              />
              <kbd>frames</kbd>
            </label>
            <label className="numeric-control" title="Maximum upward pitch/speed variation. Hard-capped at 1.40x.">
              <span>Max Rate</span>
              <input
                value={project.maxPlaybackRate.toFixed(2)}
                type="number"
                min={MIN_PLAYBACK_RATE}
                max={MAX_PLAYBACK_RATE}
                step={0.01}
                onChange={(event) => {
                  const value = clamp(Number(event.target.value) || MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
                  commitProject((current) => ({ ...current, maxPlaybackRate: value }), `Max SFX rate set to ${value.toFixed(2)}x.`);
                }}
              />
              <kbd>≤ 1.40</kbd>
            </label>
            <label className="numeric-control" title="SFX master trim">
              <span>SFX Vol</span>
              <input
                value={project.masterGainDb.toFixed(1)}
                type="number"
                min={-24}
                max={6}
                step={0.5}
                onChange={(event) => {
                  const numeric = Number(event.target.value);
                  const value = Number.isFinite(numeric) ? clamp(numeric, -24, 6) : -12;
                  commitProject((current) => ({ ...current, masterGainDb: value }), `SFX master set to ${value.toFixed(1)} dB.`);
                }}
              />
              <kbd>dB</kbd>
            </label>
            <button onClick={undo}>↶ Undo <kbd>Cmd Z</kbd></button>
            <button onClick={redo}>↷ Redo <kbd>⇧Cmd Z</kbd></button>
            <button onClick={() => void saveProjectSnapshot('manual-save', { createBackup: true })} className={dirty ? 'hot' : ''}>
              ⇧ Save <kbd>Cmd S</kbd>
            </button>
            <button onClick={() => void exportAudio()} className={exporting ? 'hot' : ''}>
              ⬇ MP3 <kbd>Cmd E</kbd>
            </button>
          </div>
        </div>
      </section>

      <section className="workbench">
        <section className="preview-panel">
          <div className="native-preview-frame">
            <div className="video-monitor">
              {project.sourceMediaPath && isVideo ? (
                <video
                  key={project.sourceMediaPath}
                  ref={attachMedia}
                  src={mediaEndpoint(project.sourceMediaPath)}
                  className="video-media-source"
                  playsInline
                  preload="auto"
                />
              ) : (
                <div className="video-placeholder">
                  <span>No media source</span>
                  <small>Load a source video to spot effects in sync.</small>
                </div>
              )}
            </div>
          </div>
          <div className="preview-footer">
            <span>{secondsToClock(currentSeconds)}</span>
            <span>{frameLabel(currentSeconds, project.fps)}</span>
            <span>{project.events.length} events</span>
            <span>{zoomMarkers.length} zooms</span>
            <span>{selectedEventIds.length ? `${selectedEventIds.length} selected` : status}</span>
            <span>{dirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
        </section>

        <aside className="inspector">
          <section className="soundboard">
            <div className="panel-tabs" role="tablist" aria-label="Sound tools">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'soundboard'}
                className={inspectorTab === 'soundboard' ? 'panel-tab active' : 'panel-tab'}
                onClick={() => setInspectorTab('soundboard')}
              >
                Soundboard
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'manual'}
                className={inspectorTab === 'manual' ? 'panel-tab active' : 'panel-tab'}
                onClick={() => setInspectorTab('manual')}
              >
                Manual SFX
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'automation'}
                className={inspectorTab === 'automation' ? 'panel-tab active' : 'panel-tab'}
                onClick={() => setInspectorTab('automation')}
              >
                Automations
              </button>
            </div>

            {inspectorTab === 'soundboard' ? (
              <div className="soundboard-tab">
                <div className="panel-strip">
                  <span>{selectedCount ? `${selectedCount} selected: next pad replaces` : 'Pads place at playhead'}</span>
                  <span>Analysis {leveling.ready}/{leveling.total}</span>
                </div>
                <div className="sound-grid">
                  {library.categories.map((category, categoryIndex) => {
                    const hotkey = hotkeyForSoundboardIndex(categoryIndex);
                    const readyCount = categoryReadyCount(category);
                    return (
                      <button
                        key={category.id}
                        className={selectedCount ? 'sound-pad replace-armed' : 'sound-pad'}
                        style={{ '--pad-color': category.color } as CSSProperties}
                        onClick={() => placeSFX(category)}
                        disabled={readyCount === 0}
                        title={
                          readyCount > 0
                            ? selectedCount
                              ? `${category.name}: replace ${selectedCount} selected event${selectedCount === 1 ? '' : 's'}`
                              : category.name
                            : category.files.length
                              ? `${category.name} is loading: ${readyCount}/${category.files.length} ready`
                              : `${category.name} has no playable files`
                        }
                      >
                        <strong>{category.name}</strong>
                        {hotkey && <span className="sound-pad-hotkey">{hotkey}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : inspectorTab === 'manual' ? (
              <div className="manual-panel">
                <div className="manual-search">
                  <input
                    value={manualSearch}
                    onChange={(event) => setManualSearch(event.target.value)}
                    placeholder="Search Manual SFX"
                    aria-label="Search Manual SFX"
                  />
                  <span>{manualLeveling.ready}/{manualLeveling.total}</span>
                </div>
                <div className="manual-folder-list">
                  {manualLibrary.folders.length > 0 ? (
                    manualLibrary.folders.map((folder) => renderManualFolder(folder))
                  ) : (
                    <p className="empty-state">Manual SFX folder is empty or unavailable.</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="automation-panel">
                <div className="automation-region">
                  <label>
                    <span>Start</span>
                    <input
                      value={automationStartDraft}
                      onChange={(event) => setAutomationStartDraft(event.target.value)}
                      placeholder="0.000"
                    />
                  </label>
                  <label>
                    <span>End</span>
                    <input
                      value={automationEndDraft}
                      onChange={(event) => setAutomationEndDraft(event.target.value)}
                      placeholder={formatRegionTime(project.duration)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setAutomationStartDraft('0.000');
                      setAutomationEndDraft(formatRegionTime(projectRef.current.duration));
                    }}
                  >
                    Full
                  </button>
                </div>
                <div className="region-readout">
                  {secondsToClock(automationRegion.start)} to {secondsToClock(automationRegion.end)}
                </div>
                <div className="automation-actions">
                  <button
                    type="button"
                    className="automation-button primary"
                    onClick={() => void applySFXAutomationPass()}
                    disabled={automationRunning || zoomMarkers.length === 0}
                  >
                    <strong>{automationRunning ? 'Generating SFX Pass' : 'Generate SFX Pass'}</strong>
                    <span>Places editable V1 automation clips into the current project</span>
                  </button>
                </div>
                <div className="leveling-readout">
                  V1 focuses on pop and zoom accent moments. Extra SFX can be swapped, deleted, or added manually after generation.
                </div>
              </div>
            )}
          </section>
        </aside>
      </section>

      <section className="timeline-panel">
        <div className="timeline-header">
          <span>Timeline</span>
          <input
            type="range"
            min={24}
            max={180}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
          />
          <strong>{project.events.length} events / {zoomMarkers.length} zooms</strong>
          <em>up/down jumps zooms • two-finger scrubs • control-scroll zooms</em>
        </div>
        <SFXTimelineCanvas
          project={project}
          currentSeconds={currentSeconds}
          selectedEventId={selectedEventId}
          selectedEventIds={selectedEventIds}
          zoom={zoom}
          onSeek={seekTo}
          onScrubSeconds={(deltaSeconds) => seekTo(currentSecondsRef.current + deltaSeconds)}
          onZoomChange={setZoom}
          onSelectEvent={selectEvent}
          onSelectEvents={selectEvents}
          onClearSelection={clearSelection}
          onBeginTimingEdit={beginTimingEdit}
          onMoveEvents={moveEvents}
          onResizeEvent={resizeEvent}
          onEndTimingEdit={endTimingEdit}
          focusPlayheadSignal={focusPlayheadSignal}
          waveformByPath={waveformByPath}
        />
      </section>
    </main>
  );
}
