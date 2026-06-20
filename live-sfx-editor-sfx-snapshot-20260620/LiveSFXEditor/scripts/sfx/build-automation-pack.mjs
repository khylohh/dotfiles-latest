#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAudioFile, sha256File } from '../lib/sfx-file-analysis.mjs';
import { defaultAutomationPackRoot } from '../sfx-automation/loaders/load-asset-pack.mjs';
import { normalizeAssetName, normalizeCategoryId, poolDefinitions, rowFamily } from '../sfx-automation/taxonomy.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultSelectionConfig = join(root, 'config', 'sfx-automation-v1', 'pool-selection.json');

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

function firstHex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function median(values, fallback = 0) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction, fallback = 1.2) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function loadEvents(eventsPath) {
  const data = JSON.parse(readFileSync(eventsPath, 'utf8'));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.events)) return data.events;
  throw new Error(`No events array found in ${eventsPath}`);
}

function buildStats(events) {
  const stats = new Map();
  for (const row of events) {
    const sourcePath = row.asset_path ? resolve(String(row.asset_path)) : '';
    if (!sourcePath) continue;
    const existing = stats.get(sourcePath) ?? {
      sourcePath,
      assetName: String(row.asset_name || basename(sourcePath, extname(sourcePath))),
      normalizedAssetName: normalizeAssetName(row.asset_name || basename(sourcePath, extname(sourcePath))),
      categoryId: normalizeCategoryId(row.category_id),
      categoryIds: new Set(),
      categoryName: String(row.category_name || ''),
      libraryKind: String(row.library_kind || ''),
      rows: [],
      projectIds: new Set(),
      families: new Set(),
      family: rowFamily(row),
    };
    existing.categoryIds.add(normalizeCategoryId(row.category_id));
    existing.families.add(rowFamily(row));
    existing.rows.push(row);
    existing.projectIds.add(String(row.project_id || 'unknown'));
    stats.set(sourcePath, existing);
  }
  for (const stat of stats.values()) {
    stat.historicalCount = stat.rows.length;
    stat.historicalProjectCount = stat.projectIds.size;
    stat.durationSeconds = median(stat.rows.map((row) => Number(row.duration_sec) * Number(row.playback_rate || 1)), 0.75);
    stat.onsetSeconds = median(stat.rows.map((row) => Number(row.audible_offset_sec || 0) * Number(row.playback_rate || 1)), 0);
    stat.gainDb = median(stat.rows.map((row) => Number(row.gain_db)), 0);
    stat.playbackRates = stat.rows.map((row) => Number(row.playback_rate)).filter(Number.isFinite);
    stat.score = Math.log1p(stat.historicalCount) + 0.75 * Math.log1p(stat.historicalProjectCount);
    stat.family = preferredFamily(stat.families);
  }
  return [...stats.values()];
}

function preferredFamily(families) {
  const priority = ['record_scratch', 'bruh', 'riser', 'heavy', 'pop', 'ding', 'success', 'bonk', 'funny'];
  for (const family of priority) {
    if (families.has(family)) return family;
  }
  return 'unsupported';
}

function coverageWeight(stat, maxProjectCount) {
  const coverage = maxProjectCount > 0 ? stat.historicalProjectCount / maxProjectCount : 0;
  return Math.sqrt(stat.historicalCount) * (0.5 + 0.5 * coverage);
}

function selectCyclePool(stats, poolId, rule) {
  const category = normalizeCategoryId(rule.categoryId);
  const categoryStats = stats.filter((stat) => stat.categoryIds?.has(category));
  const filtered = categoryStats.filter((stat) => {
    return stat.historicalProjectCount >= Number(rule.minProjects || 0)
      && stat.historicalCount >= Number(rule.minUses || 0)
      && stat.durationSeconds <= Number(rule.maxDurationSeconds || Number.POSITIVE_INFINITY)
      && stat.onsetSeconds <= Number(rule.maxOnsetSeconds || Number.POSITIVE_INFINITY);
  });
  const source = filtered.length >= Number(rule.count) ? filtered : categoryStats;
  return source
    .sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath))
    .slice(0, Number(rule.count))
    .map((stat) => ({ poolId, stat, explicit: false }));
}

function selectManualAllowlist(stats, allowlist) {
  const selected = [];
  for (const item of allowlist) {
    const normalized = normalizeAssetName(item.match);
    const matches = stats.filter((stat) => stat.normalizedAssetName.includes(normalized) || normalized.includes(stat.normalizedAssetName));
    if (matches.length === 0) {
      throw new Error(`Manual allowlist asset not found in source events: ${item.match}`);
    }
    const existingMatches = matches.filter((stat) => existsSync(stat.sourcePath));
    const usable = existingMatches.length > 0 ? existingMatches : matches;
    usable.sort((a, b) => b.historicalCount - a.historicalCount || a.sourcePath.localeCompare(b.sourcePath));
    selected.push({ poolId: item.poolId, stat: usable[0], explicit: true, match: item.match });
  }
  return selected;
}

