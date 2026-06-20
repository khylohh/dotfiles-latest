#!/usr/bin/env node
import { resolve } from 'node:path';
import { readLiveSFXDescriptor, writeLiveSFXDescriptorCopy } from '../lib/live-sfx-project-io.mjs';
import { generateSFXPass } from '../sfx-automation/run-sfx-pass.mjs';

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

async function main() {
  const args = parseArgs(process.argv);
  const projectPath = args.get('project') ? resolve(String(args.get('project'))) : '';
  const outPath = args.get('out') ? resolve(String(args.get('out'))) : '';
  if (!projectPath) throw new Error('--project is required');
  if (!outPath) throw new Error('--out is required');
  const seed = String(args.get('seed') || 'sfx-v1');
  const scorer = String(args.get('scorer') || 'local');
  if (scorer !== 'local') {
    throw new Error(`Phase 1 CLI only supports --scorer local, got "${scorer}"`);
  }
  const { project: loadedProject } = readLiveSFXDescriptor(projectPath);
  const project = boolArg(args, 'clear-events')
    ? { ...loadedProject, events: [], decks: {} }
    : loadedProject;
  const regionStart = Number(args.get('region-start'));
  const regionEnd = Number(args.get('region-end'));
  const result = generateSFXPass(project, {
    seed,
    scorer,
    packRoot: args.get('pack-root'),
    policyPath: args.get('policy') ? resolve(String(args.get('policy'))) : undefined,
    region: {
      start: Number.isFinite(regionStart) ? regionStart : undefined,
      end: Number.isFinite(regionEnd) ? regionEnd : undefined,
    },
    renameProject: true,
  });
  const written = writeLiveSFXDescriptorCopy(result.project, outPath);
  const stats = {
    ...result.stats,
    output: written.projectFilePath,
    backingProjectPath: written.backingProjectPath,
  };
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
