#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSchemaPath = resolve(editorRoot, 'config/sfx-automation-v1/editorial-sfx-selector-schema.json');

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
  return {
    schemaVersion: packet.schemaVersion,
    protocol: packet.protocol,
    packetId: packet.packetId,
    foldId: packet.foldId,
    projectId: packet.projectId,
    segmentId: packet.segmentId,
    coreStartSec: packet.coreStartSec,
    coreEndSec: packet.coreEndSec,
    allowedFamilies: packet.allowedFamilies,
    allowedMomentIds: packet.allowedMomentIds,
    allowedTimingOptionIds: packet.allowedTimingOptionIds,
    soundGuide: packet.soundGuide,
    candidates: (packet.candidates || []).map((candidate) => ({
      momentId: candidate.momentId,
      kind: candidate.kind,
      relativeSec: candidate.relativeSec,
      text: candidate.text,
      captionWindow: candidate.captionWindow,
      allowedFamilies: candidate.allowedFamilies,
      gateReasons: candidate.gateReasons,
      denseHints: candidate.denseHints,
      timingOptions: (candidate.timingOptions || []).map((option) => ({
        timingOptionId: option.timingOptionId,
        relativeSec: option.relativeSec,
        anchorType: option.anchorType,
        source: option.source,
        zoomMarkerIds: option.zoomMarkerIds,
        boundaryStrength: option.boundaryStrength,
        wordTimingAvailable: option.wordTimingAvailable,
      })),
    })),
    trainingExamples: packet.trainingExamples || [],
  };
}

function workerPrompt(packet) {
  const duration = Math.max(1, Number(packet.coreEndSec || 0) - Number(packet.coreStartSec || 0));
  return [
    'You are the Command Center caption-only editorial SFX selector.',
    '',
    'The packet below is all the context you may use. Do not run shell commands, read files, inspect video, inspect audio, or infer from visuals that are not in the captions/zoom metadata.',
    'Return only JSON matching the provided schema.',
    '',
    'Goal: choose only moments where a human editor would probably place one of the supported sound families.',
    'Default to no decision. A missed sound is better than a false added sound.',
    'Only choose a moment if it is obvious enough that it would likely survive direct scoring against a finished human SFX project.',
    'Do not choose a family merely because the words can be interpreted that way. The caption must create the editorial beat on its own.',
    `This segment is about ${Math.round(duration)} seconds. More than 3 emitted sounds in this segment should be rare unless the captions contain separate obvious payoffs.`,
    '',
    'Rules:',
    '- Use only momentId values listed in allowedMomentIds.',
    '- Each candidate has its own allowedFamilies. You must only choose a family listed on that candidate.',
    '- For emitted families, use only a timingOptionId from that same candidate. Do not invent timestamps.',
    '- You may output family other_sfx when a sound belongs but it is not one of the supported automation-safe families. other_sfx is a blocker, not an emitted sound.',
    '- Do not output none. Just omit moments that should have no supported sound.',
    '- Do not choose multiple families for one moment.',
    '- If several candidates are the same payoff, choose only the best final/payoff moment.',
    '',
    'Family taste:',
    '- pop: short zoom/timing accent. Use mostly for explicit zoom marker timing or a very clear tiny reveal/accent.',
    '- ding: specific reveal, useful detail, selected item, answer, count/value, confirmation, or satisfying small payoff. Vague praise/comparison like "better", "good", "nice", or "works" is not enough.',
    '- success: completed result, solved problem, achieved goal, win, mission complete, or final correct outcome.',
    '- bonk: mistake, wrong answer, failure, clumsy/awkward outcome, or comic negative beat.',
    '- funny: actual punchline, absurdity, or joke beat. Not merely a quirky label, character description, casual wording, or line that sounds amusing in isolation.',
    '- bruh: cringe, disbelief, disappointing reveal, or deflated reaction.',
    '- record_scratch: abrupt reversal, interruption, contradiction, or wait-what pivot. A mild correction like "well, not about to" is not enough.',
    '- dramatic: boom, ominous reveal, suspense escalation, major reveal, or dramatic emphasis. Ordinary emphasis is not enough.',
    '- other_sfx: likely needs a sound, but it is visual-only, too specific, ambience/action, or not one of the supported families.',
    '',
    'Reject:',
    '- generic narration, setup, filler, routine transitions, future plans, and explanations without payoff',
    '- visual-only events unless represented by explicit zoom marker timing for pop',
    '- zoom metadata as a reason for ding/success/funny/dramatic. Zoom metadata may support pop timing, but the caption still needs its own editorial reason and allowed family for every other family.',
    '- positive-sounding lines that are only encouragement or setup',
    '- vague positive/comparative claims without a concrete revealed detail, answer, result, item, or completed outcome',
    '- labels/descriptions that sound funny in isolation but are not a clear punchline, such as ordinary character description. For example, "she is a witch" alone is not enough.',
    '- weak reversals, mild contrasts, or sentence fragments',
    '- dense sound placement just to match training density',
    '',
    'Use trainingExamples as taste examples only. They come from training projects, not this test project.',
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
    '--model',
    model,
    workerPrompt(packet),
  ];

  const result = spawnSync('codex', commandArgs, {
    cwd: editorRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codex exec failed with exit code ${result.status}`);
  if (!quiet) console.log(JSON.stringify({ packet: packetPath, output: outPath }, null, 2));
}

main();
