#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifestPath = resolve(editorRoot, 'validation/project-manifest-v1.json');
const defaultSplitsPath = resolve(editorRoot, 'validation/outer-splits-v1.json');
const defaultOutPath = resolve(editorRoot, 'validation/caption-router-protocol-v3.json');

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    args.set(key, value);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const manifestPath = resolve(String(args.get('project-manifest') || defaultManifestPath));
  const splitsPath = resolve(String(args.get('outer-splits') || defaultSplitsPath));
  const outPath = resolve(String(args.get('out') || defaultOutPath));
  const manifest = readJson(manifestPath);
  const splits = readJson(splitsPath);
  const protocol = {
    schemaVersion: 3,
    protocol: 'caption-moment-router-v3-nested-grouped',
    randomSeed: 20260621,
    sourceCorpus: 'data/sfx-automation-v3/caption-moment-corpus.jsonl',
    projectManifest: manifestPath,
    outerSplits: splitsPath,
    splitStrategy: splits.splitStrategy || 'leave-one-generalizationGroupId-out',
    groupingNotes: manifest.groupingNotes || [],
    lockedFinalHoldout: 'footage_06_10_26_sfx',
    openedBlindProjectExcluded: 'blind_caption_only_06_17_26',
    outerMetric: 'outer-fold-only',
    productMetric: 'matched human placements / all human placements, generated attempts, false additions, net saved edits',
    routeClasses: [
      'none',
      'pop',
      'ding',
      'success',
      'bonk',
      'funny',
      'bruh',
      'record_scratch',
      'dramatic',
      'other_sfx',
    ],
    emittableClasses: ['pop', 'ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch', 'dramatic'],
    nonEmittingClasses: ['none', 'other_sfx'],
    modelGrid: {
      cValues: [0.03, 0.10, 0.30],
      thresholds: [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90],
      globalNmsSeconds: 0.30,
    },
    stopGoDecision: 'Do not wire runtime V3 unless outer aggregate net saved edits is positive.',
  };
  writeJson(outPath, protocol);
  console.log(JSON.stringify({ outPath, foldCount: splits.folds?.length || 0 }, null, 2));
}

main();
