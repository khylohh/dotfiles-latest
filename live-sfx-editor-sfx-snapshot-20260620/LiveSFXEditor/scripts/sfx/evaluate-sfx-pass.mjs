#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventAudibleStart } from '../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor } from '../lib/live-sfx-project-io.mjs';
import { readCaptionProject } from '../sfx-automation/caption/load-caption-project.mjs';
import { resolveCaptionProjectForMedia } from '../sfx-automation/caption/find-caption-project.mjs';
import { generateSFXPass } from '../sfx-automation/run-sfx-pass.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(editorRoot, '..');
const defaultProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
const defaultOutputPath = resolve(editorRoot, 'data/sfx-automation-v1/evaluation.json');
const defaultSummaryPath = resolve(editorRoot, 'data/sfx-automation-v1/evaluation-summary.md');
const targetFamilies = ['pop', 'ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch'];
const captionFamilies = ['ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch'];
const evaluationTolerances = [0.25, 0.5, 0.75, 1.0];

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

function categoryFamily(value) {
  const id = String(value || '').toLowerCase().replaceAll('-', '_').replace(/\s+/g, '_');
  return targetFamilies.includes(id) ? id : '';
}

function parseProjectIdSet(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function toleranceForFamily(family) {
  return family === 'pop' ? 0.35 : 0.75;
}

function eventInfo(event, projectId, source) {
  const family = categoryFamily(event.categoryId);
  return {
    projectId,
    source,
    id: event.id,
    family,
    categoryId: event.categoryId,
    fileName: event.fileName,
    timeSec: Number(event.startSeconds) || 0,
    audibleTimeSec: eventAudibleStart(event),
    track: Number(event.track) || 1,
    automation: event.automation || null,
  };
}

function nearestCue(captionProject, seconds) {
  if (!captionProject?.cues?.length) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cue of captionProject.cues) {
    const distance = Math.abs(Number(cue.start) - seconds);
    if (distance < bestDistance) {
      best = cue;
      bestDistance = distance;
    }
  }
  return best ? {
    id: best.id,
    start: best.start,
    end: best.end,
    speaker: best.speaker,
    text: best.text,
    distanceSec: bestDistance,
  } : null;
}

function matchEvents(manualEvents, generatedEvents, families) {
  const matches = [];
  const unmatchedManual = [];
  const unmatchedGenerated = [];
  const usedManual = new Set();
  const usedGenerated = new Set();

  for (const family of families) {
    const manual = manualEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.family === family)
      .sort((a, b) => a.event.audibleTimeSec - b.event.audibleTimeSec);
    const generated = generatedEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.family === family)
      .sort((a, b) => a.event.audibleTimeSec - b.event.audibleTimeSec);
    const possible = [];
    for (const g of generated) {
      for (const m of manual) {
        if (g.event.projectId !== m.event.projectId) continue;
        const deltaSec = g.event.audibleTimeSec - m.event.audibleTimeSec;
        if (Math.abs(deltaSec) <= toleranceForFamily(family)) {
          possible.push({ family, generatedIndex: g.index, manualIndex: m.index, deltaSec });
        }
      }
    }
    possible.sort((a, b) => Math.abs(a.deltaSec) - Math.abs(b.deltaSec) || a.generatedIndex - b.generatedIndex || a.manualIndex - b.manualIndex);
    for (const candidate of possible) {
      if (usedGenerated.has(candidate.generatedIndex) || usedManual.has(candidate.manualIndex)) continue;
      usedGenerated.add(candidate.generatedIndex);
      usedManual.add(candidate.manualIndex);
      matches.push({
        family,
        deltaSec: candidate.deltaSec,
        generated: generatedEvents[candidate.generatedIndex],
        manual: manualEvents[candidate.manualIndex],
      });
    }
  }

  manualEvents.forEach((event, index) => {
    if (families.includes(event.family) && !usedManual.has(index)) unmatchedManual.push(event);
  });
  generatedEvents.forEach((event, index) => {
    if (families.includes(event.family) && !usedGenerated.has(index)) unmatchedGenerated.push(event);
  });
  return { matches, unmatchedManual, unmatchedGenerated };
}

