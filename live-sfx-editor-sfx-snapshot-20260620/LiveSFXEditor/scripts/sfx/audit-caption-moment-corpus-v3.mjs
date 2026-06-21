#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ROUTER_CLASSES } from '../sfx-automation/editorial-router-taxonomy.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultCorpusPath = resolve(editorRoot, 'data/sfx-automation-v3/caption-moment-corpus.jsonl');
const LOCKED_FINAL_HOLDOUT = 'footage_06_10_26_sfx';
const OPENED_BLIND_PROJECT = 'blind_caption_only_06_17_26';
const prohibitedProjectIds = new Set([LOCKED_FINAL_HOLDOUT, OPENED_BLIND_PROJECT]);

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

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function auditRecord(record) {
  const projectId = record?.project?.projectId || '';
  assert(!prohibitedProjectIds.has(projectId), `Prohibited project appears in V3 corpus: ${projectId}`);
  assert(record.schemaVersion === 3, `Invalid schemaVersion for ${projectId}`);
  const momentIds = new Set();
  const timingOptionOwners = new Map();
  for (const moment of record.moments || []) {
    assert(typeof moment.momentId === 'string' && moment.momentId, `Moment missing momentId in ${projectId}`);
    assert(!momentIds.has(moment.momentId), `Duplicate momentId in ${projectId}: ${moment.momentId}`);
    momentIds.add(moment.momentId);
    assert(moment.featureVersion === 3, `Moment featureVersion is not 3 in ${projectId}: ${moment.momentId}`);
    assert(moment.features && typeof moment.features === 'object', `Moment missing features in ${projectId}: ${moment.momentId}`);
    for (const option of moment.timingOptions || []) {
      assert(typeof option.optionId === 'string' && option.optionId, `Timing option missing optionId in ${projectId}: ${moment.momentId}`);
      const priorOwner = timingOptionOwners.get(option.optionId);
      assert(!priorOwner, `Timing option belongs to multiple moments in ${projectId}: ${option.optionId}`);
      timingOptionOwners.set(option.optionId, moment.momentId);
    }
  }
  let otherSfxCount = 0;
  for (const event of record.manualEvents || []) {
    assert(event.isAutomation === false, `Automation event leaked into manualEvents for ${projectId}: ${event.id}`);
    assert(typeof event.routerFamily === 'string' && event.routerFamily, `Human event missing routerFamily for ${projectId}: ${event.id}`);
    assert(ROUTER_CLASSES.includes(event.routerFamily), `Unknown human routerFamily for ${projectId}: ${event.routerFamily}`);
    assert(event.routerFamily !== 'none', `Human event routed to none for ${projectId}: ${event.id}`);
    if (event.routerFamily === 'other_sfx') otherSfxCount += 1;
  }
  return {
    projectId,
    momentCount: momentIds.size,
    timingOptionCount: timingOptionOwners.size,
    manualEventCount: (record.manualEvents || []).length,
    otherSfxCount,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const corpusPath = resolve(String(args.get('corpus') || defaultCorpusPath));
  const records = readJsonl(corpusPath);
  const projectIds = new Set();
  const summary = {
    corpusPath,
    projectCount: records.length,
    momentCount: 0,
    timingOptionCount: 0,
    manualEventCount: 0,
    otherSfxHumanEventCount: 0,
  };
  for (const record of records) {
    const projectId = record?.project?.projectId || '';
    assert(!projectIds.has(projectId), `Duplicate project record in corpus: ${projectId}`);
    projectIds.add(projectId);
    const item = auditRecord(record);
    summary.momentCount += item.momentCount;
    summary.timingOptionCount += item.timingOptionCount;
    summary.manualEventCount += item.manualEventCount;
    summary.otherSfxHumanEventCount += item.otherSfxCount;
  }
  assert(summary.otherSfxHumanEventCount > 0, 'No other_sfx human events found; audit cannot prove other_sfx was preserved');
  console.log(JSON.stringify(summary, null, 2));
}

main();
