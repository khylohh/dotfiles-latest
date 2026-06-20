#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerScript = resolve(editorRoot, 'scripts/sfx/run-positive-accent-codex-worker.mjs');

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

function packetFilesFromRoot(rootPath) {
  const root = resolve(rootPath);
  const manifestPath = join(root, 'selector-packet-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    return (manifest.packets || []).map((packet) => resolve(packet.path));
  }
  return [];
}

function main() {
  const args = parseArgs(process.argv);
  const packetsRoot = args.get('packets-root') ? resolve(String(args.get('packets-root'))) : '';
  if (!packetsRoot) throw new Error('--packets-root is required');
  const outRoot = args.get('out-root')
    ? resolve(String(args.get('out-root')))
    : join(packetsRoot, 'selections-codex');
  const model = args.get('model') ? String(args.get('model')) : '';
  const limit = Math.max(0, Math.round(Number(args.get('limit') || 0)));
  const overwrite = boolArg(args, 'overwrite');
  const verbose = boolArg(args, 'verbose');
  mkdirSync(outRoot, { recursive: true });

  let packetFiles = packetFilesFromRoot(packetsRoot);
  if (!packetFiles.length) {
    throw new Error(`No selector-packet-manifest.json packets found under ${packetsRoot}`);
  }
  if (limit) packetFiles = packetFiles.slice(0, limit);

  let completed = 0;
  let skipped = 0;
  for (const packetPath of packetFiles) {
    const packetBase = basename(packetPath, '.json');
    const outPath = join(outRoot, `${packetBase}.selection.json`);
    if (!overwrite && existsSync(outPath)) {
      skipped += 1;
      continue;
    }
    const commandArgs = [
      workerScript,
      '--packet',
      packetPath,
      '--out',
      outPath,
    ];
    if (model) commandArgs.push('--model', model);
    if (!verbose) commandArgs.push('--quiet');
    console.error(`[${completed + skipped + 1}/${packetFiles.length}] ${basename(packetPath)} -> ${basename(outPath)}`);
    const result = spawnSync(process.execPath, commandArgs, {
      cwd: editorRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Worker failed for ${packetPath} with exit code ${result.status}`);
    }
    completed += 1;
  }

  console.log(JSON.stringify({
    packetsRoot,
    outRoot,
    requestedPackets: packetFiles.length,
    completed,
    skipped,
  }, null, 2));
}

main();
