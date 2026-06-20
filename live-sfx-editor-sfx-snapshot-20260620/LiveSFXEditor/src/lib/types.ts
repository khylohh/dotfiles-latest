export interface SFXFile {
  id: string;
  categoryId: string;
  name: string;
  path: string;
  duration: number;
  onsetSeconds: number;
  waveformPeaks?: number[];
  gainDb: number;
  gainLinear: number;
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  levelStatus: 'ready' | 'pending' | 'estimated';
}

export interface SFXCategory {
  id: string;
  name: string;
  path: string;
  color: string;
  files: SFXFile[];
}

export interface SFXDeckState {
  remainingIds: string[];
  usedIds: string[];
  cycle: number;
}

export interface SFXEvent {
  id: string;
  categoryId: string;
  categoryName: string;
  fileId: string;
  fileName: string;
  filePath: string;
  color: string;
  startFrame: number;
  startSeconds: number;
  duration: number;
  baseDuration: number;
  sourceOffsetSeconds: number;
  audibleOffsetSeconds: number;
  playbackRate: number;
  waveformPeaks?: number[];
  gainDb: number;
  gainLinear: number;
  track: number;
  createdAt: string;
  snapZoomId?: string;
  automation?: Record<string, unknown>;
}

export interface ZoomMarker {
  id: string;
  name: string;
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface LiveSFXProject {
  version: 1;
  name: string;
  sourceMediaPath: string;
  outputDir: string;
  libraryRoot: string;
  manualRoot: string;
  fps: number;
  duration: number;
  sampleRate: number;
  zoomXmlPath: string;
  zoomMarkers: ZoomMarker[];
  reactionOffsetFrames: number;
  maxPlaybackRate: number;
  masterGainDb: number;
  savedPlayheadSeconds?: number;
  lastExportPath?: string;
  projectFilePath?: string;
  projectLauncherPath?: string;
  events: SFXEvent[];
  decks: Record<string, SFXDeckState>;
}

export interface LibraryResponse {
  root: string;
  leveling?: {
    ready: number;
    total: number;
    pending: number;
    targetMeanDb: number;
  };
  categories: SFXCategory[];
}

export interface ManualSFXFolder {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  color: string;
  files: SFXFile[];
  folders: ManualSFXFolder[];
}

export interface ManualLibraryResponse {
  root: string;
  leveling?: {
    ready: number;
    total: number;
    pending: number;
    targetMeanDb: number;
  };
  folders: ManualSFXFolder[];
}