function matchEventsAtTolerance(manualEvents, generatedEvents, families, toleranceSec, options = {}) {
  const exactFamily = options.exactFamily !== false;
  const matches = [];
  const unmatchedManual = [];
  const unmatchedGenerated = [];
  const usedManual = new Set();
  const usedGenerated = new Set();
  const groups = exactFamily ? families : ['any'];

  for (const family of groups) {
    const manual = manualEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => exactFamily ? event.family === family : families.includes(event.family))
      .sort((a, b) => a.event.audibleTimeSec - b.event.audibleTimeSec);
    const generated = generatedEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => exactFamily ? event.family === family : families.includes(event.family))
      .sort((a, b) => a.event.audibleTimeSec - b.event.audibleTimeSec);
    const possible = [];
    for (const g of generated) {
      for (const m of manual) {
        if (g.event.projectId !== m.event.projectId) continue;
        const deltaSec = g.event.audibleTimeSec - m.event.audibleTimeSec;
        if (Math.abs(deltaSec) <= toleranceSec) {
          possible.push({
            family: exactFamily ? family : g.event.family,
            generatedIndex: g.index,
            manualIndex: m.index,
            deltaSec,
          });
        }
      }
    }
    possible.sort((a, b) => Math.abs(a.deltaSec) - Math.abs(b.deltaSec) || a.generatedIndex - b.generatedIndex || a.manualIndex - b.manualIndex);
    for (const candidate of possible) {
      if (usedGenerated.has(candidate.generatedIndex) || usedManual.has(candidate.manualIndex)) continue;
      usedGenerated.add(candidate.generatedIndex);
      usedManual.add(candidate.manualIndex);
      matches.push({
        family: candidate.family,
        deltaSec: candidate.deltaSec,
        generated: generatedEvents[candidate.generatedIndex],
        manual: manualEvents[candidate.manualIndex],
      });
    }
  }

  manualEvents.forEach((event, index) => {
    if (families.includes(event.family) && !usedManual.has(index)) unmatchedManual.push(event);
  });
  generatedEvents.forEach((event, index) => {
    if (families.includes(event.family) && !usedGenerated.has(index)) unmatchedGenerated.push(event);
  });
  return { matches, unmatchedManual, unmatchedGenerated };
}

