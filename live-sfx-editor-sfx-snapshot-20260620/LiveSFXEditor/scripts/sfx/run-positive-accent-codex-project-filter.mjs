#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSchemaPath = resolve(editorRoot, 'config/sfx-automation-v1/positive-accent-project-filter-schema.json');

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

function boolArg(args, key) {
  const value = args.get(key);
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packetFilesFromRoot(rootPath) {
  const root = resolve(rootPath);
  const manifestPath = join(root, 'selector-packet-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing selector-packet-manifest.json under ${root}`);
  const manifest = readJson(manifestPath);
  return (manifest.packets || []).map((packet) => resolve(packet.path));
}

function selectionPathForPacket(packetPath, selectionsRoot) {
  const base = basename(packetPath, '.json');
  return join(resolve(selectionsRoot), `${base}.selection.json`);
}

function captionContext(packet, candidate) {
  const cueIds = new Set(candidate?.cueIds || []);
  const cueIndexes = (packet.cues || [])
    .map((cue, index) => (cueIds.has(cue.cueId) ? index : -1))
    .filter((index) => index >= 0);
  if (!cueIndexes.length) return String(candidate?.captionText || '');
  const start = Math.max(0, Math.min(...cueIndexes) - 3);
  const end = Math.min((packet.cues || []).length, Math.max(...cueIndexes) + 4);
  return (packet.cues || []).slice(start, end).map((cue) => {
    const marker = cueIds.has(cue.cueId) ? '>' : ' ';
    return `${marker} [${cue.startSec}] ${cue.speakerKey}: ${cue.text}`;
  }).join('\n');
}

function buildProjectPacket(packetFiles, selectionsRoot) {
  const proposals = [];
  const packetByCandidate = new Map();
  let projectId = '';
  for (const packetPath of packetFiles) {
    const packet = readJson(packetPath);
    projectId = projectId || packet.projectId;
    if (packet.projectId !== projectId) throw new Error('Project filter only supports one project per run');
    const outputPath = selectionPathForPacket(packetPath, selectionsRoot);
    if (!existsSync(outputPath)) throw new Error(`Missing selection output: ${outputPath}`);
    const output = readJson(outputPath);
    const candidatesById = new Map((packet.candidates || []).map((candidate) => [candidate.candidateId, candidate]));
    for (const selection of output.selections || []) {
      const candidate = candidatesById.get(selection.candidateId);
      if (!candidate) continue;
      packetByCandidate.set(selection.candidateId, {
        packetPath,
        packet,
        selection,
      });
      proposals.push({
        candidateId: selection.candidateId,
        segmentId: packet.segmentId,
        absoluteTimeSec: candidate.absoluteTimeSec,
        selectedFamily: selection.family,
        momentType: selection.momentType,
        captionText: candidate.captionText,
        anchorTypes: candidate.anchorTypes || [],
        nearestZoomDeltaSec: candidate.nearestZoomDeltaSec,
        context: captionContext(packet, candidate),
      });
    }
  }
  proposals.sort((a, b) => Number(a.absoluteTimeSec) - Number(b.absoluteTimeSec) || a.candidateId.localeCompare(b.candidateId));
  return { projectId, proposals, packetByCandidate };
}

function filterPrompt(projectPacket) {
  return [
    'You are the final Command Center positive-accent SFX selector.',
    '',
    'A first pass over-selected possible ding/success moments for one project. Your job is to keep only the proposals that should become editable SFX Interface items.',
    'Return only JSON matching the schema. Do not output commentary.',
    '',
    'High precision matters more than coverage. Reject any proposal that feels merely positive, cute, explanatory, visual-only, setup, filler, comedy, dramatic, pop, boom, scary, suspense, or another SFX family.',
    'Keep a proposal only when the caption itself names a clear ding/success-style payoff that a human editor would likely accent in this project.',
    'Prefer final/payoff wording over setup wording. If several proposals are the same payoff, keep only the single best one.',
    'Most accepted items should be ding. Use success only for a completed task, solved problem, result, or win.',
    'For a normal project, accepting a small subset is expected; do not try to make every minute have a sound.',
    '',
    'PROJECT_PACKET_JSON:',
    JSON.stringify({
      schemaVersion: 1,
      projectId: projectPacket.projectId,
      proposalCount: projectPacket.proposals.length,
      proposals: projectPacket.proposals,
    }),
  ].join('\n');
}

function writeFilteredSelections(packetFiles, selectionsRoot, projectPacket, filterResult, outRoot) {
  const acceptedByCandidate = new Map();
  for (const item of filterResult.accepted || []) {
    acceptedByCandidate.set(item.candidateId, item);
  }
  const filteredRoot = join(outRoot, 'selections-filtered');
  mkdirSync(filteredRoot, { recursive: true });
  for (const packetPath of packetFiles) {
    const packet = readJson(packetPath);
    const original = readJson(selectionPathForPacket(packetPath, selectionsRoot));
    const selections = [];
    for (const selection of original.selections || []) {
      const accepted = acceptedByCandidate.get(selection.candidateId);
      if (!accepted) continue;
      selections.push({
        candidateId: selection.candidateId,
        family: accepted.family,
        momentType: accepted.momentType,
      });
    }
    writeJson(join(filteredRoot, `${basename(packetPath, '.json')}.selection.json`), {
      schemaVersion: 1,
      segmentId: packet.segmentId,
      selections,
    });
  }
  return filteredRoot;
}

function main() {
  const args = parseArgs(process.argv);
  const packetsRoot = args.get('packets-root') ? resolve(String(args.get('packets-root'))) : '';
  const selectionsRoot = args.get('selections-root') ? resolve(String(args.get('selections-root'))) : '';
  const outRoot = args.get('out-root') ? resolve(String(args.get('out-root'))) : '';
  const schemaPath = args.get('schema') ? resolve(String(args.get('schema'))) : defaultSchemaPath;
  const model = args.get('model') ? String(args.get('model')) : 'gpt-5.5';
  const quiet = boolArg(args, 'quiet');
  if (!packetsRoot) throw new Error('--packets-root is required');
  if (!selectionsRoot) throw new Error('--selections-root is required');
  if (!outRoot) throw new Error('--out-root is required');
  if (!existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);

  const packetFiles = packetFilesFromRoot(packetsRoot);
  const projectPacket = buildProjectPacket(packetFiles, selectionsRoot);
  mkdirSync(outRoot, { recursive: true });
  const rawOutPath = join(outRoot, 'project-filter-output.json');

  const commandArgs = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--config',
    'service_tier="fast"',
    '--config',
    'model_reasoning_effort="medium"',
    '--sandbox',
    'read-only',
    '--cd',
    editorRoot,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    rawOutPath,
    '--color',
    'never',
    '--model',
    model,
    filterPrompt(projectPacket),
  ];
  const result = spawnSync('codex', commandArgs, {
    cwd: editorRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codex exec failed with exit code ${result.status}`);
  const filterResult = readJson(rawOutPath);
  if (filterResult.projectId !== projectPacket.projectId) {
    throw new Error(`Project mismatch: expected ${projectPacket.projectId}, got ${filterResult.projectId}`);
  }
  const allowed = new Set(projectPacket.proposals.map((proposal) => proposal.candidateId));
  for (const item of filterResult.accepted || []) {
    if (!allowed.has(item.candidateId)) throw new Error(`Accepted unknown candidateId: ${item.candidateId}`);
  }
  const filteredRoot = writeFilteredSelections(packetFiles, selectionsRoot, projectPacket, filterResult, outRoot);
  writeJson(join(outRoot, 'project-filter-summary.json'), {
    schemaVersion: 1,
    projectId: projectPacket.projectId,
    proposalCount: projectPacket.proposals.length,
    acceptedCount: (filterResult.accepted || []).length,
    filteredSelectionsRoot: filteredRoot,
    outputPath: rawOutPath,
  });
  console.log(JSON.stringify({
    projectId: projectPacket.projectId,
    proposalCount: projectPacket.proposals.length,
    acceptedCount: (filterResult.accepted || []).length,
    filteredSelectionsRoot: filteredRoot,
    outputPath: rawOutPath,
  }, null, 2));
}

main();
