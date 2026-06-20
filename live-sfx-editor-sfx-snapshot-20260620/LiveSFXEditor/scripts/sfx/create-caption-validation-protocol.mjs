#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const validationRoot = resolve(editorRoot, 'validation');
const corpusPath = resolve(editorRoot, 'data/sfx-automation-v2/visible-caption-corpus.jsonl');
const sourceProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const lockedFinalHoldout = 'footage_06_10_26_sfx';
const captionFamilies = new Set(['ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch']);

const protocol = {
  protocol: 'nested-grouped-caption-cv-v1',
  randomSeed: 20260618,
  lockedFinalHoldout,
  outerMetric: 'outer-fold-only',
  matchToleranceSeconds: 0.75,
  groupingVersion: 1,
  precisionFloorVersion: 1,
};

const precisionFloors = {
  ding: { precision: 0.75, wilsonLower90: 0.60, minPredictions: 30, minProjects: 6 },
  success: { precision: 0.75, wilsonLower90: 0.60, minPredictions: 25, minProjects: 6 },
  bonk: { precision: 0.78, wilsonLower90: 0.62, minPredictions: 25, minProjects: 6 },
  funny: { precision: 0.82, wilsonLower90: 0.65, minPredictions: 20, minProjects: 6 },
  bruh: { precision: 0.90, wilsonLower90: 0.72, minPredictions: 15, minProjects: 5 },
  record_scratch: { precision: 0.90, wilsonLower90: 0.72, minPredictions: 15, minProjects: 5 },
};

