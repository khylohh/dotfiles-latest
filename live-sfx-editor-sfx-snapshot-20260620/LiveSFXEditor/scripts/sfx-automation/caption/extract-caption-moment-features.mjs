import { extractCaptionBeatFeatures } from './extract-caption-beat-features.mjs';

const anchorTypes = [
  'cue_start',
  'cue_end_minus_80ms',
  'final_word_end',
  'internal_pause_word_end',
  'zoom_onset',
  'speaker_turn_start',
  'pause_boundary',
];

const routeFeatureDenylist = [
  /^anchor\.delta_to_/,
  /^zoom\.nearest_signed_delta_sec$/,
  /^zoom\.nearest_absolute_delta_sec$/,
  /^zoom\.nearest_duration_sec$/,
  /^resolver\.duration_delta_ratio$/,
];

const beatFeatureCache = new WeakMap();

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function median(values) {
  const nums = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function mean(values) {
  const nums = values.map(finite).filter((value) => value !== null);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function max(values) {
  const nums = values.map(finite).filter((value) => value !== null);
  return nums.length ? Math.max(...nums) : 0;
}

function routeFeatureAllowed(name) {
  return !routeFeatureDenylist.some((pattern) => pattern.test(name));
}

function candidateDense(candidate) {
  if (candidate.denseFeatures) return candidate.denseFeatures;
  return cachedBeatFeatures(candidate).dense;
}

function candidateLexical(candidate) {
  if (candidate.lexicalTokens) return candidate.lexicalTokens;
  return cachedBeatFeatures(candidate).lexical;
}

function cachedBeatFeatures(candidate) {
  if (!candidate || typeof candidate !== 'object') return { dense: {}, lexical: [] };
  const existing = beatFeatureCache.get(candidate);
  if (existing) return existing;
  const extracted = extractCaptionBeatFeatures(candidate);
  beatFeatureCache.set(candidate, extracted);
  return extracted;
}

export function extractCaptionMomentFeatures(moment) {
  const candidates = Array.isArray(moment.candidates) ? moment.candidates : [];
  const timingOptions = Array.isArray(moment.timingOptions) ? moment.timingOptions : [];
  const dense = {};
  const lexical = new Set();

  for (const candidate of candidates) {
    for (const token of candidateLexical(candidate)) lexical.add(token);
  }

  const denseNames = [...new Set(candidates.flatMap((candidate) => Object.keys(candidateDense(candidate))))].filter(routeFeatureAllowed);
  for (const name of denseNames) {
    dense[`candidate_median.${name}`] = median(candidates.map((candidate) => candidateDense(candidate)[name]));
  }

  dense['moment.option_count'] = timingOptions.length;
  const optionTimes = timingOptions.map((option) => Number(option.targetSec)).filter(Number.isFinite);
  dense['moment.span_sec'] = optionTimes.length ? Math.max(...optionTimes) - Math.min(...optionTimes) : 0;
  dense['moment.has_zoom'] = timingOptions.some((option) => (option.zoomMarkerIds || []).length) ? 1 : 0;
  dense['moment.word_timing_available'] = timingOptions.some((option) => option.parentFeatures?.wordTimingAvailable) ? 1 : 0;
  dense['moment.is_orphan_zoom'] = moment.kind === 'caption_zoom_moment' ? 1 : 0;
  dense['moment.max_boundary_strength'] = max(timingOptions.map((option) => option.parentFeatures?.boundaryStrength));
  dense['moment.mean_boundary_strength'] = mean(timingOptions.map((option) => option.parentFeatures?.boundaryStrength));

  const optionAnchorCounts = new Map();
  for (const option of timingOptions) {
    const anchor = option.anchorType || 'unknown';
    optionAnchorCounts.set(anchor, (optionAnchorCounts.get(anchor) || 0) + 1);
  }
  for (const anchor of anchorTypes) {
    dense[`moment.has_anchor.${anchor}`] = optionAnchorCounts.has(anchor) ? 1 : 0;
    dense[`moment.anchor_count.${anchor}`] = optionAnchorCounts.get(anchor) || 0;
  }

  const contextSlots = [
    'speakerChangedFromPrevious',
    'speakerChangesToNext',
    'previousGapSec',
    'nextGapSec',
    'wordTimingCoverage',
  ];
  for (const key of contextSlots) {
    dense[`moment.median_${key}`] = median(candidates.map((candidate) => candidate.features?.[key]));
  }

  return {
    dense,
    lexical: [...lexical].sort(),
  };
}

export function extractTimingOptionFeatures(moment, option, routedFamily) {
  const dense = {};
  const family = String(routedFamily || '');
  const anchor = String(option?.anchorType || '');
  const cueStart = finite(option?.parentFeatures?.cueStartSec);
  const cueEnd = finite(option?.parentFeatures?.cueEndSec);
  const targetSec = finite(option?.targetSec);
  const nearestZoomStart = finite(option?.parentFeatures?.nearestZoomStartSec);
  dense['timing.boundary_strength'] = finite(option?.parentFeatures?.boundaryStrength) ?? 0;
  dense['timing.word_timing_available'] = option?.parentFeatures?.wordTimingAvailable ? 1 : 0;
  dense['timing.has_zoom'] = (option?.zoomMarkerIds || []).length ? 1 : 0;
  dense['timing.delta_to_cue_start'] = targetSec !== null && cueStart !== null ? targetSec - cueStart : 0;
  dense['timing.delta_to_cue_end'] = targetSec !== null && cueEnd !== null ? targetSec - cueEnd : 0;
  dense['timing.delta_to_nearest_zoom'] = targetSec !== null && nearestZoomStart !== null ? targetSec - nearestZoomStart : 0;
  for (const item of anchorTypes) {
    dense[`timing.anchor.${item}`] = anchor === item ? 1 : 0;
    dense[`family_anchor:${family}:${item}`] = anchor === item ? 1 : 0;
  }
  dense[`family:${family}`] = family ? 1 : 0;
  dense['moment.option_count'] = Number(moment?.features?.dense?.['moment.option_count']) || 0;
  dense['moment.has_zoom'] = Number(moment?.features?.dense?.['moment.has_zoom']) || 0;
  return { dense };
}
