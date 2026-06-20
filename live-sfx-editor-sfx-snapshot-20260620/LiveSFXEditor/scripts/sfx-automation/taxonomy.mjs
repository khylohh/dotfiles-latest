export const supportedFamilies = [
  'pop',
  'ding',
  'success',
  'bonk',
  'funny',
  'heavy',
  'riser',
  'record_scratch',
  'bruh',
];

export const categoryColors = {
  pop: '#39d6df',
  ding: '#f6d85f',
  success: '#71df8d',
  bonk: '#ff705c',
  funny: '#c87bff',
  dramatic: '#ff8fc8',
  'manual:boom 3': '#ef9b4e',
  'manual:risers': '#96a8ff',
  'manual:new dramatic sfx': '#ff8fc8',
  'manual:misc': '#ef9b4e',
  record_scratch: '#ff5f7e',
  bruh: '#d8f071',
};

export const outputCategories = {
  pop: { id: 'pop', name: 'Pop', color: categoryColors.pop },
  ding: { id: 'ding', name: 'Ding', color: categoryColors.ding },
  success: { id: 'success', name: 'Success', color: categoryColors.success },
  bonk: { id: 'bonk', name: 'Bonk', color: categoryColors.bonk },
  funny: { id: 'funny', name: 'Funny', color: categoryColors.funny },
  dramatic: { id: 'dramatic', name: 'Dramatic', color: categoryColors.dramatic },
  boom3: { id: 'manual:boom 3', name: 'Boom 3', color: categoryColors['manual:boom 3'] },
  risers: { id: 'manual:risers', name: 'Risers', color: categoryColors['manual:risers'] },
  newDramatic: { id: 'manual:new dramatic sfx', name: 'New Dramatic SFX', color: categoryColors['manual:new dramatic sfx'] },
  misc: { id: 'manual:misc', name: 'Misc', color: categoryColors['manual:misc'] },
  recordScratch: { id: 'record_scratch', name: 'Record Scratch', color: categoryColors.record_scratch },
  bruh: { id: 'bruh', name: 'Bruh', color: categoryColors.bruh },
};

export const poolDefinitions = {
  'pop.light': { family: 'pop', folder: 'pop/light', outputCategory: outputCategories.pop, minimumReadyAssets: 8, recentUseBlockCount: 4 },
  'ding.small': { family: 'ding', folder: 'ding/small', outputCategory: outputCategories.ding, minimumReadyAssets: 8, recentUseBlockCount: 4 },
  'success.payoff': { family: 'success', folder: 'success/payoff', outputCategory: outputCategories.success, minimumReadyAssets: 4, recentUseBlockCount: 4 },
  'bonk.failure': { family: 'bonk', folder: 'bonk/failure', outputCategory: outputCategories.bonk, minimumReadyAssets: 6, recentUseBlockCount: 4 },
  'funny.punchline': { family: 'funny', folder: 'funny/punchline', outputCategory: outputCategories.funny, minimumReadyAssets: 4, recentUseBlockCount: 2 },
  'heavy.short': { family: 'heavy', folder: 'heavy/short', outputCategory: outputCategories.dramatic, minimumReadyAssets: 4, recentUseBlockCount: 3 },
  'heavy.soft': { family: 'heavy', folder: 'heavy/soft', outputCategory: outputCategories.boom3, minimumReadyAssets: 1, recentUseBlockCount: 3 },
  'heavy.standard': { family: 'heavy', folder: 'heavy/standard', outputCategory: outputCategories.boom3, minimumReadyAssets: 1, recentUseBlockCount: 3 },
  'heavy.large': { family: 'heavy', folder: 'heavy/large', outputCategory: outputCategories.boom3, minimumReadyAssets: 1, recentUseBlockCount: 3 },
  'heavy.reveal': { family: 'heavy', folder: 'heavy/reveal', outputCategory: outputCategories.newDramatic, minimumReadyAssets: 1, recentUseBlockCount: 3 },
  'heavy.comic': { family: 'heavy', folder: 'heavy/comic', outputCategory: outputCategories.misc, minimumReadyAssets: 1, recentUseBlockCount: 3 },
  'riser.short': { family: 'riser', folder: 'riser/short', outputCategory: outputCategories.risers, minimumReadyAssets: 2, recentUseBlockCount: 2 },
  'record-scratch': { family: 'record_scratch', folder: 'record-scratch', outputCategory: outputCategories.recordScratch, minimumReadyAssets: 1, recentUseBlockCount: 1 },
  bruh: { family: 'bruh', folder: 'bruh', outputCategory: outputCategories.bruh, minimumReadyAssets: 1, recentUseBlockCount: 0 },
};

export const defaultFamilyPool = {
  pop: 'pop.light',
  ding: 'ding.small',
  success: 'success.payoff',
  bonk: 'bonk.failure',
  funny: 'funny.punchline',
  heavy: 'heavy.short',
  riser: 'riser.short',
  record_scratch: 'record-scratch',
  bruh: 'bruh',
};

export function normalizeCategoryId(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeAssetName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rowFamily(row) {
  const category = normalizeCategoryId(row.category_id || row.category_name);
  const assetName = normalizeAssetName(row.asset_name);
  if (category === 'pop') return 'pop';
  if (category === 'ding') return 'ding';
  if (category === 'success') return 'success';
  if (category === 'bonk') return 'bonk';
  if (category === 'funny') return 'funny';
  if (category === 'dramatic' || category === 'manual:boom 3' || category === 'manual:new dramatic sfx' || assetName === 'vine boom') return 'heavy';
  if (category === 'manual:risers') return 'riser';
  if (category === 'record_scratch' || /record\s*scratch/.test(assetName)) return 'record_scratch';
  if (category === 'bruh') return 'bruh';
  return 'unsupported';
}
