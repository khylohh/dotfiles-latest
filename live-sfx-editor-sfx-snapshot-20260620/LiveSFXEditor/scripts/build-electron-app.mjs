import { cpSync, existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Map();

for (let i = 2; i < process.argv.length; i += 1) {
  const item = process.argv[i];
  if (item.startsWith('--')) {
    args.set(item.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const appName = String(args.get('app-name') || 'Live SFX Editor');
const bundleId = String(args.get('bundle-id') || 'com.commandcenter.live-sfx-editor');
const outputApp = resolve(String(args.get('output-app') || `/Applications/${appName}.app`));
const electronApp = [
  join(root, 'node_modules', 'electron', 'dist', 'Electron.app'),
  '/Users/kyle/Documents/Command Center Project/CaptionAIEditor/node_modules/electron/dist/Electron.app',
].find((candidate) => existsSync(candidate)) || '';
const sourceMain = join(root, 'electron', 'main.cjs');
const sourceIcon = join(root, 'electron', 'LiveSFX.icns');
const sourceProjectIcon = join(root, 'electron', 'LiveSFXProject.icns');

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function setPlistString(plist, key, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
  if (set.status === 0) return;
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
}

function runPlistBuddy(plist, commands) {
  for (const command of commands) {
    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'ignore' });
    if (result.status !== 0 && !command.startsWith('Delete ')) {
      run('/usr/libexec/PlistBuddy', ['-c', command, plist]);
    }
  }
}

if (!electronApp) {
  console.error('Electron runtime is missing. Install Electron in LiveSFXEditor or keep CaptionAIEditor/node_modules available.');
  process.exit(2);
}
if (!existsSync(sourceMain)) {
  console.error(`Electron main file is missing: ${sourceMain}`);
  process.exit(2);
}

rmSync(outputApp, { recursive: true, force: true });
mkdirSync(dirname(outputApp), { recursive: true });
cpSync(electronApp, outputApp, { recursive: true, verbatimSymlinks: true });

const contentsDir = join(outputApp, 'Contents');
const resourcesDir = join(contentsDir, 'Resources');
const macosDir = join(contentsDir, 'MacOS');
const oldExecutable = join(macosDir, 'Electron');
const newExecutable = join(macosDir, appName);
if (existsSync(oldExecutable)) {
  renameSync(oldExecutable, newExecutable);
}

const appResourcesDir = join(resourcesDir, 'app');
rmSync(appResourcesDir, { recursive: true, force: true });
mkdirSync(appResourcesDir, { recursive: true });
cpSync(sourceMain, join(appResourcesDir, 'main.cjs'));
if (existsSync(sourceIcon)) {
  cpSync(sourceIcon, join(resourcesDir, 'LiveSFX.icns'));
  cpSync(sourceIcon, join(resourcesDir, 'electron.icns'));
  cpSync(sourceIcon, join(appResourcesDir, 'LiveSFX.icns'));
}
if (existsSync(sourceProjectIcon)) {
  cpSync(sourceProjectIcon, join(resourcesDir, 'LiveSFXProject.icns'));
  cpSync(sourceProjectIcon, join(appResourcesDir, 'LiveSFXProject.icns'));
}
writeFileSync(
  join(appResourcesDir, 'package.json'),
  `${JSON.stringify({ name: 'live-sfx-editor-shell', version: '1.0.0', main: 'main.cjs' }, null, 2)}\n`,
  'utf8',
);

const plist = join(contentsDir, 'Info.plist');
setPlistString(plist, 'CFBundleExecutable', appName);
setPlistString(plist, 'CFBundleIdentifier', bundleId);
setPlistString(plist, 'CFBundleName', appName);
setPlistString(plist, 'CFBundleDisplayName', appName);
if (existsSync(sourceIcon)) {
  setPlistString(plist, 'CFBundleIconFile', 'LiveSFX.icns');
}
runPlistBuddy(plist, [
  'Delete :CFBundleDocumentTypes',
  'Add :CFBundleDocumentTypes array',
  'Add :CFBundleDocumentTypes:0 dict',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeName string Live SFX Interface Project',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor',
  'Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string sfxinterface',
  `Add :CFBundleDocumentTypes:0:CFBundleTypeIconFile string ${existsSync(sourceProjectIcon) ? 'LiveSFXProject.icns' : 'LiveSFX.icns'}`,
  'Delete :UTExportedTypeDeclarations',
  'Add :UTExportedTypeDeclarations array',
  'Add :UTExportedTypeDeclarations:0 dict',
  'Add :UTExportedTypeDeclarations:0:UTTypeIdentifier string com.commandcenter.live-sfx-interface-project',
  'Add :UTExportedTypeDeclarations:0:UTTypeDescription string Live SFX Interface Project',
  'Add :UTExportedTypeDeclarations:0:UTTypeConformsTo array',
  'Add :UTExportedTypeDeclarations:0:UTTypeConformsTo:0 string public.json',
  'Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification dict',
  'Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array',
  'Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string sfxinterface',
  'Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.mime-type string application/vnd.live-sfx.interface+json',
]);

const helperApps = [
  ['Electron Helper.app', 'helper', 'Live SFX Editor Helper'],
  ['Electron Helper (GPU).app', 'helper.gpu', 'Live SFX Editor Helper (GPU)'],
  ['Electron Helper (Plugin).app', 'helper.plugin', 'Live SFX Editor Helper (Plugin)'],
  ['Electron Helper (Renderer).app', 'helper.renderer', 'Live SFX Editor Helper (Renderer)'],
];
for (const [helperName, helperSuffix, helperDisplayName] of helperApps) {
  const helperContents = join(contentsDir, 'Frameworks', helperName, 'Contents');
  const helperPlist = join(helperContents, 'Info.plist');
  if (!existsSync(helperPlist)) continue;
  if (existsSync(sourceIcon)) {
    const helperResources = join(helperContents, 'Resources');
    mkdirSync(helperResources, { recursive: true });
    cpSync(sourceIcon, join(helperResources, 'LiveSFX.icns'));
    setPlistString(helperPlist, 'CFBundleIconFile', 'LiveSFX.icns');
  }
  setPlistString(helperPlist, 'CFBundleIdentifier', `${bundleId}.${helperSuffix}`);
  setPlistString(helperPlist, 'CFBundleName', helperDisplayName);
  setPlistString(helperPlist, 'CFBundleDisplayName', helperDisplayName);
}
run('codesign', ['--force', '--deep', '--sign', '-', outputApp]);

console.log(`Electron app built: ${outputApp}`);
