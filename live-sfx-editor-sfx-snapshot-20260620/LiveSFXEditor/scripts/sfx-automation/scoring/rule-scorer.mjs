function stableUnit(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000000) / 1000000;
}

export function scoreZoomCandidatesLocal(candidates, options = {}) {
  const seed = String(options.seed || 'sfx-v1');
  return candidates.map((candidate) => {
    const previousGap = Number(candidate.features.previousGapSec);
    const nextGap = Number(candidate.features.nextGapSec);
    const denseRun = Boolean(candidate.features.denseRun);
    const projectFraction = Number(candidate.features.projectFraction) || 0;
    const random = stableUnit(`${seed}\0${candidate.id}`);
    let pop = 0.62;
    if (!Number.isFinite(previousGap) || previousGap >= 2.5) pop += 0.08;
    if (!Number.isFinite(nextGap) || nextGap >= 1.2) pop += 0.04;
    if (denseRun) pop -= 0.08;
    if (projectFraction < 0.02) pop += 0.03;
    if (random < 0.42) pop += 0.10;
    if (random > 0.86) pop -= 0.10;
    pop = Math.max(0.05, Math.min(0.94, pop));
    return {
      candidate,
      familyScores: {
        none: 1 - pop,
        pop,
      },
      primaryFamily: pop >= 0.78 ? 'pop' : 'none',
      confidence: pop,
      reasonCode: 'zoom_emphasis',
    };
  });
}
