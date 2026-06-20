import { createHash } from 'node:crypto';
import { buildSFXEvent, packNewEventsAroundFixedEvents } from '../../../shared/sfx-event-core.mjs';
import { defaultFamilyPool } from '../taxonomy.mjs';
import { selectPlaybackRate, selectWeightedAsset } from './select-asset.mjs';

function firstHex(value, length = 20) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function materializeDecisions(decisions, project, assetPack, options = {}) {
  const createdAt = options.createdAt || new Date().toISOString();
  const projectIdentity = String(project.sourceMediaPath || project.name || 'project');
  const recentByFamily = new Map();
  const newEvents = [];

  for (const decision of decisions) {
    const poolId = defaultFamilyPool[decision.family];
    const pool = assetPack.pools.get(poolId);
    if (!pool) continue;
    const recent = recentByFamily.get(decision.family) || [];
    const asset = selectWeightedAsset(pool, decision, { seed: options.seed, recentAssetIds: recent.slice(-4) });
    if (!asset) continue;
    const rateValues = assetPack.manifest.families?.[decision.family]?.playbackRateSampler?.values;
    const playbackRate = selectPlaybackRate(asset, decision, project, { seed: options.seed, values: rateValues });
    const category = {
      id: asset.outputCategory.id,
      name: asset.outputCategory.name,
      path: asset.absolutePath,
      color: asset.outputCategory.color,
      files: [],
    };
    const file = {
      id: asset.assetId,
      categoryId: asset.outputCategory.id,
      name: asset.displayName,
      path: asset.absolutePath,
      duration: Number(asset.audio.durationSeconds) || 0.3,
      onsetSeconds: Number(asset.audio.onsetSeconds) || 0,
      waveformPeaks: asset.audio.waveformPeaks,
      gainDb: Number(asset.render.gainDb) || 0,
      gainLinear: Number(asset.render.gainLinear) || 1,
      levelStatus: 'ready',
    };
    const event = buildSFXEvent({
      category,
      file,
      project,
      playbackRate,
      audibleStartSeconds: decision.targetSec,
      id: `sfxauto_${firstHex(`${projectIdentity}\0${decision.candidateId}\0${decision.eventRole || 'primary'}`)}`,
      createdAt,
      snapZoomId: decision.targetZoomId,
    });
    newEvents.push({
      ...event,
      automation: {
        version: 'sfx-automation-v1.1-conservative',
        candidateId: decision.candidateId,
        family: decision.family,
        familyScore: decision.confidence,
        scoreMargin: decision.scoreMargin,
        reasonCode: decision.reasonCode,
        anchorType: decision.anchorType,
        sourceKind: decision.sourceKind,
        sourceCueIds: decision.sourceCueIds,
        targetZoomId: decision.targetZoomId,
        captionPath: decision.captionPath,
        captionProjectId: decision.captionProjectId,
        resolverConfidence: decision.resolverConfidence,
        familyScores: decision.familyScores,
        scoringDetails: decision.scoringDetails,
        createdAt,
      },
    });
    recentByFamily.set(decision.family, [...recent, asset.assetId].slice(-8));
  }

  return newEvents;
}

export function materializeAndPack(decisions, project, assetPack, options = {}) {
  const newEvents = materializeDecisions(decisions, project, assetPack, options);
  return packNewEventsAroundFixedEvents(project.events || [], newEvents, project.fps);
}