const familyDefaults = {
  ding: { gateThreshold: 0.60, conditionalThreshold: 0.55, marginProbability: 0.12, cooldownSeconds: 5, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.35, priority: 55 },
  success: { gateThreshold: 0.60, conditionalThreshold: 0.60, marginProbability: 0.15, cooldownSeconds: 10, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.20, priority: 75 },
  bonk: { gateThreshold: 0.65, conditionalThreshold: 0.60, marginProbability: 0.18, cooldownSeconds: 8, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.25, priority: 80 },
  funny: { gateThreshold: 0.70, conditionalThreshold: 0.65, marginProbability: 0.20, cooldownSeconds: 15, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.08, priority: 40 },
  bruh: { gateThreshold: 0.80, conditionalThreshold: 0.75, marginProbability: 0.25, cooldownSeconds: 60, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.03, priority: 90 },
  record_scratch: { gateThreshold: 0.85, conditionalThreshold: 0.80, marginProbability: 0.30, cooldownSeconds: 90, globalCooldownSeconds: 0.9, beatNmsSeconds: 0.45, maxPerMinute: 0.03, priority: 95 },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readCorpusRows() {
  const rows = readFileSync(corpusPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (rows.some((row) => row.project?.projectId === lockedFinalHoldout)) {
    throw new Error(`Locked final holdout ${lockedFinalHoldout} is present in visible corpus`);
  }
  return rows;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptHash(row) {
  const text = (row.cues || [])
    .map((cue) => normalizeText(cue.text))
    .filter(Boolean)
    .join('\n');
  return sha256(text);
}

function dateFrom(value) {
  const match = String(value || '').match(/(?:^|[^0-9])(\d{2})[-_](\d{2})[-_](\d{2})(?:[^0-9]|$)/);
  if (!match) return '';
  return `20${match[3]}-${match[1]}-${match[2]}`;
}

function slug(value) {
  return normalizeText(value).replace(/\s+/g, '_') || 'unknown';
}

function buildConnectedComponents(entries) {
  const parent = new Map(entries.map((entry) => [entry.projectId, entry.projectId]));
  const find = (id) => {
    let root = parent.get(id);
    while (root && parent.get(root) !== root) root = parent.get(root);
    let current = id;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA && rootB && rootA !== rootB) parent.set(rootB, rootA);
  };
  const byKey = new Map();
  for (const entry of entries) {
    for (const key of [
      entry.scriptBatchId ? `scriptBatch:${entry.scriptBatchId}` : '',
      entry.shootId ? `shoot:${entry.shootId}` : '',
      entry.normalizedScriptHash ? `scriptHash:${entry.normalizedScriptHash}` : '',
    ].filter(Boolean)) {
      const existing = byKey.get(key);
      if (existing) union(existing, entry.projectId);
      else byKey.set(key, entry.projectId);
    }
  }
  const rootToGroup = new Map();
  let next = 1;
  for (const entry of entries) {
    const root = find(entry.projectId);
    if (!rootToGroup.has(root)) rootToGroup.set(root, `group_${String(next++).padStart(2, '0')}_${slug(root)}`);
    entry.generalizationGroupId = rootToGroup.get(root);
  }
}

function buildManifest() {
  const sourceData = readJson(sourceProjectsPath);
  const sourceById = new Map((sourceData.projects || []).map((project) => [project.project_id, project]));
  const entries = readCorpusRows().map((row) => {
    const projectId = row.project.projectId;
    const source = sourceById.get(projectId) || {};
    const rootDir = source.root_dir || '';
    const shootId = rootDir ? basename(rootDir) : '';
    const recordingDate = dateFrom(projectId) || dateFrom(source.media_path) || dateFrom(source.caption_source) || dateFrom(rootDir);
    const hash = scriptHash(row);
    return {
      projectId,
      trainEligible: Boolean(row.trainEligible),
      resolver: {
        status: row.resolver?.status || 'failed',
        reason: row.resolver?.reason || row.captionLoadError || '',
        exclusionReason: row.trainEligible ? '' : (row.resolver?.reason || row.captionLoadError || 'not_train_eligible'),
      },
      recordingDate,
      scriptBatchId: shootId,
      shootId,
      normalizedScriptHash: hash,
      generalizationGroupId: '',
      durationSec: row.project.durationSec,
      candidateCount: (row.candidates || []).length,
      manualEventCount: (row.manualEvents || []).filter((event) => event.family && !event.isAutomation).length,
      manualCaptionFamilyEventCount: (row.manualEvents || [])
        .filter((event) => (event.captionFamily || captionFamilies.has(event.family)) && !event.isAutomation)
        .length,
      sourceProjectKnown: sourceById.has(projectId),
    };
  }).sort((a, b) => a.recordingDate.localeCompare(b.recordingDate) || a.projectId.localeCompare(b.projectId));
  buildConnectedComponents(entries);
  return {
    schemaVersion: 1,
    protocol: protocol.protocol,
    sourceCorpus: 'data/sfx-automation-v2/visible-caption-corpus.jsonl',
    groupingNotes: [
      'generalizationGroupId is built from metadata-only connected components.',
      'Projects are connected by shared scriptBatchId, shootId, or exact normalized script hash.',
      'Manual SFX labels, model scores, and family performance are not used for grouping.',
    ],
    projects: entries,
  };
}

function buildSplits(manifest) {
  const eligible = manifest.projects.filter((project) => project.trainEligible);
  const groups = [...new Set(eligible.map((project) => project.generalizationGroupId))].sort();
  return {
    schemaVersion: 1,
    protocol: protocol.protocol,
    splitStrategy: 'leave-one-generalizationGroupId-out',
    folds: groups.map((groupId, index) => {
      const testProjectIds = eligible
        .filter((project) => project.generalizationGroupId === groupId)
        .map((project) => project.projectId)
        .sort();
      const trainProjectIds = eligible
        .filter((project) => project.generalizationGroupId !== groupId)
        .map((project) => project.projectId)
        .sort();
      return {
        foldId: `outer_${String(index + 1).padStart(2, '0')}`,
        generalizationGroupId: groupId,
        trainProjectIds,
        testProjectIds,
      };
    }),
  };
}

function buildPolicySearchSpace() {
  return {
    schemaVersion: 1,
    protocol: protocol.protocol,
    modelConfigGrid: [
      {
        id: 'caption-beat-linear-v1-fixed-c',
        emitC: 0.10,
        familyC: 0.10,
        note: 'Hyperparameters are immutable for protocol v1; only policy thresholds are selected inside inner CV.',
      },
    ],
    policySelection: {
      thresholdSource: 'inner-oof-family-joint-quantiles',
      quantiles: [0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.925, 0.95, 0.975, 0.99, 0.995],
      immutableFields: ['gateThreshold', 'conditionalThreshold', 'marginProbability', 'cooldownSeconds', 'globalCooldownSeconds', 'beatNmsSeconds', 'maxPerMinute', 'priority'],
      tieBreakers: ['higher_recall', 'higher_wilson_lower_90', 'higher_precision', 'fewer_generated_events', 'more_conservative_thresholds', 'lexicographic_policy_json'],
    },
    familyDefaults,
    precisionFloors,
  };
}

function writeJson(relativePath, value) {
  writeFileSync(resolve(validationRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  mkdirSync(validationRoot, { recursive: true });
  const manifest = buildManifest();
  const splits = buildSplits(manifest);
  const searchSpace = buildPolicySearchSpace();
  writeJson('protocol-v1.json', protocol);
  writeJson('project-manifest-v1.json', manifest);
  writeJson('outer-splits-v1.json', splits);
  writeJson('policy-search-space-v1.json', searchSpace);
  console.log(JSON.stringify({
    validationRoot,
    projectCount: manifest.projects.length,
    trainEligibleProjectCount: manifest.projects.filter((project) => project.trainEligible).length,
    outerFoldCount: splits.folds.length,
  }, null, 2));
}

main();
