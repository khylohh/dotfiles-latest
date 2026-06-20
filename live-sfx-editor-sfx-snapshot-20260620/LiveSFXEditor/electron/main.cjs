const { app, BrowserWindow, Menu, nativeImage, session, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TITLE = 'Live SFX Editor';

function readArg(name, fallback = '') {
  const prefixed = `--${name}=`;
  const directIndex = process.argv.indexOf(`--${name}`);
  if (directIndex >= 0 && process.argv[directIndex + 1]) {
    return process.argv[directIndex + 1];
  }
  const value = process.argv.find((item) => item.startsWith(prefixed));
  return value ? value.slice(prefixed.length) : fallback;
}

const url = readArg('url');
const title = readArg('title', DEFAULT_TITLE);
const iconPath = readArg('icon', path.join(__dirname, 'LiveSFX.icns'));
let pendingProjectFilePath = readArg('project-file') || process.argv.find((item) => /\.sfxinterface$/i.test(item)) || '';

app.setName(title);
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');
app.commandLine.appendSwitch('disable-features', 'ElasticOverscroll,SpellingService');

const icon = nativeImage.createFromPath(iconPath);
if (!icon.isEmpty() && app.dock) {
  app.dock.setIcon(icon);
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Keep trying fallbacks.
    }
  }
  return '';
}

function nodeExecutablePath() {
  return firstExistingPath([
    '/Applications/Codex.app/Contents/Resources/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]);
}

function launcherScriptPath() {
  return firstExistingPath([
    '/Applications/Command Center/Command Center.app/Contents/Resources/LiveSFXEditor/scripts/launch-live-sfx.mjs',
    '/Users/kyle/Documents/Command Center Project/LiveSFXEditor/scripts/launch-live-sfx.mjs',
    path.join(process.resourcesPath || '', 'LiveSFXEditor', 'scripts', 'launch-live-sfx.mjs'),
  ]);
}

function launchProjectFile(filePath) {
  const nodePath = nodeExecutablePath();
  const launcherPath = launcherScriptPath();
  if (!nodePath || !launcherPath) {
    dialog.showErrorBox(
      'Live SFX Editor',
      'Could not find the Live SFX Editor launcher. Open the tool from Command Center once, then try the project file again.',
    );
    app.quit();
    return;
  }
  const child = spawn(nodePath, [launcherPath, '--project-file', filePath], {
    cwd: path.dirname(path.dirname(launcherPath)),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  app.quit();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: title,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ]);
}

function createWindow() {
  if (!url && pendingProjectFilePath) {
    launchProjectFile(pendingProjectFilePath);
    return;
  }
  if (!url) {
    throw new Error('Live SFX Editor requires --url');
  }

  const window = new BrowserWindow({
    title,
    minWidth: 1280,
    minHeight: 780,
    backgroundColor: '#05060b',
    fullscreen: true,
    show: false,
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    window.focus();
  });

  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== url) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  void window.loadURL(url);
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  pendingProjectFilePath = filePath;
  if (app.isReady() && !url) {
    launchProjectFile(filePath);
  }
});

app.whenReady().then(() => {
  session.defaultSession.setSpellCheckerEnabled(false);
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
