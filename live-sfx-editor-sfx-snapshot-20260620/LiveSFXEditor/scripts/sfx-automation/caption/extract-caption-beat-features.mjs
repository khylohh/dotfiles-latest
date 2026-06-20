import { normalizeText, tokenize } from './text-features.mjs';

const semanticGroups = {
  future_or_attempt: /\b(will|gonna|going to|try|trying|need to|about to|let'?s|have to)\b/,
  completion_or_result: /\b(won|finished|found|got|made|did|works|working|correct|done|finally|ready|perfect)\b/,
  failure_or_mishap: /\b(fell|dropped|broke|broken|spilled|missed|lost|stuck|wrong|oops|hit|failed|mistake)\b/,
  contrast_or_correction: /\b(but|actually|wait|no|instead|thought|supposed|turns out|nevermind|never mind)\b/,
  reveal_or_deictic: /\b(this|that|these|those|here|there|look|see|right here)\b/,
  reaction_or_surprise: /\b(oh|wow|whoa|ooh|what|wait|huh|really|seriously|crazy|insane)\b/,
  humor_or_laughter: /\b(haha|laugh|laughing|kidding|joke|prank|scared|funny)\b/,
  imperative: /\b(come|stop|look|watch|listen|go|get|give|put|take|try)\b/,
  positive_evaluation: /\b(good|great|nice|cute|cool|pretty|love|best|perfect|amazing)\b/,
  negative_evaluation: /\b(bad|wrong|gross|ugly|terrible|hard|scary|weird|too small|too big)\b/,
  negation: /\b(no|not|never|don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t)\b/,
};

const colors = new Set(['red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'black', 'white', 'brown']);

export function extractCaptionBeatFeatures(candidate) {
  const features = candidate.features || {};
  const slots = slotTexts(candidate);
  const dense = {};
  const add = (name, value) => {
    const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
    dense[name] = Number.isFinite(numeric) ? numeric : 0;
  };
  const addNullable = (name, value) => {
    const numeric = Number(value);
    add(`${name}.missing`, Number.isFinite(numeric) ? 0 : 1);
    add(name, Number.isFinite(numeric) ? numeric : 0);
  };

  for (const type of ['cue_start', 'cue_end_minus_80ms', 'final_word_end', 'internal_pause_word_end', 'zoom_onset', 'speaker_turn_start', 'pause_boundary']) {
    add(`anchor.is_${type}`, candidate.anchorTypes?.includes(type));
  }
  add('anchor.type_count', candidate.anchorTypes?.length || 0);
  addNullable('anchor.delta_to_cue_start', Number(features.targetSec) - Number(features.cueStartSec));
  addNullable('anchor.delta_to_cue_end', Number(features.targetSec) - Number(features.cueEndSec));
  addNullable('anchor.delta_to_nearest_zoom_onset', features.nearestZoomStartDeltaSec);
  addNullable('anchor.preceding_gap_sec', features.previousGapSec);
  addNullable('anchor.following_gap_sec', features.nextGapSec);
  add('anchor.boundary_strength', boundaryStrength(candidate));
  add('anchor.word_timing_available', features.wordTimingAvailable);
  add('anchor.word_timing_coverage', features.wordTimingCoverage);

  add('zoom.has_zoom', features.hasNearbyZoom);
  add('zoom.overlaps_cue', features.cueOverlapsZoom);
  add('zoom.anchor_is_zoom', features.anchorType === 'zoom_onset');
  addNullable('zoom.nearest_signed_delta_sec', features.nearestZoomStartDeltaSec);
  addNullable('zoom.nearest_absolute_delta_sec', absoluteFinite(features.nearestZoomStartDeltaSec));
  addNullable('zoom.nearest_duration_sec', finitePairDuration(features.nearestZoomStartSec, features.nearestZoomEndSec));

  for (const [slot, text] of Object.entries(slots)) {
    addSlotFeatures(add, `${slot}`, text);
  }

  add('speaker.p1_to_c0_changed', features.speakerChangedFromPrevious);
  add('speaker.c0_to_n1_changed', features.speakerChangesToNext);
  add('speaker.current_is_short_new_speaker_reaction', features.speakerChangedFromPrevious && tokenize(slots.c0).length <= 3 && semanticGroups.reaction_or_surprise.test(normalizeText(slots.c0)));
  addNullable('gap.p1_c0_sec', features.previousGapSec);
  addNullable('gap.c0_n1_sec', features.nextGapSec);
  add('gap.bin_before_0_08', Number(features.previousGapSec) >= 0.08);
  add('gap.bin_before_0_25', Number(features.previousGapSec) >= 0.25);
  add('gap.bin_before_0_50', Number(features.previousGapSec) >= 0.50);
  add('gap.bin_before_1_00', Number(features.previousGapSec) >= 1.00);

  add('repeat.p1_c0_exact_normalized', normalizeText(slots.p1) && normalizeText(slots.p1) === normalizeText(slots.c0));
  add('repeat.c0_n1_exact_normalized', normalizeText(slots.c0) && normalizeText(slots.c0) === normalizeText(slots.n1));
  add('repeat.p1_c0_token_jaccard', tokenJaccard(slots.p1, slots.c0));
  add('repeat.c0_n1_token_jaccard', tokenJaccard(slots.c0, slots.n1));

  add('transition.setup_to_outcome', has(slots.p1, 'future_or_attempt') && has(slots.c0, 'completion_or_result'));
  add('transition.action_to_failure', (has(slots.p1, 'future_or_attempt') || has(slots.p1, 'imperative')) && has(slots.c0, 'failure_or_mishap'));
  add('transition.assertion_to_reversal', has(slots.p1, 'completion_or_result') && has(slots.c0, 'contrast_or_correction'));
  add('transition.event_to_reaction', (has(slots.p1, 'failure_or_mishap') || has(slots.p1, 'completion_or_result')) && has(slots.c0, 'reaction_or_surprise'));
  add('transition.reveal_to_confirmation', has(slots.p1, 'reveal_or_deictic') && (has(slots.c0, 'positive_evaluation') || has(slots.c0, 'completion_or_result')));
  add('transition.punchline_to_reaction', has(slots.p1, 'humor_or_laughter') && has(slots.c0, 'reaction_or_surprise'));
  add('transition.generic_with_independent_support', isGenericOnly(slots.c0) && (dense['anchor.boundary_strength'] >= 0.5 || features.hasNearbyZoom));

  add('resolver.confidence_0_1', Math.max(0, Math.min(1, Number(candidate.resolver?.resolverConfidence || 0) / 100)));
  const projectDuration = Number(candidate.resolver?.projectDurationSec || 0);
  const durationDelta = Number(candidate.resolver?.durationDeltaSec || 0);
  add('resolver.duration_delta_ratio', projectDuration > 0 ? durationDelta / projectDuration : 0);
  add('resolver.has_verified_time_map', candidate.resolver?.status === 'ok');
  add('resolver.word_timing_coverage', features.wordTimingCoverage || 0);

  return {
    dense,
    lexical: lexicalTokens(slots),
  };
}

function slotTexts(candidate) {
  const features = candidate.features || {};
  return {
    p2: features.previous2Text || '',
    p1: features.previousText || '',
    c0: candidate.text || '',
    n1: features.nextText || '',
    n2: features.next2Text || '',
  };
}

function addSlotFeatures(add, prefix, text) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  const tokens = tokenize(raw);
  add(`${prefix}.token_count`, tokens.length);
  add(`${prefix}.is_one_token`, tokens.length === 1);
  add(`${prefix}.is_three_tokens_or_fewer`, tokens.length > 0 && tokens.length <= 3);
  add(`${prefix}.has_question`, raw.includes('?'));
  add(`${prefix}.has_exclamation`, raw.includes('!'));
  add(`${prefix}.has_terminal_period`, /[.]$/.test(raw.trim()));
  add(`${prefix}.has_trailing_dash`, /[-]$/.test(raw.trim()));
  add(`${prefix}.uppercase_ratio`, uppercaseRatio(raw));
  add(`${prefix}.elongated_token_ratio`, tokens.length ? tokens.filter((token) => /(.)\1{2,}/.test(token)).length / tokens.length : 0);
  add(`${prefix}.has_number`, /\d/.test(raw));
  add(`${prefix}.has_currency`, /[$]/.test(raw));
  for (const group of Object.keys(semanticGroups)) {
    add(`${prefix}.has_${group}`, has(text, group));
  }
  add(`${prefix}.has_color`, tokens.some((token) => colors.has(token)));
  add(`${prefix}.is_generic_only`, isGenericOnly(text));
  add(`${prefix}.word_timing_missing`, 0);
}

function has(text, group) {
  return semanticGroups[group].test(normalizeText(text));
}

function isGenericOnly(text) {
  const tokens = tokenize(text);
  if (!tokens.length || tokens.length > 4) return false;
  const generic = new Set(['yeah', 'yes', 'okay', 'ok', 'oh', 'ooh', 'wow', 'whoa', 'guys', 'bro', 'what', 'wait', 'look', 'no', 'so', 'and', 'right', 'cool', 'come', 'on']);
  return tokens.every((token) => generic.has(token));
}

function boundaryStrength(candidate) {
  const features = candidate.features || {};
  const terminal = /[.?!]$/.test(String(candidate.text || '').trim());
  const zoomNear = typeof features.nearestZoomStartDeltaSec === 'number' && Math.abs(features.nearestZoomStartDeltaSec) <= 0.25;
  const internalPause = candidate.anchorTypes?.includes('internal_pause_word_end');
  return Math.min(1,
    (features.speakerChangedFromPrevious ? 0.30 : 0)
    + (Number(features.previousGapSec) >= 0.30 ? 0.30 : 0)
    + (terminal ? 0.20 : 0)
    + (zoomNear ? 0.20 : 0)
    + (internalPause ? 0.15 : 0));
}

function lexicalTokens(slots) {
  const tokens = [];
  for (const [slot, text] of Object.entries(slots)) {
    const normalizedTokens = tokenize(sanitizeLexicalText(text));
    for (const token of normalizedTokens) tokens.push(`${slot}:u:${token}`);
    for (let index = 0; index < normalizedTokens.length - 1; index += 1) {
      tokens.push(`${slot}:b:${normalizedTokens[index]}_${normalizedTokens[index + 1]}`);
    }
  }
  const p1 = tokenize(sanitizeLexicalText(slots.p1));
  const c0 = tokenize(sanitizeLexicalText(slots.c0));
  if (p1.length && c0.length) tokens.push(`boundary:p1_last|c0_first:${p1[p1.length - 1]}|${c0[0]}`);
  return [...new Set(tokens)].sort();
}

function sanitizeLexicalText(text) {
  return normalizeText(text)
    .replace(/\$\s*\d+(?:\.\d+)?/g, '<currency>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/([a-z])\1{2,}/g, '$1$1');
}

function tokenJaccard(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function uppercaseRatio(text) {
  const letters = String(text || '').replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

function absoluteFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : null;
}

function finitePairDuration(start, end) {
  return typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : null;
}
