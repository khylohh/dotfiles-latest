import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSFXPass } from './sfx-automation/run-sfx-pass.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(root, 'dist');
const defaultLibraryRoot = '/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX';
const defaultManualRoot = '/Users/kyle/Desktop/2026 SFX/Categories/Manual SFX';
const defaultOutputDir = join(homedir(), 'Desktop', 'Live SFX Projects');
const args = new Map();

for (let i = 2; i < process.argv.length; i += 1) {
  const item = process.argv[i];
  if (item.startsWith('--')) {
    args.set(item.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const libraryRoot = resolve(String(args.get('library-root') || defaultLibraryRoot));
const manualRoot = resolve(String(args.get('manual-root') || defaultManualRoot));
const outputDir = resolve(String(args.get('output-dir') || defaultOutputDir));
const projectPath = resolve(String(args.get('project') || join(outputDir, 'live_sfx_project.json')));
const initialMedia = args.get('media') ? resolve(String(args.get('media'))) : '';
const explicitZoomXml = args.get('zoom-xml') ? resolve(String(args.get('zoom-xml'))) : '';
const explicitProjectFile = args.get('project-file') ? resolve(String(args.get('project-file'))) : '';
const port = Number(args.get('port') || 5187);
const ffprobeBinary = resolveBinary('ffprobe');
const ffmpegBinary = resolveBinary('ffmpeg');
const durationCachePath = join(outputDir, 'live_sfx_duration_cache.json');
const loudnessCachePath = join(outputDir, 'live_sfx_loudness_cache.json');
const onsetCachePath = join(outputDir, 'live_sfx_onset_cache.json');
const waveformCachePath = join(outputDir, 'live_sfx_waveform_cache.json');
const targetMeanDb = -18;
const durationCache = new Map();
const loudnessCache = new Map();
const onsetCache = new Map();
const waveformCache = new Map();
let durationProbeRunning = false;
let loudnessProbeRunning = false;
let onsetProbeRunning = false;
let waveformProbeRunning = false;
let bridgeShuttingDown = false;
const activeFfmpegChildren = new Set();
const exportJobs = new Map();

const categoryColors = [
  '#39d6df',
  '#f6d85f',
  '#71df8d',
  '#ff705c',
  '#c87bff',
  '#ff8fc8',
  '#ef9b4e',
  '#96a8ff',
  '#d8f071',
];

const mimeTypes = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.json', 'application/json'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

const audioExtensions = new Set(['.wav', '.mp3', '.aiff', '.aif', '.m4a', '.aac']);
const projectFileExtension = '.sfxinterface';
const recordScratchCategoryId = 'record_scratch';
const stemRenderConcurrency = 6;

function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolveBinary(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name,
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    if (probe.status === 0) return candidate;
  }
  return '';
}

function appendLimited(buffer, chunk, limit = 1024 * 1024 * 2) {
  const next = `${buffer}${chunk}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function removePartialFile(filePath) {
  try {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Partial export cleanup should never hide the real ffmpeg failure.
  }
}

function stopFfmpegChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function stopActiveFfmpeg(signal = 'SIGTERM') {
  for (const child of activeFfmpegChildren) {
    stopFfmpegChild(child, signal);
  }
}

function stableId(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function displayName(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function xmlText(block, tagName) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(block);
  return match ? match[1].trim() : '';
}

function xmlNumber(block, tagName, fallback = 0) {
  const value = Number(xmlText(block, tagName));
  return Number.isFinite(value) ? value : fallback;
}

function decodeXmlText(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function parseRate(raw) {
  const [left, right] = String(raw || '').split('/').map(Number);
  if (left > 0 && right > 0) return left / right;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function xmlBoolean(block, tagName, fallback = false) {
  const value = xmlText(block, tagName);
  if (!value) return fallback;
  return /^true$/i.test(value) || value === '1';
}

function xmlRate(block, fallback = 60) {
  const rateMatch = /<rate>([\s\S]*?)<\/rate>/i.exec(block);
  const rateBlock = rateMatch ? rateMatch[1] : block;
  const timebase = Math.max(1, xmlNumber(rateBlock, 'timebase', fallback));
  return xmlBoolean(rateBlock, 'ntsc') ? (timebase * 1000) / 1001 : timebase;
}

function autoZoomXmlPath(mediaPath) {
  if (explicitZoomXml) return explicitZoomXml;
  if (!mediaPath) return '';
  const candidate = join(dirname(mediaPath), 'Zoom Information.xml');
  return existsSync(candidate) ? candidate : '';
}

function parseZoomMarkers(xmlPath) {
  if (!xmlPath || !existsSync(xmlPath)) return [];
  const xml = readFileSync(xmlPath, 'utf8').replace(/^\uFEFF/, '');
  const sequenceStart = xml.indexOf('<sequence');
  const sequenceHead = sequenceStart >= 0 ? xml.slice(sequenceStart, Math.min(xml.length, sequenceStart + 4000)) : xml;
  const timebase = xmlRate(sequenceHead, 60);
  const markers = [];
  const clipRegex = /<clipitem\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/clipitem>/gi;
  for (const match of xml.matchAll(clipRegex)) {
    const [, rawId, clipBlock] = match;
    const startFrame = xmlNumber(clipBlock, 'start', -1);
    const endFrame = xmlNumber(clipBlock, 'end', -1);
    if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || startFrame < 0 || endFrame <= startFrame) continue;
    const name = decodeXmlText(xmlText(clipBlock, 'name') || rawId);
    const startSeconds = startFrame / timebase;
    const endSeconds = endFrame / timebase;
    markers.push({
      id: rawId,
      name,
      startFrame,
      endFrame,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
    });
  }
  return markers.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function mediaProbe(filePath) {
  if (!ffprobeBinary || !filePath || !existsSync(filePath)) {
    return { duration: 60, fps: 30 };
  }
  const result = spawnSync(ffprobeBinary, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,avg_frame_rate,sample_rate',
    filePath,
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 512 * 1024 });
  if (result.status !== 0) {
    return { duration: 60, fps: 30 };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate) || 30;
    const duration = Number(video?.duration) || Number(parsed.format?.duration) || Number(audio?.duration) || 60;
    const sampleRate = Number(audio?.sample_rate) || 48000;
    return {
      duration: Math.max(0.1, duration),
      fps: Math.max(1, fps),
      sampleRate: Math.max(8000, sampleRate),
    };
  } catch {
    return { duration: 60, fps: 30, sampleRate: 48000 };
  }
}

function audioDuration(filePath) {
  if (durationCache.has(filePath)) return durationCache.get(filePath);
  const probe = mediaProbe(filePath);
  const duration = Math.max(0.02, Number(probe.duration) || 0.4);
  durationCache.set(filePath, duration);
  return duration;
}

function loadDurationCache() {
  if (!existsSync(durationCachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(durationCachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [filePath, duration] of Object.entries(parsed)) {
      const value = Number(duration);
      if (value > 0) durationCache.set(filePath, value);
    }
  } catch {
    // Corrupt duration caches are harmless; they will be rebuilt.
  }
}

function saveDurationCache() {
  try {
    mkdirSync(dirname(durationCachePath), { recursive: true });
    writeFileSync(durationCachePath, `${JSON.stringify(Object.fromEntries(durationCache), null, 2)}\n`, 'utf8');
  } catch {
    // Duration cache persistence should never block the editor.
  }
}

function loadLoudnessCache() {
  if (!existsSync(loudnessCachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(loudnessCachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [filePath, metrics] of Object.entries(parsed)) {
      if (!metrics || typeof metrics !== 'object') continue;
      const meanVolumeDb = Number(metrics.meanVolumeDb);
      const maxVolumeDb = Number(metrics.maxVolumeDb);
      const gainDb = Number(metrics.gainDb);
      const gainLinear = Number(metrics.gainLinear);
      const size = Number(metrics.size);
      const mtimeMs = Number(metrics.mtimeMs);
      if ([meanVolumeDb, maxVolumeDb, gainDb, gainLinear].every(Number.isFinite) && gainLinear > 0) {
        loudnessCache.set(filePath, { meanVolumeDb, maxVolumeDb, gainDb, gainLinear, size, mtimeMs });
      }
    }
  } catch {
    // Corrupt loudness caches are harmless; they will be rebuilt.
  }
}

function loadOnsetCache() {
  if (!existsSync(onsetCachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(onsetCachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [filePath, metrics] of Object.entries(parsed)) {
      if (!metrics || typeof metrics !== 'object') continue;
      const onsetSeconds = Number(metrics.onsetSeconds);
      const size = Number(metrics.size);
      const mtimeMs = Number(metrics.mtimeMs);
      if (Number.isFinite(onsetSeconds) && onsetSeconds >= 0) {
        onsetCache.set(filePath, { onsetSeconds, size, mtimeMs });
      }
    }
  } catch {
    // Corrupt onset caches are harmless; they will be rebuilt.
  }
}

function loadWaveformCache() {
  if (!existsSync(waveformCachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(waveformCachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [filePath, metrics] of Object.entries(parsed)) {
      if (!metrics || typeof metrics !== 'object') continue;
      const peaks = Array.isArray(metrics.peaks) ? metrics.peaks.map(Number).filter((value) => Number.isFinite(value) && value >= 0) : [];
      const size = Number(metrics.size);
      const mtimeMs = Number(metrics.mtimeMs);
      if (peaks.length > 0) waveformCache.set(filePath, { peaks: peaks.slice(0, 160), size, mtimeMs });
    }
  } catch {
    // Corrupt waveform caches are harmless; they will be rebuilt.
  }
}

function saveLoudnessCache() {
  try {
    mkdirSync(dirname(loudnessCachePath), { recursive: true });
    writeFileSync(loudnessCachePath, `${JSON.stringify(Object.fromEntries(loudnessCache), null, 2)}\n`, 'utf8');
  } catch {
    // Loudness cache persistence should never block the editor.
  }
}

function saveWaveformCache() {
  try {
    mkdirSync(dirname(waveformCachePath), { recursive: true });
    writeFileSync(waveformCachePath, `${JSON.stringify(Object.fromEntries(waveformCache), null, 2)}\n`, 'utf8');
  } catch {
    // Waveform cache persistence should never block the editor.
  }
}

function saveOnsetCache() {
  try {
    mkdirSync(dirname(onsetCachePath), { recursive: true });
    writeFileSync(onsetCachePath, `${JSON.stringify(Object.fromEntries(onsetCache), null, 2)}\n`, 'utf8');
  } catch {
    // Onset cache persistence should never block the editor.
  }
}

function cachedAudioDuration(filePath) {
  const cached = Number(durationCache.get(filePath));
  return cached > 0 ? cached : 0.75;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function loudnessCacheIsFresh(filePath, cached) {
  if (!cached) return false;
  try {
    const stat = statSync(filePath);
    return Number(cached.size) === stat.size && Math.abs(Number(cached.mtimeMs) - stat.mtimeMs) < 2;
  } catch {
    return false;
  }
}

function onsetCacheIsFresh(filePath, cached) {
  if (!cached) return false;
  try {
    const stat = statSync(filePath);
    return Number(cached.size) === stat.size && Math.abs(Number(cached.mtimeMs) - stat.mtimeMs) < 2;
  } catch {
    return false;
  }
}

function waveformCacheIsFresh(filePath, cached) {
  if (!cached) return false;
  try {
    const stat = statSync(filePath);
    return Number(cached.size) === stat.size && Math.abs(Number(cached.mtimeMs) - stat.mtimeMs) < 2;
  } catch {
    return false;
  }
}

function computeGain(meanVolumeDb, maxVolumeDb) {
  const desiredGain = targetMeanDb - meanVolumeDb;
  const peakSafeGain = -1 - maxVolumeDb;
  const gainDb = Math.max(-18, Math.min(18, desiredGain, peakSafeGain + 4));
  return {
    gainDb,
    gainLinear: dbToLinear(gainDb),
  };
}

function analyzeAudioOnset(filePath) {
  if (!ffmpegBinary || !existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const cached = onsetCache.get(filePath);
  if (onsetCacheIsFresh(filePath, cached)) return cached;

  const sampleRate = 48000;
  const result = spawnSync(ffmpegBinary, [
    '-hide_banner',
    '-nostats',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-t', '6',
    '-f', 'f32le',
    'pipe:1',
  ], { timeout: 10000, maxBuffer: sampleRate * 6 * 4 + 128 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) return null;

  const samples = new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
  const windowSize = 256;
  const rmsThreshold = 0.006;
  const peakThreshold = 0.018;
  let onsetSample = 0;
  let found = false;
  for (let start = 0; start < samples.length; start += windowSize) {
    let sumSquares = 0;
    let peak = 0;
    const end = Math.min(samples.length, start + windowSize);
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index]);
      sumSquares += value * value;
      if (value > peak) peak = value;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    if (rms >= rmsThreshold || peak >= peakThreshold) {
      found = true;
      onsetSample = start;
      for (let index = start; index < end; index += 1) {
        if (Math.abs(samples[index]) >= rmsThreshold) {
          onsetSample = Math.max(0, index - 64);
          break;
        }
      }
      break;
    }
  }
  const metrics = {
    onsetSeconds: found ? onsetSample / sampleRate : 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  onsetCache.set(filePath, metrics);
  return metrics;
}

function analyzeAudioWaveform(filePath) {
  if (!ffmpegBinary || !existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const cached = waveformCache.get(filePath);
  if (waveformCacheIsFresh(filePath, cached)) return cached;

  const sampleRate = 24000;
  const maxSeconds = Math.min(45, Math.max(0.1, cachedAudioDuration(filePath)));
  const result = spawnSync(ffmpegBinary, [
    '-hide_banner',
    '-nostats',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-t', String(maxSeconds),
    '-f', 'f32le',
    'pipe:1',
  ], { timeout: 12000, maxBuffer: Math.ceil(sampleRate * maxSeconds * 4) + 128 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) return null;

  const samples = new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
  const peakCount = 96;
  const peaks = [];
  let globalPeak = 0.0001;
  for (let bucket = 0; bucket < peakCount; bucket += 1) {
    const start = Math.floor((bucket / peakCount) * samples.length);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) / peakCount) * samples.length));
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
    if (peak > globalPeak) globalPeak = peak;
  }
  const metrics = {
    peaks: peaks.map((peak) => Math.min(1, Math.pow(peak / globalPeak, 0.72))),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  waveformCache.set(filePath, metrics);
  return metrics;
}

function analyzeAudioLoudness(filePath) {
  if (!ffmpegBinary || !existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const cached = loudnessCache.get(filePath);
  if (loudnessCacheIsFresh(filePath, cached)) return cached;

  const result = spawnSync(ffmpegBinary, [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 512 });
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const meanMatch = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(text);
  const maxMatch = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(text);
  if (!meanMatch || !maxMatch) return null;
  const meanVolumeDb = Number(meanMatch[1]);
  const maxVolumeDb = Number(maxMatch[1]);
  if (!Number.isFinite(meanVolumeDb) || !Number.isFinite(maxVolumeDb)) return null;
  const gain = computeGain(meanVolumeDb, maxVolumeDb);
  const metrics = {
    meanVolumeDb,
    maxVolumeDb,
    gainDb: gain.gainDb,
    gainLinear: gain.gainLinear,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  loudnessCache.set(filePath, metrics);
  return metrics;
}

function cachedLoudness(filePath) {
  const cached = loudnessCache.get(filePath);
  if (loudnessCacheIsFresh(filePath, cached)) {
    return {
      gainDb: cached.gainDb,
      gainLinear: cached.gainLinear,
      meanVolumeDb: cached.meanVolumeDb,
      maxVolumeDb: cached.maxVolumeDb,
      levelStatus: 'ready',
    };
  }
  return {
    gainDb: 0,
    gainLinear: 1,
    levelStatus: 'pending',
  };
}

function cachedOnset(filePath) {
  const cached = onsetCache.get(filePath);
  if (onsetCacheIsFresh(filePath, cached)) {
    return {
      onsetSeconds: cached.onsetSeconds,
      onsetStatus: 'ready',
    };
  }
  return {
    onsetSeconds: 0,
    onsetStatus: 'pending',
  };
}

function cachedWaveform(filePath) {
  const cached = waveformCache.get(filePath);
  if (waveformCacheIsFresh(filePath, cached)) {
    return {
      waveformPeaks: cached.peaks,
      waveformStatus: 'ready',
    };
  }
  return {
    waveformPeaks: [],
    waveformStatus: 'pending',
  };
}

function scheduleDurationProbe(filePaths) {
  const missing = filePaths.filter((filePath) => !durationCache.has(filePath));
  if (durationProbeRunning || missing.length === 0 || !ffprobeBinary) return;
  durationProbeRunning = true;
  const queue = [...missing];
  let processedSinceSave = 0;
  const pump = () => {
    try {
      const batch = queue.splice(0, 3);
      for (const filePath of batch) {
        if (durationCache.has(filePath)) continue;
        audioDuration(filePath);
        processedSinceSave += 1;
      }
      if (processedSinceSave >= 24 || queue.length === 0) {
        saveDurationCache();
        processedSinceSave = 0;
      }
      if (queue.length > 0) {
        setTimeout(pump, 35);
        return;
      }
    } finally {
      if (queue.length === 0) durationProbeRunning = false;
    }
  };
  setTimeout(pump, 80);
}

function scheduleLoudnessProbe(filePaths) {
  const missing = filePaths.filter((filePath) => !loudnessCacheIsFresh(filePath, loudnessCache.get(filePath)));
  if (loudnessProbeRunning || missing.length === 0 || !ffmpegBinary) return;
  loudnessProbeRunning = true;
  const queue = [...missing];
  let processedSinceSave = 0;
  const pump = () => {
    try {
      const batch = queue.splice(0, 2);
      for (const filePath of batch) {
        analyzeAudioLoudness(filePath);
        processedSinceSave += 1;
      }
      if (processedSinceSave >= 16 || queue.length === 0) {
        saveLoudnessCache();
        processedSinceSave = 0;
      }
      if (queue.length > 0) {
        setTimeout(pump, 45);
        return;
      }
    } finally {
      if (queue.length === 0) loudnessProbeRunning = false;
    }
  };
  setTimeout(pump, 60);
}

function scheduleOnsetProbe(filePaths) {
  const missing = filePaths.filter((filePath) => !onsetCacheIsFresh(filePath, onsetCache.get(filePath)));
  if (onsetProbeRunning || missing.length === 0 || !ffmpegBinary) return;
  onsetProbeRunning = true;
  const queue = [...missing];
  let processedSinceSave = 0;
  const pump = () => {
    try {
      const batch = queue.splice(0, 2);
      for (const filePath of batch) {
        analyzeAudioOnset(filePath);
        processedSinceSave += 1;
      }
      if (processedSinceSave >= 16 || queue.length === 0) {
        saveOnsetCache();
        processedSinceSave = 0;
      }
      if (queue.length > 0) {
        setTimeout(pump, 45);
        return;
      }
    } finally {
      if (queue.length === 0) onsetProbeRunning = false;
    }
  };
  setTimeout(pump, 80);
}

function scheduleWaveformProbe(filePaths) {
  const missing = filePaths.filter((filePath) => !waveformCacheIsFresh(filePath, waveformCache.get(filePath)));
  if (waveformProbeRunning || missing.length === 0 || !ffmpegBinary) return;
  waveformProbeRunning = true;
  const queue = [...missing];
  let processedSinceSave = 0;
  const pump = () => {
    try {
      const batch = queue.splice(0, 2);
      for (const filePath of batch) {
        analyzeAudioWaveform(filePath);
        processedSinceSave += 1;
      }
      if (processedSinceSave >= 16 || queue.length === 0) {
        saveWaveformCache();
        processedSinceSave = 0;
      }
      if (queue.length > 0) {
        setTimeout(pump, 45);
        return;
      }
    } finally {
      if (queue.length === 0) waveformProbeRunning = false;
    }
  };
  setTimeout(pump, 100);
}

function scanLibrary() {
  if (!existsSync(libraryRoot)) return { root: libraryRoot, categories: [] };
  const queues = {
    uncachedFiles: [],
    unleveledFiles: [],
    onsetPendingFiles: [],
    waveformPendingFiles: [],
    ready: 0,
    total: 0,
  };
  const categoryNames = readdirSync(libraryRoot)
    .filter((name) => {
      const path = join(libraryRoot, name);
      return statSync(path).isDirectory();
    })
    .sort((a, b) => a.localeCompare(b));

  const categories = categoryNames.map((name, categoryIndex) => {
    const categoryPath = join(libraryRoot, name);
    const files = readdirSync(categoryPath)
      .filter((fileName) => audioExtensions.has(extname(fileName).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((fileName) => {
        const filePath = join(categoryPath, fileName);
        const relativeKey = `${name}/${fileName}`;
        return filePayload(filePath, fileName, name, relativeKey, queues);
      });
    return {
      id: name,
      name: displayName(name),
      path: categoryPath,
      color: categoryColors[categoryIndex % categoryColors.length],
      files,
    };
  });

  const recordScratchFiles = collectRecordScratchFiles(queues);
  if (recordScratchFiles.length > 0) {
    categories.push({
      id: recordScratchCategoryId,
      name: 'Record Scratch',
      path: manualRoot,
      color: '#ff5f7e',
      files: recordScratchFiles,
    });
  }

  scheduleDurationProbe(queues.uncachedFiles);
  scheduleLoudnessProbe(queues.unleveledFiles);
  scheduleOnsetProbe(queues.onsetPendingFiles);
  scheduleWaveformProbe(queues.waveformPendingFiles);
  return {
    root: libraryRoot,
    leveling: {
      ready: queues.ready,
      total: queues.total,
      pending: Math.max(0, queues.total - queues.ready),
      targetMeanDb,
    },
    categories,
  };
}

function isRecordScratchPath(filePath) {
  const haystack = [
    basename(filePath),
    relative(manualRoot, filePath),
  ].join(' ').toLowerCase();
  return haystack.includes('record scratch')
    || haystack.includes('record-scratch')
    || haystack.includes('record_scratch');
}

function collectRecordScratchFiles(queues) {
  if (!existsSync(manualRoot)) return [];
  const found = [];
  const scan = (folderPath) => {
    const entries = readdirSync(folderPath, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
    for (const entry of entries) {
      const entryPath = join(folderPath, entry.name);
      if (entry.isDirectory()) {
        scan(entryPath);
      } else if (entry.isFile() && audioExtensions.has(extname(entry.name).toLowerCase()) && isRecordScratchPath(entryPath)) {
        found.push({ filePath: entryPath, fileName: entry.name });
      }
    }
  };
  scan(manualRoot);
  return found
    .sort((a, b) => relative(manualRoot, a.filePath).localeCompare(relative(manualRoot, b.filePath), undefined, { numeric: true }))
    .map(({ filePath, fileName }) => filePayload(
      filePath,
      fileName,
      recordScratchCategoryId,
      `record-scratch/${relative(manualRoot, filePath)}`,
      queues,
    ));
}

function filePayload(filePath, fileName, categoryId, relativeKey, queues) {
  if (!durationCache.has(filePath)) queues.uncachedFiles.push(filePath);
  const level = cachedLoudness(filePath);
  const onset = cachedOnset(filePath);
  const waveform = cachedWaveform(filePath);
  const readyForUse = level.levelStatus === 'ready' && onset.onsetStatus === 'ready';
  if (level.levelStatus !== 'ready') queues.unleveledFiles.push(filePath);
  if (onset.onsetStatus !== 'ready') queues.onsetPendingFiles.push(filePath);
  if (waveform.waveformStatus !== 'ready') queues.waveformPendingFiles.push(filePath);
  queues.total += 1;
  if (readyForUse) queues.ready += 1;
  return {
    id: stableId(relativeKey),
    categoryId,
    name: basename(fileName, extname(fileName)),
    path: filePath,
    duration: cachedAudioDuration(filePath),
    onsetSeconds: onset.onsetSeconds,
    waveformPeaks: waveform.waveformPeaks,
    ...level,
    levelStatus: readyForUse ? 'ready' : 'pending',
  };
}

function scanManualLibrary() {
  const queues = {
    uncachedFiles: [],
    unleveledFiles: [],
    onsetPendingFiles: [],
    waveformPendingFiles: [],
    ready: 0,
    total: 0,
  };

  const scanFolder = (folderPath, folderIndex = 0) => {
    const relativePath = relative(manualRoot, folderPath);
    const folderKey = relativePath && relativePath !== '' ? relativePath : basename(manualRoot);
    const entries = existsSync(folderPath)
      ? readdirSync(folderPath, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'))
      : [];
    const files = entries
      .filter((entry) => entry.isFile() && audioExtensions.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((entry) => {
        const filePath = join(folderPath, entry.name);
        const fileRelativePath = relative(manualRoot, filePath);
        return filePayload(filePath, entry.name, `manual:${folderKey}`, `manual/${fileRelativePath}`, queues);
      });
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((entry, index) => scanFolder(join(folderPath, entry.name), folderIndex + index + 1));

    return {
      id: stableId(`manual-folder/${folderKey}`),
      name: relativePath ? displayName(basename(folderPath)) : 'Manual SFX',
      path: folderPath,
      relativePath,
      color: categoryColors[Math.abs(stableId(folderKey).charCodeAt(0) + folderIndex) % categoryColors.length],
      files,
      folders,
    };
  };

  const folders = existsSync(manualRoot) ? [scanFolder(manualRoot)] : [];
  scheduleDurationProbe(queues.uncachedFiles);
  scheduleLoudnessProbe(queues.unleveledFiles);
  scheduleOnsetProbe(queues.onsetPendingFiles);
  scheduleWaveformProbe(queues.waveformPendingFiles);

  return {
    root: manualRoot,
    leveling: {
      ready: queues.ready,
      total: queues.total,
      pending: Math.max(0, queues.total - queues.ready),
      targetMeanDb,
    },
    folders,
  };
}

function defaultProject(mediaPath = '') {
  const probe = mediaPath ? mediaProbe(mediaPath) : { duration: 60, fps: 30, sampleRate: 48000 };
  const zoomXmlPath = autoZoomXmlPath(mediaPath);
  const zoomMarkers = parseZoomMarkers(zoomXmlPath);
  const markerDuration = zoomMarkers.at(-1)?.endSeconds;
  return {
    version: 1,
    name: mediaPath ? `${basename(mediaPath, extname(mediaPath))} SFX` : 'Live SFX Project',
    sourceMediaPath: mediaPath,
    outputDir,
    libraryRoot,
    manualRoot,
    fps: probe.fps || 30,
    duration: Math.max(probe.duration || 60, markerDuration || 0),
    sampleRate: 48000,
    zoomXmlPath,
    zoomMarkers,
    reactionOffsetFrames: 5,
    maxPlaybackRate: 1.4,
    masterGainDb: -12,
    savedPlayheadSeconds: 0,
    projectFilePath: explicitProjectFile || undefined,
    events: [],
    decks: {},
  };
}

function applyLaunchMedia(project) {
  if (!initialMedia || (project.sourceMediaPath && project.sourceMediaPath !== initialMedia)) return project;
  const probe = mediaProbe(initialMedia);
  const zoomXmlPath = explicitZoomXml || project.zoomXmlPath || autoZoomXmlPath(initialMedia);
  const zoomMarkers = parseZoomMarkers(zoomXmlPath);
  const markerDuration = zoomMarkers.at(-1)?.endSeconds;
  const projectName = project.name && project.name !== 'Live SFX Project'
    ? project.name
    : `${basename(initialMedia, extname(initialMedia))} SFX`;
  const resolvedDuration = Math.max(Number(project.duration) || 0, probe.duration || 60, markerDuration || 0);
  return {
    ...project,
    sourceMediaPath: initialMedia,
    name: projectName,
    outputDir,
    libraryRoot,
    manualRoot,
    fps: probe.fps || 30,
    duration: resolvedDuration,
    sampleRate: 48000,
    zoomXmlPath,
    zoomMarkers,
    masterGainDb: Number.isFinite(Number(project.masterGainDb)) ? Number(project.masterGainDb) : -12,
    projectFilePath: project.projectFilePath || explicitProjectFile || undefined,
  };
}

function ensureProject() {
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(projectPath)) {
    const nextProject = defaultProject(initialMedia);
    atomicWriteJson(projectPath, nextProject);
    if (nextProject.projectFilePath) writeSFXProjectFile(nextProject, projectPath);
  } else if (initialMedia) {
    const existing = JSON.parse(readFileSync(projectPath, 'utf8'));
    const probe = mediaProbe(initialMedia);
    const mediaChanged = existing.sourceMediaPath !== initialMedia;
    const zoomXmlPath = explicitZoomXml || (!mediaChanged ? existing.zoomXmlPath : '') || autoZoomXmlPath(initialMedia);
    const zoomMarkers = parseZoomMarkers(zoomXmlPath);
    const markerDuration = zoomMarkers.at(-1)?.endSeconds;
    const nextProject = existing.sourceMediaPath !== initialMedia
      ? {
	        ...existing,
	        sourceMediaPath: initialMedia,
	        name: `${basename(initialMedia, extname(initialMedia))} SFX`,
	        outputDir,
	        libraryRoot,
	        manualRoot,
	        fps: probe.fps || 30,
        duration: Math.max(probe.duration || 60, markerDuration || 0),
        sampleRate: 48000,
        zoomXmlPath,
        zoomMarkers,
      }
      : applyLaunchMedia(existing);
    if (
      nextProject.sourceMediaPath !== existing.sourceMediaPath
      || nextProject.name !== existing.name
      || nextProject.outputDir !== existing.outputDir
      || nextProject.libraryRoot !== existing.libraryRoot
      || nextProject.manualRoot !== existing.manualRoot
      || nextProject.fps !== existing.fps
      || nextProject.duration !== existing.duration
      || nextProject.sampleRate !== existing.sampleRate
      || nextProject.zoomXmlPath !== existing.zoomXmlPath
      || nextProject.projectFilePath !== existing.projectFilePath
      || JSON.stringify(nextProject.zoomMarkers || []) !== JSON.stringify(existing.zoomMarkers || [])
    ) {
      writeProject(nextProject, { backup: false });
    }
  } else if (explicitProjectFile) {
    const existing = JSON.parse(readFileSync(projectPath, 'utf8'));
    if (existing.projectFilePath !== explicitProjectFile) {
      writeProject({ ...existing, projectFilePath: explicitProjectFile }, { backup: false });
    }
  }
}

function readProject() {
  if (!existsSync(projectPath)) return defaultProject(initialMedia);
  return applyLaunchMedia(JSON.parse(readFileSync(projectPath, 'utf8')));
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function backupTimestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
}

function writeProject(project, options = {}) {
  const existingProject = existsSync(projectPath)
    ? JSON.parse(readFileSync(projectPath, 'utf8'))
    : {};
  const projectToWrite = applyLaunchMedia({
    ...project,
    projectFilePath: project.projectFilePath || existingProject.projectFilePath,
    projectLauncherPath: project.projectLauncherPath || existingProject.projectLauncherPath,
  });
  const createBackup = Boolean(options.backup);
  if (createBackup && existsSync(projectPath)) {
    const backupDir = join(dirname(projectPath), 'Live SFX Backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `live_sfx_project.${backupTimestamp()}.json`), readFileSync(projectPath));
  }
  atomicWriteJson(projectPath, projectToWrite);
  if (options.writeProjectFile || projectFileMatchesBackingProject(projectToWrite.projectFilePath, projectPath)) {
    writeSFXProjectFile(projectToWrite, projectPath);
  }
}

function ensureProjectFileExtension(filePath) {
  const trimmed = String(filePath || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith(projectFileExtension) ? trimmed : `${trimmed}${projectFileExtension}`;
}

function safeProjectFileName(value) {
  const base = String(value || 'Live SFX Project')
    .replace(/[/:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Live SFX Project';
  return `${base}${projectFileExtension}`;
}

function defaultProjectFileDirectory(project) {
  const projectOutputDir = resolve(String(project?.outputDir || outputDir));
  const outputName = basename(projectOutputDir).toLowerCase();
  if (outputName.includes('sfx project file')) return dirname(projectOutputDir);
  return projectOutputDir;
}

function chooseSFXProjectFilePath(project) {
  const defaultDir = defaultProjectFileDirectory(project);
  const defaultName = safeProjectFileName(project?.name || 'Live SFX Project');
  const script = [
    `set defaultFolder to POSIX file ${JSON.stringify(defaultDir)}`,
    `set chosenFile to choose file name with prompt "Save Live SFX project file" default name ${JSON.stringify(defaultName)} default location defaultFolder`,
    'return POSIX path of chosenFile',
  ].join('\n');
  const result = spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function sfxProjectIconPath() {
  const candidates = [
    join(root, 'electron', 'LiveSFXProject.icns'),
    '/Applications/Live SFX Editor.app/Contents/Resources/LiveSFXProject.icns',
    '/Applications/Command Center/Command Center.app/Contents/Resources/LiveSFXEditor/electron/LiveSFXProject.icns',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function sfxProjectIconPngPath() {
  const candidates = [
    join(root, 'electron', 'LiveSFXProject.iconset', 'icon_512x512.png'),
    '/Users/kyle/Documents/Command Center Project/LiveSFXEditor/electron/LiveSFXProject.iconset/icon_512x512.png',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function projectFileMatchesBackingProject(filePath, targetProjectPath) {
  const resolvedFilePath = ensureProjectFileExtension(filePath);
  if (!resolvedFilePath) return false;
  if (!existsSync(resolvedFilePath)) return true;
  try {
    const descriptor = JSON.parse(readFileSync(resolvedFilePath, 'utf8'));
    const descriptorProjectPath = descriptor?.projectPath ? resolve(String(descriptor.projectPath)) : '';
    if (!descriptorProjectPath) return true;
    return descriptorProjectPath === resolve(String(targetProjectPath));
  } catch {
    return true;
  }
}

function applySFXProjectFileIcon(filePath) {
  const iconPngPath = sfxProjectIconPngPath();
  if (!iconPngPath || !existsSync(filePath)) return;
  const tempIconPath = `/tmp/live-sfx-project-icon-${process.pid}.png`;
  const tempResourcePath = `/tmp/live-sfx-project-icon-${process.pid}.rsrc`;
  spawnSync('/bin/cp', [iconPngPath, tempIconPath], { stdio: 'ignore' });
  spawnSync('/usr/bin/sips', ['-i', tempIconPath], { stdio: 'ignore', timeout: 10000 });
  const derez = spawnSync('/usr/bin/DeRez', ['-only', 'icns', tempIconPath], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 512 * 1024,
  });
  if (derez.status === 0 && derez.stdout) {
    writeFileSync(tempResourcePath, derez.stdout, 'utf8');
    spawnSync('/usr/bin/Rez', ['-append', tempResourcePath, '-o', filePath], { stdio: 'ignore', timeout: 10000 });
  } else if (sfxProjectIconPath()) {
    // Type-level icon registration still gives Finder a proper document icon.
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', '/Applications/Live SFX Editor.app'], { stdio: 'ignore' });
  }
  spawnSync('/usr/bin/SetFile', ['-a', 'C', filePath], { stdio: 'ignore' });
}

function writeSFXProjectFile(project, targetProjectPath) {
  const filePath = ensureProjectFileExtension(project.projectFilePath);
  if (!filePath) return '';
  const descriptor = {
    kind: 'LiveSFXInterfaceProject',
    version: 1,
    name: project.name || 'Live SFX Project',
    projectPath: targetProjectPath,
    outputDir: project.outputDir || outputDir,
    mediaPath: project.sourceMediaPath || '',
    zoomXmlPath: project.zoomXmlPath || '',
    libraryRoot: project.libraryRoot || libraryRoot,
    manualRoot: project.manualRoot || manualRoot,
    fps: project.fps || 30,
    duration: project.duration || 60,
    sampleRate: project.sampleRate || 48000,
    savedPlayheadSeconds: project.savedPlayheadSeconds || 0,
    eventCount: Array.isArray(project.events) ? project.events.length : 0,
    zoomCount: Array.isArray(project.zoomMarkers) ? project.zoomMarkers.length : 0,
    projectSnapshot: project,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteJson(filePath, descriptor);
  applySFXProjectFileIcon(filePath);
  return filePath;
}

function shellQuote(value) {
  return `'${String(value || '').replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function safeDisplayFileName(value, fallback = 'Live SFX Project') {
  const name = String(value || fallback)
    .replace(/[/:]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
  return name.endsWith('.command') ? name : `${name}.command`;
}

function defaultLauncherFileName(project) {
  const mediaName = project?.sourceMediaPath ? basename(project.sourceMediaPath, extname(project.sourceMediaPath)) : '';
  return safeDisplayFileName(mediaName ? `${mediaName} Live SFX Project` : project?.name || 'Live SFX Project');
}

function defaultLauncherDir(project) {
  const candidates = [
    project?.sourceMediaPath ? dirname(project.sourceMediaPath) : '',
    project?.outputDir,
    outputDir,
    join(homedir(), 'Desktop'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(String(candidate))) || join(homedir(), 'Desktop');
}

function chooseProjectLauncherPath(project) {
  const defaultDir = defaultLauncherDir(project);
  const defaultName = defaultLauncherFileName(project);
  const result = spawnSync('osascript', [
    '-e', `set defaultLocation to POSIX file "${appleScriptString(defaultDir.endsWith('/') ? defaultDir : `${defaultDir}/`)}"`,
    '-e', `set chosenFile to choose file name with prompt "Save Live SFX project file" default name "${appleScriptString(defaultName)}" default location defaultLocation`,
    '-e', 'POSIX path of chosenFile',
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 });
  if (result.status === 0) return result.stdout.trim();
  const errorText = `${result.stderr || ''}${result.stdout || ''}`;
  if (errorText.includes('User canceled') || result.signal === 'SIGTERM') return '';
  throw new Error(errorText.trim() || 'Project file save dialog failed.');
}

function projectLauncherScript(project) {
  const launcherPath = '/Applications/Command Center/Command Center.app/Contents/Resources/LiveSFXEditor/scripts/launch-live-sfx.mjs';
  const nodePath = process.execPath || '/Applications/Codex.app/Contents/Resources/node';
  const args = [
    '--project', projectPath,
    '--output-dir', String(project.outputDir || outputDir),
    '--library-root', String(project.libraryRoot || libraryRoot),
    '--manual-root', String(project.manualRoot || manualRoot),
  ];
  if (project.sourceMediaPath) args.push('--media', String(project.sourceMediaPath));
  if (project.zoomXmlPath) args.push('--zoom-xml', String(project.zoomXmlPath));
  return [
    '#!/bin/zsh',
    'set -e',
    `NODE=${shellQuote(nodePath)}`,
    'if [[ ! -x "$NODE" ]]; then NODE="$(command -v node)"; fi',
    `exec "$NODE" ${shellQuote(launcherPath)} ${args.map(shellQuote).join(' ')}`,
    '',
  ].join('\n');
}

function writeProjectLauncher(project, requestedPath = '') {
  const launcherPath = requestedPath || chooseProjectLauncherPath(project);
  if (!launcherPath) return '';
  const finalPath = launcherPath.endsWith('.command') ? launcherPath : `${launcherPath}.command`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, projectLauncherScript(project), 'utf8');
  chmodSync(finalPath, 0o755);
  return finalPath;
}

function serveRange(req, res, filePath) {
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: 'Media not found', filePath });
    return;
  }
  const stat = statSync(filePath);
  const range = req.headers.range;
  const contentType = mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
  if (!range) {
    res.writeHead(200, {
      'content-length': stat.size,
      'content-type': contentType,
      'accept-ranges': 'bytes',
    });
    createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416);
    res.end();
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'content-type': contentType,
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

function ffmpegEscapeText(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function exportableEvents(project, duration) {
  return [...(project.events || [])]
    .filter((event) => {
      const startSeconds = Number(event.startSeconds);
      const durationSeconds = Number(event.duration);
      return event.filePath
        && existsSync(event.filePath)
        && Number.isFinite(startSeconds)
        && Number.isFinite(durationSeconds)
        && durationSeconds > 0.001
        && startSeconds < duration;
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

function isManualEvent(event) {
  const categoryId = String(event.categoryId || '').toLowerCase();
  const filePath = resolve(String(event.filePath || ''));
  return categoryId.startsWith('manual:') || filePath.startsWith(`${manualRoot}/`);
}

function isRecordScratchEvent(event) {
  if (String(event.categoryId || '').toLowerCase() === recordScratchCategoryId) return true;
  if (!isManualEvent(event)) return false;
  const filePath = resolve(String(event.filePath || ''));
  const haystack = [
    event.fileName,
    event.categoryName,
    basename(filePath),
    relative(manualRoot, filePath),
  ].join(' ').toLowerCase();
  return haystack.includes('record scratch')
    || haystack.includes('record-scratch')
    || haystack.includes('record_scratch');
}

function cleanupTempFiles(filePaths = []) {
  for (const filePath of filePaths) {
    try {
      if (filePath && existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // Temporary filter scripts are best-effort cleanup.
    }
  }
}

function runFfmpegExport(command, outputPath, cleanupPaths = []) {
  return new Promise((resolveRender, rejectRender) => {
    const child = spawn(ffmpegBinary, command, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    activeFfmpegChildren.add(child);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const settle = (error) => {
      if (settled) return;
      settled = true;
      activeFfmpegChildren.delete(child);
      cleanupTempFiles(cleanupPaths);
      if (error) {
        removePartialFile(outputPath);
        rejectRender(error);
        return;
      }
      resolveRender(outputPath);
    };

    child.once('error', (error) => {
      settle(error);
    });
    child.once('close', (code, signal) => {
      if (bridgeShuttingDown || signal === 'SIGTERM' || signal === 'SIGKILL') {
        settle(new Error('Export cancelled.'));
        return;
      }
      if (code !== 0) {
        settle(new Error(stderr || stdout || 'ffmpeg export failed'));
        return;
      }
      settle(null);
    });
  });
}

function clippedExportEvents(project, events, duration) {
  return exportableEvents({ events }, duration)
    .map((event, index) => {
      const startSeconds = Math.max(0, Number(event.startSeconds) || 0);
      const rawDuration = Math.max(0.001, Number(event.duration) || 0.001);
      const endSeconds = Math.min(duration, startSeconds + rawDuration);
      if (endSeconds <= startSeconds) return null;
      const rate = Math.min(1.4, Math.max(0.5, Number(event.playbackRate) || 1));
      return {
        ...event,
        exportIndex: index,
        startSeconds,
        endSeconds,
        duration: endSeconds - startSeconds,
        playbackRate: rate,
      };
    })
    .filter(Boolean);
}

function buildTimelineSegments(events, duration, sampleRate) {
  const minDuration = 1 / sampleRate;
  const boundaries = [0, duration];
  for (const event of events) {
    boundaries.push(Math.max(0, Math.min(duration, event.startSeconds)));
    boundaries.push(Math.max(0, Math.min(duration, event.endSeconds)));
  }
  const sortedBoundaries = [...new Set(boundaries
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= duration)
    .map((value) => Math.max(0, Math.min(duration, value)))
    .sort((a, b) => a - b))]
    .reduce((items, value) => {
      if (items.length === 0 || Math.abs(value - items.at(-1)) > minDuration) items.push(value);
      return items;
    }, []);

  const segments = [];
  const eventUses = new Map();
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    const segmentDuration = end - start;
    if (segmentDuration <= minDuration) continue;
    const activeEvents = events
      .map((event, eventIndex) => ({ event, eventIndex }))
      .filter(({ event }) => event.startSeconds < end - minDuration && event.endSeconds > start + minDuration);
    const segment = {
      index: segments.length,
      start,
      end,
      duration: segmentDuration,
      activeEvents,
    };
    for (const { event, eventIndex } of activeEvents) {
      const uses = eventUses.get(eventIndex) || [];
      uses.push({
        segmentIndex: segment.index,
        relativeStart: Math.max(0, start - event.startSeconds),
        duration: segmentDuration,
      });
      eventUses.set(eventIndex, uses);
    }
    segments.push(segment);
  }

  return { segments, eventUses };
}

function renderEmptyMp3(project, outputPath) {
  const duration = Math.max(0.1, Number(project.duration) || 60);
  const sampleRate = 48000;
  mkdirSync(dirname(outputPath), { recursive: true });
  return runFfmpegExport([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}:duration=${duration.toFixed(6)}`,
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    '-compression_level', '0',
    '-ar', String(sampleRate),
    '-ac', '2',
    outputPath,
  ], outputPath);
}

function renderMp3(project, events, outputPath) {
  if (!ffmpegBinary) {
    throw new Error('ffmpeg was not found. Install ffmpeg or add it to /opt/homebrew/bin.');
  }
  if (bridgeShuttingDown) {
    throw new Error('Export cancelled because Live SFX Editor is closing.');
  }
  const duration = Math.max(0.1, Number(project.duration) || 60);
  const sampleRate = 48000;
  const masterGainLinear = dbToLinear(Math.min(6, Math.max(-24, Number(project.masterGainDb ?? -12) || -12)));
  const renderEvents = clippedExportEvents(project, events, duration);
  mkdirSync(dirname(outputPath), { recursive: true });

  if (renderEvents.length === 0) return renderEmptyMp3(project, outputPath);

  const { segments, eventUses } = buildTimelineSegments(renderEvents, duration, sampleRate);
  if (segments.length === 0) return renderEmptyMp3(project, outputPath);

  const command = ['-y', '-hide_banner', '-loglevel', 'error'];
  renderEvents.forEach((event) => {
    const rate = Math.min(1.4, Math.max(0.5, Number(event.playbackRate) || 1));
    const sourceOffsetSeconds = Math.max(0, Number(event.sourceOffsetSeconds) || 0);
    const sourceDuration = Math.max(0.02, Number(event.duration) * rate + 0.08);
    command.push('-ss', sourceOffsetSeconds.toFixed(6), '-t', sourceDuration.toFixed(6), '-i', event.filePath);
  });

  const filterParts = [];
  const pieceLabels = new Map();
  renderEvents.forEach((event, index) => {
    const uses = eventUses.get(index) || [];
    const rate = Math.min(1.4, Math.max(0.5, Number(event.playbackRate) || 1));
    const eventGainLinear = Math.max(0.001, Math.min(8, Number(event.gainLinear) || dbToLinear(Number(event.gainDb) || 0)));
    const gainLinear = eventGainLinear * masterGainLinear;
    const adjustedRate = Math.max(1, Math.round(sampleRate * rate));
    const eventLabel = `[ev${index}]`;
    filterParts.push(
      `[${index}:a]aformat=channel_layouts=stereo,aresample=${sampleRate},asetrate=${adjustedRate},aresample=${sampleRate},volume=${gainLinear.toFixed(6)},atrim=0:${event.duration.toFixed(6)},asetpts=PTS-STARTPTS${eventLabel}`,
    );

    if (uses.length <= 1) {
      if (uses[0]) pieceLabels.set(`${index}:0`, eventLabel);
      return;
    }

    const splitLabels = uses.map((_, useIndex) => `[ev${index}p${useIndex}]`);
    filterParts.push(`${eventLabel}asplit=${uses.length}${splitLabels.join('')}`);
    splitLabels.forEach((label, useIndex) => {
      pieceLabels.set(`${index}:${useIndex}`, label);
    });
  });

  const segmentLabels = [];
  const eventUseCursor = new Map();
  for (const segment of segments) {
    const segmentLabel = `[seg${segment.index}]`;
    segmentLabels.push(segmentLabel);
    if (segment.activeEvents.length === 0) {
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=${sampleRate}:d=${segment.duration.toFixed(6)},asetpts=PTS-STARTPTS${segmentLabel}`);
      continue;
    }

    const activeLabels = [];
    for (const { eventIndex } of segment.activeEvents) {
      const useIndex = eventUseCursor.get(eventIndex) || 0;
      eventUseCursor.set(eventIndex, useIndex + 1);
      const sourceLabel = pieceLabels.get(`${eventIndex}:${useIndex}`) || `[ev${eventIndex}]`;
      const use = (eventUses.get(eventIndex) || [])[useIndex];
      const activeLabel = `[seg${segment.index}e${activeLabels.length}]`;
      filterParts.push(
        `${sourceLabel}atrim=start=${Math.max(0, use?.relativeStart || 0).toFixed(6)}:duration=${segment.duration.toFixed(6)},asetpts=PTS-STARTPTS,apad,atrim=0:${segment.duration.toFixed(6)}${activeLabel}`,
      );
      activeLabels.push(activeLabel);
    }

    if (activeLabels.length === 1) {
      filterParts.push(`${activeLabels[0]}anull${segmentLabel}`);
    } else {
      filterParts.push(`${activeLabels.join('')}amix=inputs=${activeLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=0:${segment.duration.toFixed(6)},asetpts=PTS-STARTPTS${segmentLabel}`);
    }
  }

  if (segmentLabels.length === 1) {
    filterParts.push(`${segmentLabels[0]}anull[out]`);
  } else {
    filterParts.push(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=0:a=1[out]`);
  }

  const filterScriptPath = `${outputPath}.filter-${process.pid}-${Date.now()}.txt`;
  writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf8');

  command.push(
    '-filter_complex_script', filterScriptPath,
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    '-compression_level', '0',
    '-ar', String(sampleRate),
    '-ac', '2',
    outputPath,
  );

  return runFfmpegExport(command, outputPath, [filterScriptPath]);
}

function renderMasterFromStemMp3s(project, stemFiles, outputPath) {
  if (!ffmpegBinary) {
    throw new Error('ffmpeg was not found. Install ffmpeg or add it to /opt/homebrew/bin.');
  }
  if (bridgeShuttingDown) {
    throw new Error('Export cancelled because Live SFX Editor is closing.');
  }
  const duration = Math.max(0.1, Number(project.duration) || 60);
  const sampleRate = 48000;
  const mixInputs = stemFiles.filter((file) => Number(file.eventCount) > 0 && existsSync(file.outputPath));
  if (mixInputs.length === 0) {
    return renderEmptyMp3(project, outputPath);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const command = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const file of mixInputs) command.push('-i', file.outputPath);

  const labels = [];
  const filterParts = mixInputs.map((_, index) => {
    const label = `[stem${index}]`;
    labels.push(label);
    return `[${index}:a]aformat=channel_layouts=stereo,aresample=${sampleRate}${label}`;
  });
  filterParts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=0:${duration.toFixed(6)},asetpts=PTS-STARTPTS[out]`);

  command.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    '-compression_level', '0',
    '-ar', String(sampleRate),
    '-ac', '2',
    outputPath,
  );

  return runFfmpegExport(command, outputPath);
}

function createExportPlan(project, explicitOutputDir = '') {
  const duration = Math.max(0.1, Number(project.duration) || 60);
  const allEvents = exportableEvents(project, duration);
  const projectStem = safeFileStem(project.name || 'live_sfx_project');
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
  const packageDir = explicitOutputDir
    ? resolve(String(explicitOutputDir))
    : join(String(project.outputDir || outputDir), 'Live SFX Stem Exports', `${projectStem}_${timestamp}`);
  const categories = scanLibrary().categories;
  const stemCategories = categories.filter((category) => category.id !== recordScratchCategoryId);
  const stems = [];

  stemCategories.forEach((category, index) => {
    const events = allEvents.filter((event) => !isManualEvent(event) && String(event.categoryId || '').toLowerCase() === category.id.toLowerCase());
    const fileName = `${String(index + 1).padStart(2, '0')}_${safeFileStem(category.name)}_stem.mp3`;
    stems.push({
      index,
      kind: 'stem',
      id: category.id,
      label: category.name,
      fileName,
      outputPath: join(packageDir, fileName),
      eventCount: events.length,
      events,
    });
  });

  const recordScratchEvents = allEvents.filter(isRecordScratchEvent);
  const manualEvents = allEvents.filter((event) => isManualEvent(event) && !isRecordScratchEvent(event));
  const manualFileName = `${String(stemCategories.length + 1).padStart(2, '0')}_manual_sfx_stem.mp3`;
  stems.push({
    index: stemCategories.length,
    kind: 'stem',
    id: 'manual_sfx',
    label: 'Manual SFX',
    fileName: manualFileName,
    outputPath: join(packageDir, manualFileName),
    eventCount: manualEvents.length,
    events: manualEvents,
  });

  const recordScratchFileName = `${String(stemCategories.length + 2).padStart(2, '0')}_record_scratch_stem.mp3`;
  stems.push({
    index: stemCategories.length + 1,
    kind: 'stem',
    id: 'record_scratch',
    label: 'Record Scratch',
    fileName: recordScratchFileName,
    outputPath: join(packageDir, recordScratchFileName),
    eventCount: recordScratchEvents.length,
    events: recordScratchEvents,
  });

  const masterFileName = `${projectStem}_master.mp3`;
  return {
    allEvents,
    master: {
      kind: 'master',
      id: 'master',
      label: 'Master SFX',
      fileName: masterFileName,
      outputPath: join(packageDir, masterFileName),
      eventCount: allEvents.length,
    },
    outputDir: packageDir,
    stems,
  };
}

function exportFilePayload(file) {
  return {
    kind: file.kind,
    id: file.id,
    label: file.label,
    fileName: file.fileName,
    outputPath: file.outputPath,
    eventCount: file.eventCount,
  };
}

async function exportAudioPackage(project, options = {}) {
  const plan = options.plan || createExportPlan(project);
  mkdirSync(plan.outputDir, { recursive: true });

  const completedStems = [];
  const renderOrder = [...plan.stems].sort((a, b) => (
    a.eventCount - b.eventCount
    || a.index - b.index
  ));
  let cursor = 0;

  const renderNextStem = async () => {
    while (cursor < renderOrder.length) {
      if (options.isCancelled?.()) throw new Error('Export cancelled.');
      const stem = renderOrder[cursor];
      cursor += 1;
      options.onFileStart?.(exportFilePayload(stem));
      await renderMp3(project, stem.events, stem.outputPath);
      const payload = exportFilePayload(stem);
      completedStems.push(payload);
      options.onFile?.(payload);
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(stemRenderConcurrency, renderOrder.length) },
        () => renderNextStem(),
      ),
    );
  } catch (error) {
    stopActiveFfmpeg('SIGTERM');
    throw error;
  }

  if (options.isCancelled?.()) throw new Error('Export cancelled.');
  options.onFileStart?.(exportFilePayload(plan.master));
  await renderMasterFromStemMp3s(project, completedStems, plan.master.outputPath);
  const master = exportFilePayload(plan.master);
  options.onFile?.(master);

  const files = [
    master,
    ...completedStems.sort((a, b) => a.fileName.localeCompare(b.fileName)),
  ];

  return {
    outputPath: master.outputPath,
    outputDir: plan.outputDir,
    files,
  };
}

function publicExportJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    outputDir: job.outputDir,
    outputPath: job.outputPath || '',
    totalFiles: job.totalFiles,
    files: job.files,
    error: job.error || '',
    currentFileName: job.currentFileName || '',
    currentLabel: job.currentLabel || '',
  };
}