function clusterManualBeats(manualEvents, windowSec = 0.3) {
  const clusters = [];
  const byProject = new Map();
  for (const event of manualEvents.filter((item) => captionFamilies.includes(item.family))) {
    const events = byProject.get(event.projectId) || [];
    events.push(event);
    byProject.set(event.projectId, events);
  }
  for (const [projectId, projectEvents] of byProject.entries()) {
    const sorted = projectEvents.sort((a, b) => a.audibleTimeSec - b.audibleTimeSec);
    const projectClusters = [];
    for (const event of sorted) {
      const last = projectClusters[projectClusters.length - 1];
      if (last && event.audibleTimeSec - last.lastSec <= windowSec) {
        last.events.push(event);
        last.lastSec = Math.max(last.lastSec, event.audibleTimeSec);
        last.audibleTimeSec = median(last.events.map((item) => item.audibleTimeSec));
        last.families = [...new Set(last.events.map((item) => item.family))].sort();
      } else {
        projectClusters.push({
          projectId,
          source: 'manual-beat',
          id: `beat-${projectId}-${projectClusters.length + 1}`,
          family: 'caption_beat',
          categoryId: 'caption_beat',
          fileName: 'Manual Beat',
          timeSec: event.timeSec,
          audibleTimeSec: event.audibleTimeSec,
          lastSec: event.audibleTimeSec,
          families: [event.family],
          events: [event],
        });
      }
    }
    clusters.push(...projectClusters);
  }
  return clusters;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function generatedCaptionMoments(generatedEvents) {
  return generatedEvents
    .filter((event) => captionFamilies.includes(event.family))
    .map((event) => ({ ...event, family: 'caption_beat', originalFamily: event.family }));
}

function precisionRecallF05(manualCount, generatedCount, matchCount) {
  const precision = generatedCount ? matchCount / generatedCount : null;
  const recall = manualCount ? matchCount / manualCount : null;
  const betaSquared = 0.25;
  const f05 = precision && recall
    ? (1 + betaSquared) * precision * recall / ((betaSquared * precision) + recall)
    : null;
  return {
    manualCount,
    generatedCount,
    matchCount,
    precision: precision === null ? null : round(precision, 4),
    recall: recall === null ? null : round(recall, 4),
    f05: f05 === null ? null : round(f05, 4),
  };
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round(sorted[index], 4);
}

function timingStats(matches) {
  const signed = matches.map((match) => match.deltaSec).filter(Number.isFinite);
  const absolute = signed.map(Math.abs);
  return {
    medianSignedSec: quantile(signed, 0.5),
    p90SignedSec: quantile(signed, 0.9),
    medianAbsSec: quantile(absolute, 0.5),
    p90AbsSec: quantile(absolute, 0.9),
  };
}

function confusionMatrix(momentMatches) {
  const matrix = {};
  for (const match of momentMatches) {
    const generatedFamily = match.generated.originalFamily || match.generated.family;
    const manualFamilies = match.manual.families || [match.manual.family];
    for (const manualFamily of manualFamilies) {
      matrix[generatedFamily] ||= {};
      matrix[generatedFamily][manualFamily] = (matrix[generatedFamily][manualFamily] || 0) + 1;
    }
  }
  return matrix;
}

function evaluateDiagnostics(manualEvents, generatedEvents, durationSec) {
  const captionManual = manualEvents.filter((event) => captionFamilies.includes(event.family));
  const captionGenerated = generatedEvents.filter((event) => captionFamilies.includes(event.family));
  const manualBeats = clusterManualBeats(captionManual);
  const generatedMoments = generatedCaptionMoments(captionGenerated);
  const toleranceMetrics = {};
  for (const toleranceSec of evaluationTolerances) {
    const strict = matchEventsAtTolerance(captionManual, captionGenerated, captionFamilies, toleranceSec);
    const moment = matchEventsAtTolerance(manualBeats, generatedMoments, ['caption_beat'], toleranceSec);
    const familyCorrect = moment.matches.filter((match) => match.manual.families?.includes(match.generated.originalFamily || match.generated.family)).length;
    toleranceMetrics[String(toleranceSec)] = {
      strict: {
        ...precisionRecallF05(captionManual.length, captionGenerated.length, strict.matches.length),
        timing: timingStats(strict.matches),
      },
      moment: {
        ...precisionRecallF05(manualBeats.length, generatedMoments.length, moment.matches.length),
        familyAccuracyGivenMoment: moment.matches.length ? round(familyCorrect / moment.matches.length, 4) : null,
        timing: timingStats(moment.matches),
      },
    };
  }
  const primaryMoment = matchEventsAtTolerance(manualBeats, generatedMoments, ['caption_beat'], 0.75);
  return {
    tolerances: toleranceMetrics,
    familyConfusionAt075: confusionMatrix(primaryMoment.matches),
    deletionBurden: {
      unmatchedGenerated: captionGenerated.length - (toleranceMetrics['0.75']?.strict.matchCount || 0),
      unmatchedGeneratedPerMinute: round((captionGenerated.length - (toleranceMetrics['0.75']?.strict.matchCount || 0)) / Math.max(0.1, Number(durationSec) / 60), 4),
    },
    captionBeatCount: manualBeats.length,
  };
}

function nearestDifferentFamilyManual(generated, manualEvents) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const manual of manualEvents) {
    if (manual.projectId !== generated.projectId) continue;
    if (manual.family === generated.family) continue;
    const distance = Math.abs(generated.audibleTimeSec - manual.audibleTimeSec);
    if (distance < bestDistance) {
      best = manual;
      bestDistance = distance;
    }
  }
  return best ? { ...best, distanceSec: bestDistance } : null;
}

