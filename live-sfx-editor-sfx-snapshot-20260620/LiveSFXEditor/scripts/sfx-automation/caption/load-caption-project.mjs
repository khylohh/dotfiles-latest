import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readCaptionProject(filePath) {
  const resolvedPath = resolve(String(filePath || ''));
  if (!existsSync(resolvedPath)) {
    throw new Error(`Caption project does not exist: ${resolvedPath}`);
  }
  const descriptor = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const snapshot = descriptor?.kind === 'CaptionAIProject'
    ? descriptor.projectSnapshot
    : descriptor;
  const rawProject = snapshot && typeof snapshot === 'object'
    ? snapshot
    : descriptor?.projectPath && existsSync(resolve(String(descriptor.projectPath)))
      ? JSON.parse(readFileSync(resolve(String(descriptor.projectPath)), 'utf8'))
      : null;
  if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) {
    throw new Error(`No CaptionAI project snapshot found in ${resolvedPath}`);
  }

  const duration = Number(rawProject.duration) > 0 ? Number(rawProject.duration) : 0;
  const fps = Number(rawProject.fps) > 0 ? Number(rawProject.fps) : Number(descriptor?.fps) || 50;
  return {
    version: 1,
    name: String(rawProject.name || descriptor?.name || 'CaptionAI Project'),
    sourceMediaPath: String(rawProject.sourceMediaPath || descriptor?.mediaPath || ''),
    projectFilePath: String(rawProject.projectFilePath || resolvedPath),
    descriptorPath: resolvedPath,
    backingProjectPath: descriptor?.projectPath ? resolve(String(descriptor.projectPath)) : '',
    fps,
    duration,
    cues: normalizeCues(rawProject.cues, duration),
    words: normalizeWords(rawProject.words, duration),
  };
}

function normalizeCues(raw, duration) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((cue, index) => {
      const start = Math.max(0, Number(cue?.start) || 0);
      const end = Math.max(start, Number(cue?.end) || start);
      return {
        id: String(cue?.id || `cue-${index}`),
        start: Math.min(duration || end, start),
        end: Math.min(duration || end, end),
        text: String(cue?.text || '').trim(),
        speaker: String(cue?.speaker || ''),
        track: Number.isFinite(Number(cue?.track)) ? Number(cue.track) : undefined,
        originalTrack: Number.isFinite(Number(cue?.originalTrack)) ? Number(cue.originalTrack) : undefined,
        wordIds: Array.isArray(cue?.wordIds) ? cue.wordIds.map(String) : [],
        edited: Boolean(cue?.edited),
      };
    })
    .filter((cue) => cue.text && cue.end >= cue.start)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function normalizeWords(raw, duration) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((word, index) => {
      const start = Math.max(0, Number(word?.start) || 0);
      const end = Math.max(start, Number(word?.end) || start);
      return {
        id: String(word?.id || `word-${index}`),
        text: String(word?.text || '').trim(),
        start: Math.min(duration || end, start),
        end: Math.min(duration || end, end),
      };
    })
    .filter((word) => word.text)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}
