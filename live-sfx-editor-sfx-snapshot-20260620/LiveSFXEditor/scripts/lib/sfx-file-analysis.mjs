import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

const targetMeanDb = -18;

export function resolveBinary(name) {
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

const ffprobeBinary = resolveBinary('ffprobe');
const ffmpegBinary = resolveBinary('ffmpeg');

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function sha256Buffer(buffer, prefix = '') {
  const hash = createHash('sha256');
  if (prefix) hash.update(prefix);
  hash.update(buffer);
  return hash.digest('hex');
}

export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function parseRate(raw) {
  const [left, right] = String(raw || '').split('/').map(Number);
  if (left > 0 && right > 0) return left / right;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function probeAudioDuration(filePath, fallbackSeconds = 0.75) {
  if (!ffprobeBinary || !filePath || !existsSync(filePath)) return fallbackSeconds;
  const result = spawnSync(ffprobeBinary, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,avg_frame_rate,sample_rate',
    filePath,
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 512 * 1024 });
  if (result.status !== 0) return fallbackSeconds;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(audio?.duration) || Number(parsed.format?.duration) || fallbackSeconds;
    return Math.max(0.02, duration);
  } catch {
    return fallbackSeconds;
  }
}

export function probeMedia(filePath) {
  if (!ffprobeBinary || !filePath || !existsSync(filePath)) {
    return { duration: 60, fps: 30, sampleRate: 48000 };
  }
  const result = spawnSync(ffprobeBinary, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,avg_frame_rate,sample_rate',
    filePath,
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 512 * 1024 });
  if (result.status !== 0) return { duration: 60, fps: 30, sampleRate: 48000 };
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return {
      duration: Math.max(0.1, Number(video?.duration) || Number(parsed.format?.duration) || Number(audio?.duration) || 60),
      fps: Math.max(1, parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate) || 30),
      sampleRate: Math.max(8000, Number(audio?.sample_rate) || 48000),
    };
  } catch {
    return { duration: 60, fps: 30, sampleRate: 48000 };
  }
}

function computeGain(meanVolumeDb, maxVolumeDb) {
  const desiredGain = targetMeanDb - meanVolumeDb;
  const peakSafeGain = -1 - maxVolumeDb;
  const gainDb = Math.max(-18, Math.min(18, desiredGain, peakSafeGain + 4));
  return { gainDb, gainLinear: dbToLinear(gainDb) };
}

function analyzeAudioLoudness(filePath, fallbackGainDb = 0) {
  if (!ffmpegBinary || !existsSync(filePath)) {
    return { gainDb: fallbackGainDb, gainLinear: dbToLinear(fallbackGainDb), levelStatus: 'estimated' };
  }
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
  if (!meanMatch || !maxMatch) {
    return { gainDb: fallbackGainDb, gainLinear: dbToLinear(fallbackGainDb), levelStatus: 'estimated' };
  }
  const meanVolumeDb = Number(meanMatch[1]);
  const maxVolumeDb = Number(maxMatch[1]);
  if (!Number.isFinite(meanVolumeDb) || !Number.isFinite(maxVolumeDb)) {
    return { gainDb: fallbackGainDb, gainLinear: dbToLinear(fallbackGainDb), levelStatus: 'estimated' };
  }
  return { ...computeGain(meanVolumeDb, maxVolumeDb), meanVolumeDb, maxVolumeDb, levelStatus: 'ready' };
}

function analyzeAudioOnset(filePath, fallbackOnsetSeconds = 0) {
  if (!ffmpegBinary || !existsSync(filePath)) return fallbackOnsetSeconds;
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
  if (result.status !== 0 || !result.stdout?.length) return fallbackOnsetSeconds;

  const samples = new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
  const windowSize = 256;
  const rmsThreshold = 0.006;
  const peakThreshold = 0.018;
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
      for (let index = start; index < end; index += 1) {
        if (Math.abs(samples[index]) >= rmsThreshold) {
          return Math.max(0, index - 64) / sampleRate;
        }
      }
      return start / sampleRate;
    }
  }
  return 0;
}

function analyzeAudioWaveform(filePath, durationSeconds) {
  if (!ffmpegBinary || !existsSync(filePath)) return [];
  const sampleRate = 24000;
  const maxSeconds = Math.min(45, Math.max(0.1, Number(durationSeconds) || 0.75));
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
  if (result.status !== 0 || !result.stdout?.length) return [];

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
  return peaks.map((peak) => Math.min(1, Math.pow(peak / globalPeak, 0.72)));
}

export function analyzeAudioFile(filePath, fallback = {}) {
  const durationSeconds = probeAudioDuration(filePath, Number(fallback.durationSeconds) || 0.75);
  const onsetSeconds = analyzeAudioOnset(filePath, Number(fallback.onsetSeconds) || 0);
  const loudness = analyzeAudioLoudness(filePath, Number(fallback.gainDb) || 0);
  const waveformPeaks = analyzeAudioWaveform(filePath, durationSeconds);
  const stat = existsSync(filePath) ? statSync(filePath) : { size: 0 };
  return {
    durationSeconds,
    onsetSeconds,
    syncPointSeconds: Number.isFinite(Number(fallback.syncPointSeconds)) ? Number(fallback.syncPointSeconds) : onsetSeconds,
    waveformPeaks,
    gainDb: loudness.gainDb,
    gainLinear: loudness.gainLinear,
    meanVolumeDb: loudness.meanVolumeDb,
    maxVolumeDb: loudness.maxVolumeDb,
    levelStatus: loudness.levelStatus === 'ready' && onsetSeconds >= 0 ? 'ready' : 'estimated',
    byteLength: stat.size,
  };
}