function metricsForFamilies(manualEvents, generatedEvents, matches, families) {
  const output = {};
  for (const family of families) {
    const manualCount = manualEvents.filter((event) => event.family === family).length;
    const generatedCount = generatedEvents.filter((event) => event.family === family).length;
    const matchCount = matches.filter((match) => match.family === family).length;
    output[family] = {
      manualCount,
      generatedCount,
      matchCount,
      precision: generatedCount ? round(matchCount / generatedCount, 4) : null,
      recall: manualCount ? round(matchCount / manualCount, 4) : null,
    };
  }
  return output;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sample(items, limit = 24) {
  return items.slice(0, limit);
}

function compactEvent(event) {
  const output = {
    projectId: event.projectId,
    family: event.family,
    timeSec: round(event.audibleTimeSec, 3),
    categoryId: event.categoryId,
    fileName: event.fileName,
    caption: event.caption ? {
      start: round(event.caption.start, 3),
      speaker: event.caption.speaker,
      text: event.caption.text,
      distanceSec: round(event.caption.distanceSec, 3),
    } : null,
  };
  if (Number.isFinite(event.distanceSec)) output.distanceSec = round(event.distanceSec, 3);
  if (event.automation) {
    output.automation = {
      reasonCode: event.automation.reasonCode,
      anchorType: event.automation.anchorType,
      familyScore: Number.isFinite(Number(event.automation.familyScore)) ? round(Number(event.automation.familyScore), 4) : null,
      scoreMargin: Number.isFinite(Number(event.automation.scoreMargin)) ? round(Number(event.automation.scoreMargin), 4) : null,
    };
  }
  return output;
}

function markdownSummary(evaluation) {
  const lines = [];
  lines.push('# SFX Automation V1 Evaluation');
  lines.push('');
  lines.push(`Projects: ${evaluation.summary.projectCount}`);
  lines.push(`Generated target events: ${evaluation.summary.generatedTargetEventCount}`);
  lines.push(`Manual target events: ${evaluation.summary.manualTargetEventCount}`);
  lines.push(`Exact-family matches: ${evaluation.summary.matchCount}`);
  lines.push(`Resolver failures: ${evaluation.summary.resolverFailureCount}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Family | Manual | Generated | Matched | Precision | Recall |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const family of targetFamilies) {
    const metric = evaluation.summary.metrics[family];
    lines.push(`| ${family} | ${metric.manualCount} | ${metric.generatedCount} | ${metric.matchCount} | ${fmt(metric.precision)} | ${fmt(metric.recall)} |`);
  }
  lines.push('');
  lines.push('## Caption Families Only');
  lines.push('');
  const captionMetric = evaluation.summary.captionFamilyAggregate;
  lines.push(`Generated: ${captionMetric.generatedCount}`);
  lines.push(`Manual: ${captionMetric.manualCount}`);
  lines.push(`Matched: ${captionMetric.matchCount}`);
  lines.push(`Precision: ${fmt(captionMetric.precision)}`);
  lines.push(`Recall: ${fmt(captionMetric.recall)}`);
  lines.push('');
  lines.push('## Primary Caption Diagnostics At 0.75s');
  lines.push('');
  const primary = evaluation.summary.diagnostics?.tolerances?.['0.75'];
  if (primary) {
    lines.push(`Strict precision: ${fmt(primary.strict.precision)}`);
    lines.push(`Strict recall: ${fmt(primary.strict.recall)}`);
    lines.push(`Strict F0.5: ${fmt(primary.strict.f05)}`);
    lines.push(`Moment precision: ${fmt(primary.moment.precision)}`);
    lines.push(`Moment recall: ${fmt(primary.moment.recall)}`);
    lines.push(`Family accuracy given moment: ${fmt(primary.moment.familyAccuracyGivenMoment)}`);
    lines.push(`Unmatched generated/min: ${fmt(evaluation.summary.diagnostics.deletionBurden.unmatchedGeneratedPerMinute)}`);
  }
  lines.push('');
  lines.push('## Evaluation Config');
  lines.push('');
  lines.push('- Primary strict timing window: 0.75 seconds for caption families.');
  lines.push('- Extra timing windows: 0.25, 0.50, 0.75, 1.00 seconds.');
  lines.push('- Strict matching is exact-family greedy one-to-one by minimum absolute time error.');
  lines.push('- Moment matching clusters manual caption-family events within 0.30 seconds and allows any caption family.');
  lines.push('');
  lines.push('## Project Counts');
  lines.push('');
  for (const project of evaluation.projects) {
    lines.push(`- ${project.projectId}: generated ${project.generatedTargetEventCount}, matched ${project.matchCount}, manual ${project.manualTargetEventCount}`);
  }
  lines.push('');
  lines.push('## False Positive Samples');
  lines.push('');
  for (const item of evaluation.samples.falsePositives) {
    const caption = item.caption ? `${item.caption.speaker}: ${item.caption.text}` : '';
    const nearest = item.nearestOtherFamilyManual?.distanceSec !== undefined
      ? ` nearest other=${item.nearestOtherFamilyManual.family} @ ${round(item.nearestOtherFamilyManual.distanceSec, 2)}s`
      : '';
    lines.push(`- ${item.projectId} ${item.timeSec}s ${item.family}: ${caption}${nearest}`);
  }
  lines.push('');
  lines.push('## False Negative Samples');
  lines.push('');
  for (const item of evaluation.samples.falseNegatives) {
    const caption = item.caption ? `${item.caption.speaker}: ${item.caption.text}` : '';
    lines.push(`- ${item.projectId} ${item.timeSec}s ${item.family}: ${caption}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function fmt(value) {
  return value === null || value === undefined ? '-' : value.toFixed(3);
}

async function main() {
  const args = parseArgs(process.argv);
  const projectsPath = resolve(String(args.get('projects') || defaultProjectsPath));
  const outputPath = resolve(String(args.get('out') || defaultOutputPath));
  const summaryPath = resolve(String(args.get('summary-out') || defaultSummaryPath));
  const includeProjectIds = parseProjectIdSet(args.get('project-ids'));
  const excludeProjectIds = parseProjectIdSet(args.get('exclude-projects'));
  const projectMetas = (JSON.parse(readFileSync(projectsPath, 'utf8')).projects || []).filter((project) => {
    if (includeProjectIds && !includeProjectIds.has(project.project_id)) return false;
    if (excludeProjectIds?.has(project.project_id)) return false;
    return true;
  });
  const projects = [];
  const allMatches = [];
  const allManual = [];
  const allGenerated = [];
  const allFalsePositives = [];
  const allFalseNegatives = [];

  for (const meta of projectMetas) {
    const { project } = readLiveSFXDescriptor(meta.interface_path);
    const resolver = resolveCaptionProjectForMedia(project, { captionPath: meta.caption_source });
    const captionPath = resolver.captionPath || meta.caption_source || '';
    let captionProject = null;
    try {
      captionProject = captionPath ? readCaptionProject(captionPath) : null;
    } catch {
      captionProject = null;
    }
    const baseProject = { ...project, events: [], decks: {} };
    const result = generateSFXPass(baseProject, {
      seed: 'eval',
      scorer: 'local',
      captionPath: meta.caption_source,
    });
    const manualEvents = project.events
      .map((event) => eventInfo(event, meta.project_id, 'manual'))
      .filter((event) => targetFamilies.includes(event.family))
      .map((event) => ({ ...event, caption: nearestCue(captionProject, event.audibleTimeSec) }));
    const generatedEvents = result.project.events
      .filter((event) => String(event.id || '').startsWith('sfxauto_'))
      .map((event) => eventInfo(event, meta.project_id, 'generated'))
      .filter((event) => targetFamilies.includes(event.family))
      .map((event) => ({ ...event, caption: nearestCue(captionProject, event.audibleTimeSec) }));
    const matched = matchEvents(manualEvents, generatedEvents, targetFamilies);
    const diagnostics = evaluateDiagnostics(manualEvents, generatedEvents, project.duration);
    const falsePositives = matched.unmatchedGenerated.map((event) => ({
      ...event,
      nearestOtherFamilyManual: nearestDifferentFamilyManual(event, manualEvents),
    }));
    const falseNegatives = matched.unmatchedManual;

    allMatches.push(...matched.matches);
    allManual.push(...manualEvents);
    allGenerated.push(...generatedEvents);
    allFalsePositives.push(...falsePositives);
    allFalseNegatives.push(...falseNegatives);

    projects.push({
      projectId: meta.project_id,
      projectName: meta.name,
      interfacePath: meta.interface_path,
      captionPath,
      captionResolver: result.stats.captionResolver || resolver,
      manualTargetEventCount: manualEvents.length,
      generatedTargetEventCount: generatedEvents.length,
      matchCount: matched.matches.length,
      metrics: metricsForFamilies(manualEvents, generatedEvents, matched.matches, targetFamilies),
      diagnostics,
      generatorStats: result.stats,
      falsePositiveCount: falsePositives.length,
      falseNegativeCount: falseNegatives.length,
      falsePositiveSamples: sample(falsePositives.map(compactEvent), 12),
      falseNegativeSamples: sample(falseNegatives.map(compactEvent), 12),
    });
  }

  const metrics = metricsForFamilies(allManual, allGenerated, allMatches, targetFamilies);
  const captionManual = allManual.filter((event) => captionFamilies.includes(event.family));
  const captionGenerated = allGenerated.filter((event) => captionFamilies.includes(event.family));
  const captionMatches = allMatches.filter((match) => captionFamilies.includes(match.family));
  const captionFamilyAggregate = {
    manualCount: captionManual.length,
    generatedCount: captionGenerated.length,
    matchCount: captionMatches.length,
    precision: captionGenerated.length ? round(captionMatches.length / captionGenerated.length, 4) : null,
    recall: captionManual.length ? round(captionMatches.length / captionManual.length, 4) : null,
  };
  const diagnostics = evaluateDiagnostics(allManual, allGenerated, projectMetas.reduce((sum, project) => sum + (Number(project.duration_sec) || 0), 0));
  const resolverFailureCount = projects.filter((project) => project.captionResolver?.status && project.captionResolver.status !== 'ok').length;

  const evaluation = {
    version: 1,
    source: { projectsPath },
    summary: {
      projectCount: projectMetas.length,
      manualTargetEventCount: allManual.length,
      generatedTargetEventCount: allGenerated.length,
      matchCount: allMatches.length,
      metrics,
      captionFamilyAggregate,
      diagnostics,
      resolverFailureCount,
    },
    projects,
    samples: {
      falsePositives: sample(allFalsePositives.map((event) => ({
        ...compactEvent(event),
        nearestOtherFamilyManual: event.nearestOtherFamilyManual ? compactEvent(event.nearestOtherFamilyManual) : null,
      })), 120),
      falseNegatives: sample(allFalseNegatives.map(compactEvent), 160),
    },
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
  writeFileSync(summaryPath, markdownSummary(evaluation), 'utf8');
  console.log(JSON.stringify({
    outputPath,
    summaryPath,
    projectCount: evaluation.summary.projectCount,
    manualTargetEventCount: evaluation.summary.manualTargetEventCount,
    generatedTargetEventCount: evaluation.summary.generatedTargetEventCount,
    matchCount: evaluation.summary.matchCount,
    captionFamilyAggregate,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
