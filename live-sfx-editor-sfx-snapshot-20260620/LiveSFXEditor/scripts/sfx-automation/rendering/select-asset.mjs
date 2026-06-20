function stableUnit(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (((hash >>> 0) % 1000000) + 1) / 1000001;
}

export function selectWeightedAsset(pool, decision, options = {}) {
  const seed = String(options.seed || 'sfx-v1');
  const recentAssetIds = new Set(options.recentAssetIds || []);
  const candidates = pool.assets.filter((asset) => !recentAssetIds.has(asset.assetId));
  const assets = candidates.length > 0 ? candidates : pool.assets;
  if (!assets.length) return null;
  return [...assets]
    .map((asset) => {
      const weight = Math.max(0.01, Number(asset.selection?.weight) || 1);
      const unit = stableUnit(`${seed}\0${decision.candidateId}\0${asset.assetId}`);
      return { asset, key: -Math.log(unit) / weight };
    })
    .sort((a, b) => a.key - b.key || a.asset.assetId.localeCompare(b.asset.assetId))[0].asset;
}

export function selectPlaybackRate(asset, decision, project, options = {}) {
  if (asset.family === 'bruh') return 1;
  const values = Array.isArray(options.values) && options.values.length > 0
    ? options.values
    : [1.16, 1.22, 1.28, 1.34, 1.38];
  const seed = `${options.seed || 'sfx-v1'}\0${decision.candidateId}\0${asset.assetId}\0rate`;
  const index = Math.floor(stableUnit(seed) * values.length) % values.length;
  return Math.min(Number(values[index]) || 1.2, Number(project.maxPlaybackRate) || 1.4);
}
