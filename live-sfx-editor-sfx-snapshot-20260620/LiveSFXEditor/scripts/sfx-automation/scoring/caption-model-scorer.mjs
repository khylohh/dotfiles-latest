import { readFileSync } from 'node:fs';
import { extractCaptionBeatFeatures } from '../caption/extract-caption-beat-features.mjs';

const defaultModelUrl = new URL('../../../data/sfx-automation-v2/model-v1/caption-beat-model.json', import.meta.url);
const defaultPolicyUrl = new URL('../../../data/sfx-automation-v2/model-v1/caption-family-policy.json', import.meta.url);

let cachedDefaultBundle = null;

export function loadCaptionBeatModel(options = {}) {
  if (!options.modelPath && !options.policyPath && !options.modelData && !options.policyData && cachedDefaultBundle) {
    return cachedDefaultBundle;
  }
  const model = options.modelData || readJson(options.modelPath || defaultModelUrl);
  const policy = options.policyData || readJson(options.policyPath || defaultPolicyUrl);
  validateModel(model);
  const bundle = {
    model,
    policy,
    vocabIndex: new Map((model.lexical?.vocabulary || []).map((token, index) => [token, index])),
  };
  if (!options.modelPath && !options.policyPath && !options.modelData && !options.policyData) {
    cachedDefaultBundle = bundle;
  }
  return bundle;
}

export function familyPoliciesForDecoder(policyData) {
  const families = policyData?.families || {};
  return Object.fromEntries(Object.entries(families).map(([family, config]) => [family, {
    enabled: config?.enabled !== false,
    threshold: Number(config?.jointThreshold ?? config?.threshold ?? 1),
    marginScore: Number(config?.marginProbability ?? config?.marginScore ?? 1),
    cooldownSeconds: Number(config?.cooldownSeconds ?? 999),
    globalCooldownSeconds: Number(config?.globalCooldownSeconds ?? 1),
    maxPerMinute: Number(config?.maxPerMinute ?? 0),
    priority: Number(config?.priority ?? 0),
  }]));
}

export function scoreCaptionCandidatesModel(candidates, options = {}) {
  if (!candidates.length) return [];
  const bundle = options.modelBundle || loadCaptionBeatModel(options);
  return candidates.map((candidate) => scoreCandidate(candidate, bundle));
}

function scoreCandidate(candidate, bundle) {
  const { model, policy, vocabIndex } = bundle;
  const extracted = extractCaptionBeatFeatures(candidate);
  const dense = denseVector(extracted.dense || {}, model);
  const lexical = lexicalIndices(extracted.lexical || [], vocabIndex);
  const emitLogit = Number(model.emitGate?.intercept || 0)
    + dot(dense, model.emitGate?.denseWeights || [])
    + lexicalDot(lexical, model.emitGate?.lexicalWeights || [], Number(model.lexical?.inputScale ?? 1));
  const emitP = calibrateProbability(sigmoid(emitLogit), model.emitGate?.platt);
  const familyP = familyProbabilities(dense, lexical, model);
  const jointP = {};
  for (let index = 0; index < model.families.length; index += 1) {
    const family = model.families[index];
    jointP[family] = calibrateProbability(emitP * familyP[family], model.jointCalibration?.[family]);
  }
  const ranked = model.families
    .map((family) => ({ family, joint: jointP[family], conditional: familyP[family] }))
    .sort((a, b) => b.joint - a.joint);
  const top = ranked[0] || { family: 'none', joint: 0, conditional: 0 };
  const second = ranked[1] || { joint: 0 };
  const scoreMargin = top.joint - second.joint;
  const decision = policyDecision({
    family: top.family,
    emitP,
    familyP: top.conditional,
    jointP: top.joint,
    scoreMargin,
    policy: policy?.families?.[top.family],
  });

  return {
    candidate,
    familyScores: {
      none: Math.max(0, Math.min(1, 1 - emitP)),
      ...jointP,
    },
    primaryFamily: decision.primaryFamily,
    confidence: top.joint,
    scoreMargin,
    reasonCode: decision.reasonCode,
    scoringDetails: {
      modelVersion: model.modelVersion,
      featureVersion: model.featureVersion,
      topFamily: top.family,
      emitP,
      familyP: Object.fromEntries(model.families.map((family) => [family, familyP[family]])),
      jointP,
      policyReason: decision.reasonCode,
    },
  };
}

