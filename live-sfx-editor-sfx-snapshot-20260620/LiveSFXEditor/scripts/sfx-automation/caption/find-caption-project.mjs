import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const captionProjectExtension = '.captionai';
const defaultResolverMargin = 8;

export function findCaptionProjectForMedia(project, options = {}) {
  return resolveCaptionProjectForMedia(project, options).captionPath;
}

export function resolveCaptionProjectForMedia(project, options = {}) {
  const explicit = options.captionPath || project.captionSourcePath || project.captionProjectPath;
  if (explicit) {
    const explicitPath = resolve(String(explicit));
    if (!existsSync(explicitPath)) {
      return fail('explicit_caption_missing', { explicitPath });
    }
    const candidate = buildCaptionCandidate(explicitPath, project, project.sourceMediaPath ? resolve(String(project.sourceMediaPath)) : '');
    if (!candidate) return fail('explicit_caption_unreadable', { explicitPath });
    const validation = validateCaptionCandidate(candidate, project, { explicit: true });
    if (!validation.ok) return fail(validation.reason, { explicitPath, candidates: [candidate] });
    return ok(candidate, 'explicit_caption_path');
  }

  const mediaPath = project.sourceMediaPath ? resolve(String(project.sourceMediaPath)) : '';
  if (!mediaPath) return fail('missing_media_path');
  const roots = unique([
    options.searchRoot,
    project.outputDir,
    dirname(mediaPath),
  ].filter(Boolean).map((value) => resolve(String(value))));
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const candidate of findCaptionDescriptors(root, Number(options.maxDepth ?? 4))) {
      const resolved = buildCaptionCandidate(candidate, project, mediaPath);
      if (!resolved?.score) continue;
      candidates.push(resolved);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.durationDeltaSec - b.durationDeltaSec || a.path.length - b.path.length);
  const best = candidates[0];
  if (!best) return fail('no_caption_candidate', { candidates });
  const validation = validateCaptionCandidate(best, project);
  if (!validation.ok) return fail(validation.reason, { candidates });
  const second = candidates[1] || null;
  const resolverMargin = Number(options.resolverMargin ?? defaultResolverMargin);
  if (second && best.score - second.score < resolverMargin) {
    return fail('ambiguous_caption_candidate', { candidates });
  }
  return ok(best, 'resolved_caption_candidate', candidates);
}

function unique(values) {
  return [...new Set(values)];
}

function findCaptionDescriptors(root, maxDepth) {
  const output = [];
  const visit = (dir, depth) => {
    if (depth < 0) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (/backup|backups|cache|node_modules/i.test(entry.name)) continue;
        visit(fullPath, depth - 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === captionProjectExtension) {
        output.push(fullPath);
      }
    }
  };
  try {
    if (statSync(root).isDirectory()) visit(root, maxDepth);
  } catch {
    return [];
  }
  return output;
}

function buildCaptionCandidate(filePath, project, mediaPath) {
  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  const snapshot = descriptor?.kind === 'CaptionAIProject' ? descriptor.projectSnapshot : descriptor;
  const descriptorMedia = descriptor?.mediaPath || snapshot?.sourceMediaPath || descriptor?.projectSnapshot?.sourceMediaPath;
  const snapshotDuration = Number(snapshot?.duration);
  const projectDuration = Number(project.duration);
  const cueRange = cueTimeRange(snapshot?.cues);
  const durationDeltaSec = Number.isFinite(snapshotDuration) && Number.isFinite(projectDuration)
    ? Math.abs(snapshotDuration - projectDuration)
    : Number.POSITIVE_INFINITY;
  const transcriptExcessSec = Number.isFinite(projectDuration) && Number.isFinite(cueRange.lastEndSec)
    ? Math.max(0, cueRange.lastEndSec - projectDuration)
    : 0;
  return {
    path: resolve(filePath),
    captionProjectId: firstHex(`${resolve(filePath)}\0${descriptorMedia || ''}\0${snapshotDuration || ''}`),
    descriptorMedia: descriptorMedia ? String(descriptorMedia) : '',
    captionDurationSec: Number.isFinite(snapshotDuration) ? snapshotDuration : 0,
    projectDurationSec: Number.isFinite(projectDuration) ? projectDuration : 0,
    durationDeltaSec,
    transcriptFirstSec: cueRange.firstStartSec,
    transcriptLastSec: cueRange.lastEndSec,
    transcriptExcessSec,
    score: scoreCaptionDescriptor({
      descriptorMedia,
      descriptorName: descriptor?.name || snapshot?.name || '',
      filePath,
      mediaPath,
      project,
      snapshotDuration,
      durationDeltaSec,
    }),
  };
}