function startExportJob(project, explicitOutputDir = '') {
  const plan = createExportPlan(project, explicitOutputDir);
  const id = stableId(`${Date.now()}-${Math.random()}-${plan.outputDir}`);
  const job = {
    id,
    status: 'running',
    outputDir: plan.outputDir,
    outputPath: '',
    totalFiles: plan.stems.length + 1,
    files: [],
    error: '',
    currentFileName: '',
    currentLabel: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  exportJobs.set(id, job);

  void exportAudioPackage(project, {
    plan,
    isCancelled: () => job.status === 'cancelled',
    onFileStart: (file) => {
      if (job.status === 'cancelled') return;
      job.currentFileName = file.fileName;
      job.currentLabel = file.label;
      job.updatedAt = Date.now();
    },
    onFile: (file) => {
      if (job.status === 'cancelled') return;
      job.files = [...job.files.filter((item) => item.fileName !== file.fileName), file];
      job.currentFileName = '';
      job.currentLabel = '';
      job.updatedAt = Date.now();
    },
  }).then((result) => {
    if (job.status === 'cancelled') return;
    job.status = 'done';
    job.outputPath = result.outputPath;
    job.outputDir = result.outputDir;
    job.files = result.files;
    job.updatedAt = Date.now();
  }).catch((error) => {
    if (job.status === 'cancelled') return;
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = Date.now();
  });

  return job;
}

function defaultExportFolder(project) {
  const candidates = [
    project?.lastExportPath,
    project?.sourceMediaPath ? join(dirname(project.sourceMediaPath), 'STEMS') : '',
    project?.outputDir,
    outputDir,
    join(homedir(), 'Desktop'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(String(candidate))) || join(homedir(), 'Desktop');
}

function chooseExportFolder(project) {
  const defaultDir = defaultExportFolder(project);
  const result = spawnSync('osascript', [
    '-e', `set defaultLocation to POSIX file "${appleScriptString(defaultDir.endsWith('/') ? defaultDir : `${defaultDir}/`)}"`,
    '-e', 'set chosenFolder to choose folder with prompt "Choose Live SFX export folder" default location defaultLocation',
    '-e', 'POSIX path of chosenFolder',
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 });
  if (result.status === 0) return resolve(result.stdout.trim());
  const errorText = `${result.stderr || ''}${result.stdout || ''}`;
  if (errorText.includes('User canceled') || result.signal === 'SIGTERM') return '';
  throw new Error(errorText.trim() || 'Export folder dialog failed.');
}

function safeFileStem(value) {
  return String(value || 'live_sfx_project')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'live_sfx_project';
}

function serveStatic(url, res) {
  const rawPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const safePath = rawPath.replace(/^\/+/, '').replaceAll('..', '');
  let filePath = join(distRoot, safePath);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distRoot, 'index.html');
  }
  if (!existsSync(filePath)) {
    sendJson(res, 500, { error: 'Live SFX Editor dist is missing. Run npm run build first.', distRoot });
    return;
  }
  const data = readFileSync(filePath);
  res.writeHead(200, {
    'content-type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(data);
}

ensureProject();
loadDurationCache();
loadLoudnessCache();
loadOnsetCache();
loadWaveformCache();

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/library') {
    sendJson(res, 200, scanLibrary());
    return;
  }
  if (url.pathname === '/api/manual-library') {
    sendJson(res, 200, scanManualLibrary());
    return;
  }
  if (url.pathname === '/api/project') {
    sendJson(res, 200, readProject());
    return;
  }
  if (url.pathname === '/api/media') {
    serveRange(req, res, resolve(url.searchParams.get('path') || ''));
    return;
  }
  if (url.pathname === '/api/media-source' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const mediaPath = resolve(String(payload.path || ''));
      if (!existsSync(mediaPath)) throw new Error(`Media does not exist: ${mediaPath}`);
      const current = readProject();
      const probe = mediaProbe(mediaPath);
      const zoomXmlPath = autoZoomXmlPath(mediaPath);
      const zoomMarkers = parseZoomMarkers(zoomXmlPath);
      const markerDuration = zoomMarkers.at(-1)?.endSeconds;
      const nextProject = {
        ...current,
        name: `${basename(mediaPath, extname(mediaPath))} SFX`,
        sourceMediaPath: mediaPath,
        fps: probe.fps,
        duration: Math.max(probe.duration, markerDuration || 0),
        sampleRate: 48000,
        zoomXmlPath,
        zoomMarkers,
        savedPlayheadSeconds: 0,
      };
      writeProject(nextProject, { backup: true });
      sendJson(res, 200, nextProject);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/zoom-source' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const zoomXmlPath = resolve(String(payload.path || ''));
      if (!existsSync(zoomXmlPath)) throw new Error(`Zoom XML does not exist: ${zoomXmlPath}`);
      const current = readProject();
      const zoomMarkers = parseZoomMarkers(zoomXmlPath);
      const markerDuration = zoomMarkers.at(-1)?.endSeconds;
      const nextProject = {
        ...current,
        duration: Math.max(Number(current.duration) || 60, markerDuration || 0),
        zoomXmlPath,
        zoomMarkers,
      };
      writeProject(nextProject, { backup: true });
      sendJson(res, 200, nextProject);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/save-project' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      writeProject(project, { backup: Boolean(payload.createBackup) });
      sendJson(res, 200, { ok: true, projectPath });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/save-project-file' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      const chosenPath = payload.path
        ? resolve(String(payload.path))
        : project.projectFilePath
          ? resolve(String(project.projectFilePath))
          : chooseSFXProjectFilePath(project);
      if (!chosenPath) {
        sendJson(res, 200, { ok: false, cancelled: true });
        return;
      }
      const projectFilePath = ensureProjectFileExtension(chosenPath);
      const nextProject = {
        ...project,
        outputDir: project.outputDir || outputDir,
        libraryRoot: project.libraryRoot || libraryRoot,
        manualRoot: project.manualRoot || manualRoot,
        projectFilePath,
      };
      writeProject(nextProject, { backup: Boolean(payload.createBackup), writeProjectFile: true });
      sendJson(res, 200, { ok: true, projectPath, projectFilePath, project: nextProject });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/sfx-automation-v1' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : readProject();
      const regionStart = Number(payload.regionStart);
      const regionEnd = Number(payload.regionEnd);
      const result = generateSFXPass(project, {
        seed: payload.seed || 'sfx-v1',
        scorer: payload.scorer || 'local',
        packRoot: payload.packRoot,
        region: {
          start: Number.isFinite(regionStart) ? regionStart : undefined,
          end: Number.isFinite(regionEnd) ? regionEnd : undefined,
        },
      });
      if (result.stats.generatedEvents > 0) {
        writeProject(result.project, { backup: payload.createBackup !== false });
      }
      sendJson(res, 200, { ok: true, project: result.project, stats: result.stats });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/save-project-launcher' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      const requestedPath = payload.path ? resolve(String(payload.path)) : '';
      const launcherPath = requestedPath || project.projectLauncherPath || chooseProjectLauncherPath(project);
      if (!launcherPath) {
        sendJson(res, 200, { ok: false, cancelled: true });
        return;
      }
      const finalLauncherPath = writeProjectLauncher(project, launcherPath);
      const nextProject = {
        ...project,
        outputDir: project.outputDir || outputDir,
        libraryRoot: project.libraryRoot || libraryRoot,
        manualRoot: project.manualRoot || manualRoot,
        projectLauncherPath: finalLauncherPath,
      };
      writeProject(nextProject, { backup: Boolean(payload.createBackup) });
      sendJson(res, 200, { ok: true, projectPath, projectLauncherPath: finalLauncherPath, project: nextProject });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/choose-export-folder' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      const folderPath = chooseExportFolder(project);
      if (!folderPath) {
        sendJson(res, 200, { ok: false, cancelled: true });
        return;
      }
      sendJson(res, 200, { ok: true, folderPath });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/export-audio-job' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      const explicitOutputDir = payload.exportDir ? resolve(String(payload.exportDir)) : '';
      const job = startExportJob(project, explicitOutputDir);
      sendJson(res, 200, { ok: true, ...publicExportJob(job) });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (url.pathname === '/api/export-audio-job' && req.method === 'GET') {
    const jobId = String(url.searchParams.get('id') || '');
    const job = exportJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Export job not found.' });
      return;
    }
    sendJson(res, 200, { ok: true, ...publicExportJob(job) });
    return;
  }
  if (url.pathname === '/api/export-audio-job' && req.method === 'DELETE') {
    const jobId = String(url.searchParams.get('id') || '');
    const job = exportJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Export job not found.' });
      return;
    }
    job.status = 'cancelled';
    job.error = 'Export cancelled.';
    job.updatedAt = Date.now();
    stopActiveFfmpeg('SIGTERM');
    setTimeout(() => stopActiveFfmpeg('SIGKILL'), 300).unref();
    sendJson(res, 200, { ok: true, ...publicExportJob(job) });
    return;
  }
  if ((url.pathname === '/api/export-audio' || url.pathname === '/api/export-wav') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const project = payload.project && typeof payload.project === 'object' ? payload.project : payload;
      const explicitOutputDir = payload.exportDir ? resolve(String(payload.exportDir)) : '';
      const plan = explicitOutputDir ? createExportPlan(project, explicitOutputDir) : undefined;
      const exportResult = await exportAudioPackage(project, { plan });
      sendJson(res, 200, { ok: true, ...exportResult });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  serveStatic(url, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Live SFX Editor bridge: http://127.0.0.1:${port}`);
  console.log(`Project: ${projectPath}`);
  console.log(`Library: ${libraryRoot}`);
});

function shutdownBridge(signal = 'SIGTERM') {
  if (bridgeShuttingDown) return;
  bridgeShuttingDown = true;
  stopActiveFfmpeg('SIGTERM');
  setTimeout(() => {
    stopActiveFfmpeg('SIGKILL');
  }, 300).unref();
  server.close(() => {
    process.exit(signal === 'SIGINT' ? 130 : 0);
  });
  setTimeout(() => {
    process.exit(signal === 'SIGINT' ? 130 : 0);
  }, 800).unref();
}

process.once('SIGTERM', () => shutdownBridge('SIGTERM'));
process.once('SIGINT', () => shutdownBridge('SIGINT'));
process.once('SIGHUP', () => shutdownBridge('SIGHUP'));
process.once('beforeExit', () => {
  bridgeShuttingDown = true;
  stopActiveFfmpeg('SIGTERM');
});
process.once('exit', () => {
  bridgeShuttingDown = true;
  stopActiveFfmpeg('SIGKILL');
});
