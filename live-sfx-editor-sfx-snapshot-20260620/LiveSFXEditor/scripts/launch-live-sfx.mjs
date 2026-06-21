import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodePath = process.execPath;
const sourceEditorRoot = '/Users/kyle/Documents/Command Center Project/LiveSFXEditor';
const args = new Map();

for (let i = 2; i < process.argv.length; i += 1) {
  const item = process.argv[i];
  if (item.startsWith('--')) {
    args.set(item.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

function optionalArg(name) {
  const value = args.get(name);
  return value ? String(value) : '';
}

function readSFXProjectFile(filePath) {
  if (!filePath) return {};
  const resolved = resolve(filePath);
  const data = JSON.parse(readFileSync(resolved, 'utf8'));
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid Live SFX project file: ${resolved}`);
  }
  return { ...data, projectFilePath: resolved };
}

function restoreSnapshotProjectIfNeeded(targetProjectPath, projectFileConfig) {
  if (existsSync(targetProjectPath)) return;
  const snapshot = projectFileConfig.projectSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
  mkdirSync(dirname(targetProjectPath), { recursive: true });
  writeFileSync(
    targetProjectPath,
    `${JSON.stringify({ ...snapshot, projectFilePath: projectFileConfig.projectFilePath || snapshot.projectFilePath }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Restored Live SFX project JSON from .sfxinterface snapshot: ${targetProjectPath}`);
}

function findPort(preferred) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => {
      const randomServer = createServer();
      randomServer.listen(0, '127.0.0.1', () => {
        const address = randomServer.address();
        const port = typeof address === 'object' && address ? address.port : preferred + 1;
        randomServer.close(() => resolvePort(port));
      });
    });
    server.listen(preferred, '127.0.0.1', () => {
      server.close(() => resolvePort(preferred));
    });
  });
}

function waitForPort(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolveReady, rejectReady) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          rejectReady(new Error(`Live SFX bridge did not open port ${port} within ${timeoutMs}ms.`));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function ensureBuilt() {
  if (existsSync(join(root, 'dist', 'index.html'))) return;
  const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const vitePath = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(tscPath) || !existsSync(vitePath)) return;
  const build = spawnSync(nodePath, [tscPath, '-b'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const vite = spawnSync(nodePath, [vitePath, 'build'], { cwd: root, stdio: 'inherit' });
  if (vite.status !== 0) process.exit(vite.status ?? 1);
}

function buildStandaloneAppIfNeeded() {
  if (existsSync(standaloneExecutable) && args.get('refresh-electron-app') !== 'true') {
    return true;
  }

  const builderCandidates = [
    join(root, 'scripts', 'build-electron-app.mjs'),
    join(sourceEditorRoot, 'scripts', 'build-electron-app.mjs'),
  ];
  for (const builder of builderCandidates) {
    if (!existsSync(builder)) continue;
    const builderRoot = resolve(builder, '..', '..');
    const result = spawnSync(
      nodePath,
      [builder, '--app-name', standaloneAppName, '--output-app', standaloneAppPath],
      { cwd: builderRoot, stdio: 'inherit' },
    );
    if (result.status === 0 && existsSync(standaloneExecutable)) return true;
  }
  return false;
}

function sanitizedElectronEnv() {
  const keep = [
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSH_AUTH_SOCK',
    '__CF_USER_TEXT_ENCODING',
    'XPC_FLAGS',
    'XPC_SERVICE_NAME',
  ];
  const clean = {};
  for (const key of keep) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  clean.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  clean.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  clean.ELECTRON_NO_ATTACH_CONSOLE = 'true';
  return clean;
}

function launchDateStamp() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear()).slice(-2);
  return `${month}-${day}-${year}`;
}

function mediaDefaultOutputDir(mediaPath) {
  return join(dirname(mediaPath), `SFX Project ${launchDateStamp()}`);
}

function mediaDefaultProjectFile(mediaPath) {
  return join(dirname(mediaPath), `${basename(mediaPath, extname(mediaPath))} SFX.sfxinterface`);
}

const projectFile = optionalArg('project-file') ? resolve(optionalArg('project-file')) : '';
const projectFileConfig = readSFXProjectFile(projectFile);
const preferredPort = Number(args.get('port') || 5187);
const mediaRaw = optionalArg('media') || projectFileConfig.mediaPath || '';
const zoomXmlRaw = optionalArg('zoom-xml') || projectFileConfig.zoomXmlPath || '';
const captionRaw = optionalArg('caption') || projectFileConfig.captionProjectPath || projectFileConfig.captionPath || '';
const media = mediaRaw ? resolve(String(mediaRaw)) : '';
const zoomXml = zoomXmlRaw ? resolve(String(zoomXmlRaw)) : '';
const captionProject = captionRaw ? resolve(String(captionRaw)) : '';
const genericOutputDir = resolve(join(homedir(), 'Desktop', 'Live SFX Projects'));
const requestedOutputDir = resolve(String(optionalArg('output-dir') || projectFileConfig.outputDir || genericOutputDir));
const useMediaScopedDefault = Boolean(media)
  && !projectFile
  && !optionalArg('project')
  && requestedOutputDir === genericOutputDir;
const outputDir = resolve(useMediaScopedDefault ? mediaDefaultOutputDir(media) : requestedOutputDir);
const defaultProjectFile = useMediaScopedDefault ? mediaDefaultProjectFile(media) : '';
const project = optionalArg('project')
  ? resolve(optionalArg('project'))
  : projectFileConfig.projectPath
    ? resolve(String(projectFileConfig.projectPath))
    : join(outputDir, 'live_sfx_project.json');
const libraryRoot = resolve(String(optionalArg('library-root') || projectFileConfig.libraryRoot || '/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX'));
const manualRoot = resolve(String(optionalArg('manual-root') || projectFileConfig.manualRoot || '/Users/kyle/Desktop/2026 SFX/Categories/Manual SFX'));
const standaloneAppName = 'Live SFX Editor';
const standaloneAppPath = `/Applications/${standaloneAppName}.app`;
const standaloneExecutable = join(standaloneAppPath, 'Contents', 'MacOS', standaloneAppName);

mkdirSync(outputDir, { recursive: true });
restoreSnapshotProjectIfNeeded(project, projectFileConfig);
ensureBuilt();

const port = await findPort(preferredPort);
const url = `http://127.0.0.1:${port}`;
const bridgeArgs = [
  join(root, 'scripts/live-sfx-bridge.mjs'),
  '--project', project,
  '--output-dir', outputDir,
  '--library-root', libraryRoot,
  '--manual-root', manualRoot,
  '--port', String(port),
];
if (media) bridgeArgs.push('--media', media);
if (zoomXml) bridgeArgs.push('--zoom-xml', zoomXml);
if (captionProject) bridgeArgs.push('--caption', captionProject);
if (projectFile || defaultProjectFile) bridgeArgs.push('--project-file', projectFile || defaultProjectFile);

const bridge = spawn(nodePath, bridgeArgs, {
  cwd: root,
  stdio: 'inherit',
});

await waitForPort(port);

if (!buildStandaloneAppIfNeeded()) {
  bridge.kill();
  console.error('Could not build or find Live SFX Editor Electron app.');
  process.exit(1);
}

const editorApp = spawn(standaloneExecutable, ['--url', url, '--title', standaloneAppName], {
  cwd: root,
  env: sanitizedElectronEnv(),
  stdio: 'ignore',
});

console.log(`Live SFX Editor opened in Electron: ${url}`);

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bridge.kill('SIGTERM');
  setTimeout(() => bridge.kill('SIGKILL'), 800).unref();
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
editorApp.on('exit', shutdown);
bridge.on('exit', (code) => {
  process.exit(shuttingDown ? 0 : code ?? 0);
});