function scoreCaptionDescriptor({ descriptorMedia, descriptorName, filePath, mediaPath, project, snapshotDuration, durationDeltaSec }) {
  const projectDuration = Number(project.duration);
  let score = 0;
  if (descriptorMedia && mediaPath && resolve(String(descriptorMedia)) === mediaPath) score = Math.max(score, 100);
  if (
    descriptorMedia
    && mediaPath
    && descriptorMedia.split('/').pop() === mediaPath.split('/').pop()
    && durationDeltaSec <= durationLimit(projectDuration) * 2
  ) {
    score = Math.max(score, 80);
  }
  const mediaDateToken = dateToken(mediaPath);
  const descriptorHaystack = `${descriptorName || ''} ${filePath} ${descriptorMedia || ''}`.toLowerCase();
  if (mediaDateToken && descriptorHaystack.includes(mediaDateToken)) score = Math.max(score, 55);
  const mediaStem = basename(mediaPath, extname(mediaPath)).toLowerCase();
  if (mediaStem && descriptorHaystack.includes(mediaStem)) score = Math.max(score, 50);
  if (Number.isFinite(snapshotDuration) && Number.isFinite(projectDuration) && durationDeltaSec <= durationLimit(projectDuration)) score = Math.max(score, 45);
  return score;
}

function validateCaptionCandidate(candidate, project, options = {}) {
  const projectDuration = Number(project.duration);
  const limit = durationLimit(projectDuration);
  if (Number.isFinite(candidate.durationDeltaSec) && candidate.durationDeltaSec > limit) {
    return { ok: false, reason: options.explicit ? 'explicit_caption_duration_mismatch' : 'caption_duration_mismatch' };
  }
  if (candidate.transcriptExcessSec > limit) {
    return { ok: false, reason: 'caption_transcript_exceeds_media' };
  }
  if (!candidate.captionDurationSec || !Number.isFinite(candidate.durationDeltaSec)) {
    return { ok: false, reason: 'caption_duration_unresolved' };
  }
  return { ok: true, reason: 'caption_identity_ok' };
}

function durationLimit(projectDuration) {
  return Math.max(0.5, Math.max(0, Number(projectDuration) || 0) * 0.005);
}

function cueTimeRange(cues) {
  if (!Array.isArray(cues) || !cues.length) {
    return { firstStartSec: null, lastEndSec: null };
  }
  let firstStartSec = Number.POSITIVE_INFINITY;
  let lastEndSec = 0;
  for (const cue of cues) {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    if (Number.isFinite(start)) firstStartSec = Math.min(firstStartSec, start);
    if (Number.isFinite(end)) lastEndSec = Math.max(lastEndSec, end);
  }
  return {
    firstStartSec: Number.isFinite(firstStartSec) ? firstStartSec : null,
    lastEndSec: Number.isFinite(lastEndSec) ? lastEndSec : null,
  };
}

function ok(candidate, reason, candidates = [candidate]) {
  return {
    status: 'ok',
    reason,
    captionPath: candidate.path,
    captionProjectId: candidate.captionProjectId,
    resolverConfidence: candidate.score,
    durationDeltaSec: candidate.durationDeltaSec,
    captionDurationSec: candidate.captionDurationSec,
    projectDurationSec: candidate.projectDurationSec,
    candidates: candidates.map(compactCandidate),
  };
}

function fail(reason, extra = {}) {
  return {
    status: 'failed',
    reason,
    captionPath: '',
    captionProjectId: '',
    resolverConfidence: 0,
    durationDeltaSec: null,
    captionDurationSec: null,
    projectDurationSec: null,
    candidates: Array.isArray(extra.candidates) ? extra.candidates.map(compactCandidate) : [],
    explicitPath: extra.explicitPath || '',
  };
}

function compactCandidate(candidate) {
  return {
    path: candidate.path,
    captionProjectId: candidate.captionProjectId,
    score: candidate.score,
    descriptorMedia: candidate.descriptorMedia,
    captionDurationSec: candidate.captionDurationSec,
    projectDurationSec: candidate.projectDurationSec,
    durationDeltaSec: Number.isFinite(candidate.durationDeltaSec) ? candidate.durationDeltaSec : null,
    transcriptFirstSec: candidate.transcriptFirstSec,
    transcriptLastSec: candidate.transcriptLastSec,
    transcriptExcessSec: candidate.transcriptExcessSec,
  };
}

function firstHex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function dateToken(value) {
  const match = String(value || '').match(/\b\d{2}-\d{2}-\d{2}\b/);
  return match ? match[0].toLowerCase() : '';
}
