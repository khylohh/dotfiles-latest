export const ROUTER_CLASSES = Object.freeze([
  'none',
  'pop',
  'ding',
  'success',
  'bonk',
  'funny',
  'bruh',
  'record_scratch',
  'dramatic',
  'other_sfx',
]);

export const EMITTABLE_ROUTER_CLASSES = new Set([
  'pop',
  'ding',
  'success',
  'bonk',
  'funny',
  'bruh',
  'record_scratch',
  'dramatic',
]);

function normalizeRouterCategory(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
    .replace(/\s+/g, '_');
  if (!raw) return '';
  return raw.startsWith('manual:') ? `manual:${raw.slice(raw.indexOf(':') + 1)}` : raw;
}

export function routerClassForManualEvent(event) {
  const category = normalizeRouterCategory(event.categoryId || event.rawCategoryId || event.family || '');
  const fileName = String(event.fileName || event.assetName || '').toLowerCase();
  if (category === 'pop') return 'pop';
  if (category === 'ding') return 'ding';
  if (category === 'success') return 'success';
  if (category === 'bonk') return 'bonk';
  if (category === 'funny') return 'funny';
  if (category === 'bruh') return 'bruh';
  if (category === 'record_scratch' || /record\s*scratch/.test(fileName)) return 'record_scratch';
  if (
    category === 'dramatic'
    || category === 'heavy'
    || category === 'manual:boom_3'
    || category === 'manual:new_dramatic_sfx'
    || fileName.includes('vine boom')
  ) {
    return 'dramatic';
  }
  return 'other_sfx';
}

export function assetFamilyForRouterClass(routerClass) {
  if (routerClass === 'dramatic') return 'heavy';
  return EMITTABLE_ROUTER_CLASSES.has(routerClass) ? routerClass : '';
}
