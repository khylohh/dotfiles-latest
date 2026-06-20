function re(pattern, text) {
  return pattern.test(text);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasZoomSupport(features, maxDistanceSec = 0.75) {
  const startDelta = features.nearestZoomStartDeltaSec;
  const distance = features.nearestZoomDistanceSec;
  return Boolean(features.cueOverlapsZoom)
    || (finiteNumber(startDelta) && Math.abs(startDelta) <= maxDistanceSec)
    || (finiteNumber(distance) && distance <= maxDistanceSec);
}

function hasBoundarySupport(features) {
  return Boolean(features.speakerChangedFromPrevious || features.speakerChangesToNext)
    || Number(features.previousGapSec) >= 0.45
    || Number(features.nextGapSec) >= 0.45
    || Boolean(features.hasExclamationMark);
}

function score(value, reason, details = {}) {
  return { value, reason, details };
}

function bestScore(items) {
  return items
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)[0] || score(0, 'caption_no_strong_signal');
}

function scoreDing(text, context, features) {
  const reveal = re(/\b(look at (this|that)|this one|that one|these ones|right here|there it is|here it is|let me see|which one|how many|\$\d+|\b(red|blue|green|yellow|pink|purple|orange|black|white)\b)\b/, text);
  const generic = re(/^(yeah|yes|okay|ok|oh|guys|right|cool|wow|whoa)$/i, text) || re(/\?$/, text);
  if (!reveal || generic || !hasZoomSupport(features, 0.75)) return null;
  return score(0.92, 'caption_ding_zoom_reveal', {
    mandatory: ['neutral_reveal', 'zoom_support'],
    anchorType: features.anchorType,
  });
}

function scoreSuccess(text, context, features) {
  const completed = re(/\b((we|you|i|they|she|he) (won|finished|found|made it|did it|got it|got one)|winner|correct|it works|it'?s working|ready|perfect|good job|completed|finally got)\b/, text);
  const genericCheer = re(/^(yay+|let'?s go+|whoa|yeah|yes|okay)$/i, text);
  const futureOrPromo = re(/\b(giveaway|subscribe|will|gonna|going to|about to|try to|need to|have to|let'?s)\b/, text) && !completed;
  const negated = re(/\b(not|never|wrong|didn'?t|doesn'?t|don'?t|can'?t|cannot)\b/, text);
  if (!completed || genericCheer || futureOrPromo || negated) return null;
  if (!hasZoomSupport(features, 1.2) && !hasBoundarySupport(features)) return null;
  return score(0.93, 'caption_success_completed_state', {
    mandatory: ['completed_state', hasZoomSupport(features, 1.2) ? 'zoom_support' : 'reaction_boundary'],
    anchorType: 'cue_end_minus_80ms',
  });
}

function scoreBonk(text, context, features) {
  const concreteFailure = re(/\b(fell|fall|dropped|drop|broke|broken|spilled|spill|hit|missed|lost|stuck|flipped|caught|exposed|injured|oops|got it wrong|doing it wrong|doesn'?t (work|fit|last|stay)|not working)\b/, text);
  const genericComplaint = re(/\b(can'?t|cannot|don'?t have|forgot|too (small|big|thin|short|long)|come on|stop|don'?t like|hard|difficult)\b/, text) && !concreteFailure;
  if (!concreteFailure || genericComplaint) return null;
  const support = hasZoomSupport(features, 1.2) || hasBoundarySupport(features) || re(/\b(oops|fell|dropped|broke|spilled|hit)\b/, text);
  if (!support) return null;
  return score(0.94, 'caption_bonk_concrete_failure', {
    mandatory: ['concrete_failure', hasZoomSupport(features, 1.2) ? 'zoom_support' : 'event_support'],
    anchorType: features.anchorType,
  });
}

function scoreFunny(text, context, features) {
  const hardGeneric = re(/\b(what is that|what the heck|what'?s going on|what are you doing|you okay|huh)\b/, text);
  if (hardGeneric) return null;
  const punchline = re(/\b(prank|joke|kidding|that'?s crazy|that'?s insane|you scared me)\b/, context);
  const reaction = Boolean(features.speakerChangedFromPrevious || features.speakerChangesToNext || features.hasExclamationMark || hasZoomSupport(features, 0.75));
  if (!punchline || !reaction) return null;
  return score(0.97, 'caption_funny_contextual_punchline', {
    mandatory: ['punchline', 'reaction_or_zoom'],
    anchorType: 'cue_end_minus_80ms',
  });
}

function disabledScore(reason) {
  return score(0, reason, { disabled: true });
}

function genericVeto(text) {
  return re(/^(yeah|yes|okay|ok|oh|ooh|whoa|wow|guys|bro|come on|wait|look|no|so|and|right|cool)$/i, text)
    || re(/^(what is that|what the heck|what'?s going on|what are you doing|what do you mean|you okay|dun+|du+un)$/i, text);
}

const familyPriority = {
  record_scratch: 95,
  bruh: 90,
  bonk: 75,
  success: 70,
  ding: 55,
  funny: 40,
  none: 0,
};

export function scoreCaptionCandidatesLocal(candidates) {
  return candidates.map((candidate) => {
    const features = candidate.features || {};
    const text = String(features.normalized || '').toLowerCase();
    const context = [
      String(features.previous2Text || ''),
      String(features.previousText || ''),
      text,
      String(features.nextText || ''),
      String(features.next2Text || ''),
    ].join(' ').toLowerCase();

    const ding = scoreDing(text, context, features);
    const success = scoreSuccess(text, context, features);
    const bonk = scoreBonk(text, context, features);
    const funny = scoreFunny(text, context, features);
    const bruh = disabledScore('caption_bruh_disabled_pending_validation');
    const recordScratch = disabledScore('caption_record_scratch_disabled_pending_validation');
    const candidatesByFamily = {
      ding,
      success,
      bonk,
      funny,
      bruh,
      record_scratch: recordScratch,
    };

    const scored = Object.entries(candidatesByFamily).map(([family, item]) => ({
      family,
      ...(item || score(0, 'caption_no_strong_signal')),
    }));
    const winner = bestScore(scored);
    const sorted = scored.sort((a, b) => b.value - a.value || familyPriority[b.family] - familyPriority[a.family]);
    const top = sorted[0];
    const second = sorted[1] || { value: 0, family: 'none' };
    const vetoed = genericVeto(text) && top.value < 0.96;
    const primaryFamily = vetoed || top.value <= 0 ? 'none' : top.family;
    const confidence = primaryFamily === 'none' ? 0.72 : top.value;
    const margin = primaryFamily === 'none' ? 0 : top.value - second.value;

    return {
      candidate,
      familyScores: {
        none: 0.72,
        ding: ding?.value || 0,
        success: success?.value || 0,
        bonk: bonk?.value || 0,
        funny: funny?.value || 0,
        bruh: 0,
        record_scratch: 0,
      },
      primaryFamily,
      confidence,
      scoreMargin: margin,
      reasonCode: primaryFamily === 'none'
        ? (vetoed ? 'caption_generic_phrase_veto' : winner.reason)
        : top.reason,
      scoringDetails: primaryFamily === 'none' ? {} : top.details,
    };
  });
}
