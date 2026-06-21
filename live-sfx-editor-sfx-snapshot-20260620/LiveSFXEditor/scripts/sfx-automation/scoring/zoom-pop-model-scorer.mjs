import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const defaultModelUrl = new URL('../../../data/sfx-automation-v3/zoom-pop-model-v1.json', import.meta.url);

let cachedDefaultModel = null;

function firstHex(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

export function loadZoomPopModel(options = {}) {
  if (!options.modelPath && !options.modelData && cachedDefaultModel) return cachedDefaultModel;
  const model = options.modelData || JSON.parse(readFileSync(options.modelPath || defaultModelUrl, 'utf8'));
  validateModel(model);
  if (!options.modelPath && !options.modelData) cachedDefaultModel = model;
  return model;
}

export function scoreZoomPopMoments(moments, project, options = {}) {
  const model = options.model || loadZoomPopModel(options);
  return zoomPopRowsFromMoments(moments, project).map((row) => scoreRow(row, model, project));
}

export function zoomPopRowsFromMoments(moments, project) {
  const projectId = String(project?.projectFilePath || project?.name || 'project');
  const durationSec = Number(project?.duration) || 0;
  const seen = new Set();
  const rows = [];
  for (const moment of [...(moments || [])].sort((a, b) => Number(a.momentSec) - Number(b.momentSec) || String(a.momentId).localeCompare(String(b.momentId)))) {
    const option = canonicalZoomOption(moment);
    if (!option) continue;
    const targetSec = Number(option.targetSec);
    if (!Number.isFinite(targetSec)) continue;
    const signature = `${targetSec.toFixed(3)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    rows.push({
      projectId,
      momentId: moment.momentId || '',
      beatGroupId: moment.beatGroupId || '',
      targetSec,
      targetFrame: Math.max(0, Math.round(targetSec * Math.max(1, Number(project?.fps) || 30))),
      durationSec,
      text: moment.text || '',
      cueIds: moment.cueIds || [],
      wordIds: option.wordIds || [],
      zoomMarkerIds: option.zoomMarkerIds || [],
      selectedTimingOptionId: option.optionId || '',
      selectedAnchorType: 'zoom_onset',
      boundaryStrength: Number(option.parentFeatures?.boundaryStrength) || 0,
      dense: moment.features?.dense || {},
      lexical: moment.features?.lexical || [],
      captionPath: moment.captionPath || '',
      captionProjectId: moment.captionProjectId || '',
      resolver: moment.resolver || null,
    });
  }
  const zoomTimes = rows.map((row) => row.targetSec).sort((a, b) => a - b);
  return rows
    .sort((a, b) => a.targetSec - b.targetSec || a.momentId.localeCompare(b.momentId))
    .map((row, index) => ({
      ...row,
      previousZoomGapSec: index > 0 ? row.targetSec - zoomTimes[index - 1] : 99,
      nextZoomGapSec: index + 1 < zoomTimes.length ? zoomTimes[index + 1] - row.targetSec : 99,
    }));
}

function canonicalZoomOption(moment) {
  const options = (moment?.timingOptions || []).filter((option) => (
    option?.anchorType === 'zoom_onset'
    && Array.isArray(option.zoomMarkerIds)
    && option.zoomMarkerIds.length > 0
  ));
  if (!options.length) return null;
  return [...options].sort((a, b) => (
    (Number(b.parentFeatures?.boundaryStrength) || 0) - (Number(a.parentFeatures?.boundaryStrength) || 0)
    || Math.abs(Number(a.targetSec) - Number(moment.momentSec)) - Math.abs(Number(b.targetSec) - Number(moment.momentSec))
    || String(a.optionId || '').localeCompare(String(b.optionId || ''))
  ))[0];
}

function scoreRow(row, model, project) {
  const features = rowFeatures(row);
  let logit = Number(model.classifier?.intercept) || 0;
  const weights = model.classifier?.weights || {};
  for (const [name, value] of Object.entries(features)) {
    const weight = Number(weights[name]);
    if (Number.isFinite(weight)) logit += weight * Number(value || 0);
  }
  const pop = sigmoid(logit);
  const candidateId = `cand_zoom_pop_${firstHex(`${row.projectId}\0${row.selectedTimingOptionId}\0${row.targetSec}`)}`;
  const candidate = {
    id: candidateId,
    featureVersion: 1,
    kind: 'zoom',
    targetSec: row.targetSec,
    targetFrame: row.targetFrame,
    allowedFamilies: ['none', 'pop'],
    cueIds: row.cueIds,
    wordIds: row.wordIds,
    beatIds: row.beatGroupId ? [row.beatGroupId] : [],
    zoomMarkerIds: row.zoomMarkerIds,
    captionPath: row.captionPath,
    captionProjectId: row.captionProjectId,
    resolver: row.resolver,
    text: row.text,
    triggerOptions: [{ text: row.text, targetSec: row.targetSec, source: 'zoom_pop_model', anchorType: 'zoom_onset' }],
    features: {
      anchorType: 'zoom_onset',
      previousGapSec: row.previousZoomGapSec,
      nextGapSec: row.nextZoomGapSec,
      projectFraction: row.durationSec > 0 ? row.targetSec / row.durationSec : 0,
    },
  };
  return {
    candidate,
    familyScores: {
      none: 1 - pop,
      pop,
    },
    primaryFamily: 'pop',
    confidence: pop,
    scoreMargin: pop - (1 - pop),
    reasonCode: 'zoom_pop_model_v1',
    scoringDetails: {
      modelVersion: model.modelVersion,
      featureVersion: model.featureVersion,
      selectedTimingOptionId: row.selectedTimingOptionId,
      sourceText: row.text,
    },
  };
}

function rowFeatures(row) {
  const text = String(row.text || '').toLowerCase();
  const tokens = text.match(/[a-z0-9']+/g) || [];
  const features = {
    relativeTime: row.durationSec > 0 ? row.targetSec / row.durationSec : 0,
    previousZoomGapSec: Math.min(30, Number(row.previousZoomGapSec) || 30),
    nextZoomGapSec: Math.min(30, Number(row.nextZoomGapSec) || 30),
    boundaryStrength: Number(row.boundaryStrength) || 0,
    tokenCount: tokens.length,
    hasQuestion: text.includes('?') ? 1 : 0,
    hasExclamation: text.includes('!') ? 1 : 0,
  };
  for (const [key, value] of Object.entries(row.dense || {})) {
    if (key.startsWith('candidate_median.') || key.startsWith('moment.')) {
      features[`dense:${key}`] = Number(value) || 0;
    }
  }
  for (const token of tokens) features[`token:${token}`] = 1;
  for (const token of row.lexical || []) features[`lexical:${token}`] = 1;
  return features;
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function validateModel(model) {
  if (model?.schemaVersion !== 1 || model?.modelVersion !== 'zoom-pop-selector-v1') {
    throw new Error('Zoom-pop model must be schemaVersion 1 / zoom-pop-selector-v1');
  }
  if (!model.classifier || typeof model.classifier.weights !== 'object') {
    throw new Error('Zoom-pop model is missing classifier weights');
  }
}
