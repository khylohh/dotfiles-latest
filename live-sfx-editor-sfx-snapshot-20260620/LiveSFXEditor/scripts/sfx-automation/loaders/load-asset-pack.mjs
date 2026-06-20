import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const defaultPackRoot = join(homedir(), 'Library', 'Application Support', 'Command Center', 'SFX Automation', 'packs', 'jancy-editor-v1');

export function defaultAutomationPackRoot() {
  return defaultPackRoot;
}

export function loadAutomationManifest(options = {}) {
  const packRoot = resolve(String(options.packRoot || defaultPackRoot));
  const currentPath = options.currentPath ? resolve(String(options.currentPath)) : join(packRoot, 'current.json');
  if (!existsSync(currentPath)) {
    throw new Error(`SFX automation pack is not built yet: ${currentPath}`);
  }
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const manifestPath = resolve(dirname(currentPath), String(current.manifestPath || ''));
  if (!existsSync(manifestPath)) {
    throw new Error(`SFX automation manifest is missing: ${manifestPath}`);
  }
  const releaseRoot = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'CommandCenterSFXAutomationAssetPack' || manifest.schemaVersion !== 1) {
    throw new Error(`Invalid SFX automation manifest: ${manifestPath}`);
  }
  const assetsById = new Map();
  const pools = new Map();
  for (const asset of manifest.assets || []) {
    const absolutePath = resolve(releaseRoot, String(asset.relativePath || ''));
    if (!absolutePath.startsWith(releaseRoot)) {
      throw new Error(`Asset path escapes release root: ${asset.relativePath}`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`Asset file is missing: ${absolutePath}`);
    }
    const stat = statSync(absolutePath);
    if (Number(asset.byteLength) > 0 && stat.size !== Number(asset.byteLength)) {
      throw new Error(`Asset byte length mismatch: ${absolutePath}`);
    }
    assetsById.set(asset.assetId, { ...asset, absolutePath });
  }
  for (const [poolId, pool] of Object.entries(manifest.pools || {})) {
    const assets = (pool.assetIds || []).map((assetId) => assetsById.get(assetId)).filter(Boolean);
    if (assets.length < Number(pool.minimumReadyAssets || 0)) {
      throw new Error(`SFX automation pool "${poolId}" has ${assets.length}/${pool.minimumReadyAssets} ready assets.`);
    }
    pools.set(poolId, { ...pool, assets });
  }
  return { packRoot, currentPath, manifestPath, releaseRoot, manifest, assetsById, pools };
}
