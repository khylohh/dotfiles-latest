const positiveWords = new Set([
  'yes', 'yeah', 'yay', 'yep', 'good', 'great', 'nice', 'perfect', 'correct', 'right', 'win',
  'won', 'winner', 'found', 'got', 'did', 'done', 'ready', 'cool', 'amazing', 'love',
]);

const negativeWords = new Set([
  'no', 'not', 'never', 'wrong', 'bad', 'broken', 'fail', 'failed', 'lost', 'lose', 'cant',
  "can't", 'cannot', 'stuck', 'stop', 'oops', 'uh', 'oh',
]);

const reactionWords = new Set([
  'oh', 'wow', 'whoa', 'ooh', 'oooooh', 'what', 'wait', 'huh', 'dang', 'bro', 'guys',
  'look', 'really', 'seriously',
]);

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'?!\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .replace(/[?!]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function textFeatureFlags(text) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  const tokens = tokenize(raw);
  const tokenSet = new Set(tokens);
  const hasAny = (words) => words.some((word) => normalized.includes(word));
  return {
    normalized,
    tokens,
    tokenCount: tokens.length,
    charCount: raw.length,
    hasQuestionMark: raw.includes('?'),
    hasExclamationMark: raw.includes('!'),
    hasPositiveWord: tokens.some((token) => positiveWords.has(token)),
    hasNegativeWord: tokens.some((token) => negativeWords.has(token)),
    hasReactionWord: tokens.some((token) => reactionWords.has(token)),
    hasLookPhrase: /\blook\b|\blook at\b/.test(normalized),
    hasRevealPhrase: hasAny(['here it is', 'there it is', 'found it', 'look at this', 'look at that', 'what is this']),
    hasWinPhrase: hasAny(['i win', 'we won', 'you won', 'good job', 'got it', 'we got', "let's get", 'we found']),
    hasMistakePhrase: hasAny(["don't tell me", 'never mind', 'too small', 'too big', 'wrong', 'broken', 'doesn\'t', "didn't", 'forgot']),
    hasConfusionPhrase: hasAny(['wait what', 'what the', 'what is', "what's", 'where is', "where's", 'why is', 'how is', 'huh']),
    hasRecordStopPhrase: hasAny(['wait', 'hold on', 'actually', 'never mind', 'where are you going', "what do you mean"]),
  };
}

export function cueContext(cues, index, radius = 3) {
  const startIndex = Math.max(0, index - radius);
  const endIndex = Math.min(cues.length, index + radius + 1);
  return cues.slice(startIndex, endIndex).map((cue) => ({
    id: cue.id,
    start: cue.start,
    end: cue.end,
    speaker: cue.speaker,
    text: cue.text,
  }));
}

export function formatCueWindow(cues) {
  return cues
    .map((cue) => `${cue.speaker ? `${cue.speaker}: ` : ''}${cue.text}`)
    .join(' | ');
}
