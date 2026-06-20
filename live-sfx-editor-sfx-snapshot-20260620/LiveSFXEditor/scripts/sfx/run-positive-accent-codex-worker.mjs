#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSchemaPath = resolve(editorRoot, 'config/sfx-automation-v1/positive-accent-selector-schema.json');

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

function compactPacketForPrompt(packet) {
  const styleReferenceSegments = packet.styleReferenceSegments || [];
  return {
    schemaVersion: packet.schemaVersion,
    protocol: packet.protocol,
    packetId: packet.packetId,
    segmentId: packet.segmentId,
    projectId: packet.projectId,
    coreStartSec: packet.coreStartSec,
    coreEndSec: packet.coreEndSec,
    markedCaptionText: packet.markedCaptionText,
    allowedCandidateIds: packet.allowedCandidateIds,
    candidates: (packet.candidates || []).map((candidate) => ({
      candidateId: candidate.candidateId,
      relativeTimeSec: candidate.relativeTimeSec,
      captionText: candidate.captionText,
      speakerKey: candidate.speakerKey,
      anchorTypes: candidate.anchorTypes,
      precedingGapSec: candidate.precedingGapSec,
      followingGapSec: candidate.followingGapSec,
      boundaryStrength: candidate.boundaryStrength,
      nearestZoomDeltaSec: candidate.nearestZoomDeltaSec,
    })),
    styleReferenceSegments,
    retrievalExamples: styleReferenceSegments.length ? [] : packet.retrievalExamples || [],
  };
}

function workerPrompt(packet) {
  const coreDurationSec = Math.max(1, Number(packet.coreEndSec || 0) - Number(packet.coreStartSec || 0));
  const typicalUpper = Math.max(2, Math.ceil(coreDurationSec / 30) * 2);
  return [
    'You are the Command Center positive-accent SFX selector.',
    '',
    'The selector packet is embedded below. Do not run shell commands or read files.',
    '',
    'Your task is to choose which supplied candidate IDs deserve a ding or success sound effect.',
    'You must only choose candidate IDs listed in allowedCandidateIds for this exact packet.',
    'Do not invent timestamps. Do not output confidence. Do not output commentary.',
    'Return only JSON matching the provided output schema.',
    'Default to no selections. A missed good moment is better than adding a bad sound.',
    `This packet core is about ${Math.round(coreDurationSec)} seconds. Most 30-second spans should have 0, 1, or 2 selections; for this packet, more than ${typicalUpper} selections should be rare and only for separate, unmistakable payoffs.`,
    '',
    'Definitions:',
    '- success: completed task, achieved result, solved problem, correct answer, win, finished outcome.',
    '- ding: reveal, positive detail, pleasant discovery, item attribute, specific answer, count/value, selection confirmation.',
    '- If ding and success feel interchangeable, choose ding unless completion/result is clearly the point.',
    '',
    'Reject:',
    '- future plans, attempts, or setup without realized payoff',
    '- generic yeah/cool/good reactions without a specific editorial point',
    '- failure, suspense, mishap, dramatic escalation, or comedy beats',
    '- moments whose meaning requires an unseen visual unless the caption names the actual revealed detail',
    '- generic commands, counting, birthday singing, filler narration, or routine activity',
    '- bare reactions like "oh my god", "what?", "what is this?", "look", or "no way" unless the caption itself gives the revealed object/detail',
    '- positive-sounding lines that are only setup, transition, or encouragement',
    '- multiple accents for the same payoff',
    '',
    'When a payoff spans several candidate IDs, choose only the single best final/payoff candidate.',
    '',
    'Use styleReferenceSegments as the strongest taste guide when present.',
    'They are training-project segments: editorDecision=ding/success means the human placed a positive-accent sound; editorDecision=skip means the human skipped that candidate; editorDecision=other_sfx means another sound family was used and you should not choose ding/success for that pattern.',
    'Notice the density: many plausible positive/reveal/detail captions are skipped. Select current candidates only when they are as strong as the selected reference candidates and clearly stronger than skipped reference candidates.',
    'First decide the few real editorial payoff moments in the current segment, then map each payoff to one allowed candidate ID.',
    '',
    'Use retrievalExamples only as examples from training projects. They are not from this test project.',
    'The packet candidates do not include labels. Judge the current segment from captions, timing, anchors, and examples.',
    '',
    'PACKET_JSON:',
    JSON.stringify(compactPacketForPrompt(packet)),
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const packetPath = args.get('packet') ? resolve(String(args.get('packet'))) : '';
  const outPath = args.get('out') ? resolve(String(args.get('out'))) : '';
  const schemaPath = args.get('schema') ? resolve(String(args.get('schema'))) : defaultSchemaPath;
  const model = args.get('model') ? String(args.get('model')) : 'gpt-5.5';
  const quiet = boolArg(args, 'quiet');
  if (!packetPath) throw new Error('--packet is required');
  if (!outPath) throw new Error('--out is required');
  if (!existsSync(packetPath)) throw new Error(`Packet not found: ${packetPath}`);
  if (!existsSync(schemaPath)) throw new Error(`Schema not found: ${schemaPath}`);
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  mkdirSync(dirname(outPath), { recursive: true });

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
    outPath,
    '--color',
    'never',
  ];
  commandArgs.push('--model', model);
  commandArgs.push(workerPrompt(packet));

  const result = spawnSync('codex', commandArgs, {
    cwd: editorRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codex exec failed with exit code ${result.status}`);
  }
  if (!quiet) console.log(JSON.stringify({ output: outPath, packet: packetPath }, null, 2));
}

main();