function readJson(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
}

function validateModel(model) {
  if (model?.schemaVersion !== 2 || model?.featureVersion !== 2 || !Array.isArray(model?.families)) {
    throw new Error('Caption beat model must be schemaVersion 2 / featureVersion 2');
  }
  const denseNames = model.dense?.names || [];
  if (!Array.isArray(denseNames) || !Array.isArray(model.dense?.mean) || !Array.isArray(model.dense?.scale)) {
    throw new Error('Caption beat model is missing dense normalization data');
  }
}

function denseVector(features, model) {
  const names = model.dense.names || [];
  const mean = model.dense.mean || [];
  const scale = model.dense.scale || [];
  return names.map((name, index) => {
    const raw = Number(features[name]);
    const value = Number.isFinite(raw) ? raw : 0;
    const divisor = Number(scale[index]);
    return (value - Number(mean[index] || 0)) / (Number.isFinite(divisor) && Math.abs(divisor) > 1e-6 ? divisor : 1);
  });
}

function lexicalIndices(tokens, vocabIndex) {
  const output = [];
  for (const token of new Set(tokens)) {
    const index = vocabIndex.get(token);
    if (index !== undefined) output.push(index);
  }
  return output;
}

function familyProbabilities(dense, lexical, model) {
  const temperature = Math.max(0.0001, Number(model.familySoftmax?.temperature || 1));
  const logits = model.families.map((family, index) => {
    return (Number(model.familySoftmax?.intercepts?.[index]) || 0)
      + dot(dense, model.familySoftmax?.denseWeights?.[index] || [])
      + lexicalDot(lexical, model.familySoftmax?.lexicalWeights?.[index] || [], Number(model.lexical?.inputScale ?? 1));
  });
  const probabilities = softmax(logits.map((value) => value / temperature));
  return Object.fromEntries(model.families.map((family, index) => [family, probabilities[index]]));
}

function policyDecision({ family, emitP, familyP, jointP, scoreMargin, policy }) {
  if (!family || family === 'none') return { primaryFamily: 'none', reasonCode: 'caption_model_v2_no_family' };
  if (!policy) return { primaryFamily: 'none', reasonCode: `caption_model_v2_no_policy_${family}` };
  if (policy.enabled === false) return { primaryFamily: 'none', reasonCode: `caption_model_v2_disabled_${family}` };
  if (emitP < Number(policy.gateThreshold ?? 0)) return { primaryFamily: 'none', reasonCode: `caption_model_v2_below_emit_gate_${family}` };
  if (familyP < Number(policy.conditionalThreshold ?? 0)) return { primaryFamily: 'none', reasonCode: `caption_model_v2_below_family_gate_${family}` };
  if (jointP < Number(policy.jointThreshold ?? 1)) return { primaryFamily: 'none', reasonCode: `caption_model_v2_below_joint_gate_${family}` };
  if (scoreMargin < Number(policy.marginProbability ?? 1)) return { primaryFamily: 'none', reasonCode: `caption_model_v2_below_margin_${family}` };
  return { primaryFamily: family, reasonCode: `caption_model_v2_${family}` };
}

function dot(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * Number(right[index] || 0);
  return total;
}

function lexicalDot(indices, weights, inputScale) {
  let total = 0;
  for (const index of indices) total += Number(weights[index] || 0) * inputScale;
  return total;
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function softmax(values) {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return exp.map((value) => value / total);
}

function calibrateProbability(probability, calibration) {
  const a = Number(calibration?.a ?? 1);
  const b = Number(calibration?.b ?? 0);
  if (a === 1 && b === 0) return probability;
  const clipped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
  return sigmoid(a * Math.log(clipped / (1 - clipped)) + b);
}
