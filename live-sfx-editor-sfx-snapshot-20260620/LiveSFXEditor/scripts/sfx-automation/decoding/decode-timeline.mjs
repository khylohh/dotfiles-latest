export function decodeTimeline(scoredCandidates, project, options = {}) {
  const durationMinutes = Math.max(0.1, Number(project.duration || 0) / 60);
  const policies = buildFamilyPolicies(options, project, durationMinutes);
  const familyCounts = new Map();
  const selected = [];
  const sorted = scoredCandidates
    .filter((item) => {
      const family = item.primaryFamily;
      if (!family || family === 'none') return false;
      const policy = policies[family];
      const requiredMargin = Number(policy?.marginScore);
      const scoreMargin = Number(item.scoreMargin);
      return policy
        && policy.enabled !== false
        && item.confidence >= policy.threshold
        && (!Number.isFinite(requiredMargin) || (Number.isFinite(scoreMargin) && scoreMargin >= requiredMargin));
    })
    .sort((a, b) => (
      b.confidence - a.confidence
      || (policies[b.primaryFamily]?.priority || 0) - (policies[a.primaryFamily]?.priority || 0)
      || a.candidate.targetSec - b.candidate.targetSec
      || a.candidate.id.localeCompare(b.candidate.id)
    ));

  for (const item of sorted) {
    const family = item.primaryFamily;
    const policy = policies[family];
    const acceptedCount = familyCounts.get(family) || 0;
    if (acceptedCount >= policy.maxCount) continue;
    const targetSec = Number(item.candidate.targetSec);
    const sourceKind = item.candidate.kind || family;
    if (selected.some((accepted) => accepted.family === family && Math.abs(Number(accepted.targetSec) - targetSec) < policy.cooldownSec)) continue;
    if (selected.some((accepted) => accepted.sourceKind === sourceKind && Math.abs(Number(accepted.targetSec) - targetSec) < policy.globalCooldownSec)) continue;
    if (violatesRollingCaps(selected, targetSec, options.density?.rollingCaps)) continue;
    selected.push({
      candidateId: item.candidate.id,
      family,
      confidence: item.confidence,
      scoreMargin: item.scoreMargin ?? null,
      targetSec,
      targetFrame: item.candidate.targetFrame,
      targetZoomId: item.candidate.zoomMarkerIds[0],
      reasonCode: item.reasonCode,
      sourceKind,
      anchorType: item.candidate.features?.anchorType || '',
      sourceCueIds: item.candidate.cueIds || [],
      captionPath: item.candidate.captionPath || '',
      captionProjectId: item.candidate.captionProjectId || '',
      resolverConfidence: item.candidate.resolver?.resolverConfidence ?? null,
      familyScores: item.familyScores || {},
      scoringDetails: item.scoringDetails || {},
      eventRole: 'primary',
    });
    familyCounts.set(family, acceptedCount + 1);
  }

  return selected.sort((a, b) => a.targetSec - b.targetSec || a.candidateId.localeCompare(b.candidateId));
}

function buildFamilyPolicies(options, project, durationMinutes) {
  const zoomCount = Array.isArray(project.zoomMarkers) ? project.zoomMarkers.length : 0;
  const configured = options.familyPolicies || {};
  const defaults = {
    pop: {
      threshold: Number(options.popThreshold ?? configured.pop?.threshold ?? 0.78),
      cooldownSec: Number(options.popCooldownSec ?? configured.pop?.cooldownSeconds ?? 4.0),
      globalCooldownSec: Number(configured.pop?.globalCooldownSeconds ?? 0.65),
      maxCount: Math.min(
        Math.ceil(durationMinutes * Number(options.maxPopPerMinute ?? configured.pop?.maxPerMinute ?? 2.4)) + 1,
        Math.max(1, Math.floor(zoomCount * Number(options.maxZoomAccentRatio ?? configured.pop?.maxZoomAccentRatio ?? 0.45))),
      ),
      priority: Number(configured.pop?.priority ?? 35),
    },
    ding: familyPolicy(configured.ding, durationMinutes, 0.92, 4, 0.45, 1.25, 45, 0.12),
    success: familyPolicy(configured.success, durationMinutes, 0.93, 10, 0.25, 1.25, 75, 0.12),
    bonk: familyPolicy(configured.bonk, durationMinutes, 0.93, 8, 0.35, 1.25, 80, 0.12),
    funny: familyPolicy(configured.funny, durationMinutes, 0.98, 15, 0.10, 1.25, 40, 0.18),
    bruh: familyPolicy(configured.bruh, durationMinutes, 0.99, 90, 0.0, 1.25, 90, 0.2),
    record_scratch: familyPolicy(configured.record_scratch, durationMinutes, 0.99, 180, 0.0, 1.25, 95, 0.2),
  };
  return defaults;
}

function familyPolicy(config, durationMinutes, threshold, cooldownSec, maxPerMinute, globalCooldownSec, priority, marginScore) {
  return {
    enabled: config?.enabled !== false,
    threshold: Number(config?.threshold ?? threshold),
    cooldownSec: Number(config?.cooldownSeconds ?? cooldownSec),
    globalCooldownSec: Number(config?.globalCooldownSeconds ?? globalCooldownSec),
    maxCount: Math.max(0, Math.ceil(durationMinutes * Number(config?.maxPerMinute ?? maxPerMinute))),
    priority: Number(config?.priority ?? priority),
    marginScore: Number(config?.marginScore ?? marginScore),
  };
}

function violatesRollingCaps(selected, targetSec, configuredWindows) {
  const windows = Array.isArray(configuredWindows) && configuredWindows.length
    ? configuredWindows.map((window) => ({ seconds: Number(window.seconds), max: Number(window.maxEvents ?? window.max) }))
    : [
    { seconds: 3, max: 2 },
    { seconds: 8, max: 4 },
    { seconds: 20, max: 7 },
    { seconds: 60, max: 13 },
  ];
  return windows.some((window) => {
    if (!Number.isFinite(window.seconds) || !Number.isFinite(window.max)) return false;
    const count = selected.filter((item) => Math.abs(Number(item.targetSec) - targetSec) <= window.seconds / 2).length;
    return count + 1 > window.max;
  });
}