function dedupeSelections(selections) {
  const byPoolAndPath = new Map();
  for (const selection of selections) {
    const key = `${selection.poolId}\0${selection.stat.sourcePath}`;
    byPoolAndPath.set(key, selection);
  }
  return [...byPoolAndPath.values()];
}

function sourceRelativePath(stat, cycleRoot, manualRoot) {
  const source = resolve(stat.sourcePath);
  const cycle = cycleRoot ? resolve(cycleRoot) : '';
  const manual = manualRoot ? resolve(manualRoot) : '';
  if (cycle && source.startsWith(cycle)) return relative(cycle, source);
  if (manual && source.startsWith(manual)) return relative(manual, source);
  return basename(source);
}

function assetIdFor(outputCategoryId, sourcePath) {
  const bytes = readFileSync(sourcePath);
  const hash = createHash('sha256').update(String(outputCategoryId)).update('\0').update(bytes).digest('hex');
  return `sfxa_${hash.slice(0, 20)}`;
}

function playbackSamplerForFamily(stats, family) {
  const values = stats
    .filter((stat) => stat.family === family)
    .flatMap((stat) => stat.playbackRates)
    .filter((value) => value > 0);
  return {
    type: 'empirical',
    values: [0.1, 0.3, 0.5, 0.7, 0.9].map((fraction) => Number(quantile(values, fraction, family === 'bruh' ? 1 : 1.24).toFixed(4))),
  };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function buildManifestSkeleton({ packId, releaseId, sourceCorpusHash, selected, stats }) {
  const families = {};
  for (const family of ['pop', 'ding', 'success', 'bonk', 'funny', 'heavy', 'riser', 'record_scratch', 'bruh']) {
    families[family] = { playbackRateSampler: playbackSamplerForFamily(stats, family) };
  }
  const pools = {};
  for (const [poolId, definition] of Object.entries(poolDefinitions)) {
    pools[poolId] = {
      family: definition.family,
      assetIds: [],
      minimumReadyAssets: definition.minimumReadyAssets,
      recentUseBlockCount: definition.recentUseBlockCount,
    };
  }
  return {
    schemaVersion: 1,
    kind: 'CommandCenterSFXAutomationAssetPack',
    packId,
    releaseId,
    createdAt: new Date().toISOString(),
    sourceCorpusHash: `sha256:${sourceCorpusHash}`,
    families,
    pools,
    assets: [],
    selectionSummary: {
      selectedAssets: selected.length,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const eventsPath = args.get('events') ? resolve(String(args.get('events'))) : '';
  if (!eventsPath) throw new Error('--events is required');
  const cycleRoot = args.get('cycle-root') ? resolve(String(args.get('cycle-root'))) : '/Users/kyle/Desktop/2026 SFX/2026 Cycle SFX';
  const manualRoot = args.get('manual-root') ? resolve(String(args.get('manual-root'))) : '/Users/kyle/Desktop/2026 SFX/Categories/Manual SFX';
  const packRoot = args.get('pack-root') ? resolve(String(args.get('pack-root'))) : defaultAutomationPackRoot();
  const configPath = args.get('selection-config') ? resolve(String(args.get('selection-config'))) : defaultSelectionConfig;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const events = loadEvents(eventsPath);
  const stats = buildStats(events);
  const sourceCorpusHash = sha256File(eventsPath);
  const selected = dedupeSelections([
    ...Object.entries(config.cyclePools || {}).flatMap(([poolId, rule]) => selectCyclePool(stats, poolId, rule)),
    ...selectManualAllowlist(stats, config.manualAllowlist || []),
  ]);
  const missing = selected.filter((selection) => !existsSync(selection.stat.sourcePath));
  if (missing.length > 0) {
    throw new Error(`Selected source assets are missing:\n${missing.map((selection) => `- ${selection.poolId}: ${selection.stat.sourcePath}`).join('\n')}`);
  }

  const releaseInput = selected.map((selection) => ({
    poolId: selection.poolId,
    sourcePath: selection.stat.sourcePath,
    count: selection.stat.historicalCount,
    projects: selection.stat.historicalProjectCount,
  })).sort((a, b) => `${a.poolId}\0${a.sourcePath}`.localeCompare(`${b.poolId}\0${b.sourcePath}`));
  const releaseId = firstHex(canonicalJson({ sourceCorpusHash, releaseInput }), 16);
  const releasesRoot = join(packRoot, 'releases');
  const releaseDir = join(releasesRoot, releaseId);
  const manifestPath = join(releaseDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    atomicWriteJson(join(packRoot, 'current.json'), {
      schemaVersion: 1,
      packId: config.packId || 'jancy-editor-v1',
      releaseId,
      manifestPath: `releases/${releaseId}/manifest.json`,
    });
    console.log(`SFX automation pack already exists: ${releaseDir}`);
    return;
  }

  const tmpDir = join(releasesRoot, `.tmp-${releaseId}-${process.pid}-${Date.now()}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const manifest = buildManifestSkeleton({
    packId: config.packId || 'jancy-editor-v1',
    releaseId,
    sourceCorpusHash,
    selected,
    stats,
  });
  const maxProjectCount = new Set(events.map((row) => row.project_id)).size;
  const report = {
    schemaVersion: 1,
    releaseId,
    selectedByPool: {},
    warnings: [],
  };

  for (const selection of selected) {
    const pool = poolDefinitions[selection.poolId];
    if (!pool) throw new Error(`Unknown pool: ${selection.poolId}`);
    const outputCategory = pool.outputCategory;
    const stat = selection.stat;
    const assetId = assetIdFor(outputCategory.id, stat.sourcePath);
    const ext = extname(stat.sourcePath) || '.wav';
    const relativePath = join('assets', pool.folder, `${assetId}${ext}`);
    const targetPath = join(tmpDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(stat.sourcePath, targetPath);
    const sourceHash = sha256File(stat.sourcePath);
    const copiedHash = sha256File(targetPath);
    if (sourceHash !== copiedHash) {
      throw new Error(`Copy hash mismatch for ${stat.sourcePath}`);
    }
    const fallback = {
      durationSeconds: stat.durationSeconds,
      onsetSeconds: stat.onsetSeconds,
      gainDb: stat.gainDb,
      syncPointSeconds: stat.family === 'riser'
        ? Math.max(0.65, median(stat.rows.map((row) => {
          if (row.snap_zoom_start_sec === null || row.snap_zoom_start_sec === undefined) return Number.NaN;
          return (Number(row.snap_zoom_start_sec) - Number(row.time_sec)) * Number(row.playback_rate || 1);
        }), stat.onsetSeconds))
        : stat.onsetSeconds,
    };
    const analysis = analyzeAudioFile(targetPath, fallback);
    const asset = {
      assetId,
      displayName: stat.assetName,
      relativePath,
      sha256: copiedHash,
      byteLength: analysis.byteLength,
      family: pool.family,
      poolIds: [selection.poolId],
      outputCategory,
      source: {
        libraryKind: stat.libraryKind,
        originalCategoryId: stat.categoryId,
        relativePath: sourceRelativePath(stat, cycleRoot, manualRoot),
        originalPath: stat.sourcePath,
      },
      audio: {
        durationSeconds: Number(analysis.durationSeconds.toFixed(6)),
        onsetSeconds: Number(analysis.onsetSeconds.toFixed(6)),
        syncPointSeconds: Number(analysis.syncPointSeconds.toFixed(6)),
        waveformPeaks: analysis.waveformPeaks,
        levelStatus: analysis.levelStatus,
      },
      render: {
        gainDb: Number(analysis.gainDb.toFixed(3)),
        gainLinear: analysis.gainLinear,
      },
      selection: {
        historicalCount: stat.historicalCount,
        historicalProjectCount: stat.historicalProjectCount,
        weight: Number(coverageWeight(stat, maxProjectCount).toFixed(4)),
      },
      tags: [pool.family, selection.poolId.split('.')[1] || selection.poolId],
    };
    manifest.assets.push(asset);
    manifest.pools[selection.poolId].assetIds.push(assetId);
    report.selectedByPool[selection.poolId] ??= [];
    report.selectedByPool[selection.poolId].push({
      assetId,
      displayName: stat.assetName,
      historicalCount: stat.historicalCount,
      historicalProjectCount: stat.historicalProjectCount,
      sourcePath: stat.sourcePath,
    });
  }

  manifest.assets.sort((a, b) => a.assetId.localeCompare(b.assetId));
  for (const pool of Object.values(manifest.pools)) {
    pool.assetIds.sort();
  }
  atomicWriteJson(join(tmpDir, 'manifest.json'), manifest);
  atomicWriteJson(join(tmpDir, 'pack-report.json'), report);
  mkdirSync(releasesRoot, { recursive: true });
  renameSync(tmpDir, releaseDir);
  atomicWriteJson(join(packRoot, 'current.json'), {
    schemaVersion: 1,
    packId: manifest.packId,
    releaseId,
    manifestPath: `releases/${releaseId}/manifest.json`,
  });
  console.log(`Built SFX automation pack: ${releaseDir}`);
  console.log(`Assets: ${manifest.assets.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
