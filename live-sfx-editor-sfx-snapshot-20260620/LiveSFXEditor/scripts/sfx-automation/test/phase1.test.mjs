import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSFXEvent, packEvents, packNewEventsAroundFixedEvents } from '../../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor } from '../../lib/live-sfx-project-io.mjs';
import { resolveCaptionProjectForMedia } from '../caption/find-caption-project.mjs';
import { decodeTimeline } from '../decoding/decode-timeline.mjs';
import { familyPoliciesForDecoder, scoreCaptionCandidatesModel } from '../scoring/caption-model-scorer.mjs';
import { scoreCaptionCandidatesLocal } from '../scoring/caption-rule-scorer.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../..');

const project = {
  fps: 30,
  duration: 60,
};

const category = {
  id: 'pop',
  name: 'Pop',
  color: '#39d6df',
};

const file = {
  id: 'asset-1',
  name: 'UI 1',
  path: '/tmp/ui-1.wav',
  duration: 1.2,
  onsetSeconds: 0.12,
  gainDb: 6,
  gainLinear: 1.995,
};

test('buildSFXEvent aligns audible onset to target seconds', () => {
  const event = buildSFXEvent({
    category,
    file,
    project,
    playbackRate: 1.2,
    audibleStartSeconds: 10,
    id: 'event-1',
  });
  assert.equal(event.startSeconds, 9.9);
  assert.equal(event.startFrame, 297);
  assert.equal(event.audibleOffsetSeconds, 0.1);
});

test('packEvents assigns overlapping events to separate tracks', () => {
  const packed = packEvents([
    { ...buildSFXEvent({ category, file, project, playbackRate: 1, startSeconds: 1, id: 'a' }), createdAt: '2026-01-01T00:00:00.000Z' },
    { ...buildSFXEvent({ category, file, project, playbackRate: 1, startSeconds: 1.2, id: 'b' }), createdAt: '2026-01-01T00:00:01.000Z' },
  ]);
  assert.equal(packed[0].track, 1);
  assert.equal(packed[1].track, 2);
});

test('packNewEventsAroundFixedEvents preserves fixed event tracks', () => {
  const fixed = [{ ...buildSFXEvent({ category, file, project, playbackRate: 1, startSeconds: 1, id: 'fixed' }), track: 4 }];
  const generated = [buildSFXEvent({ category, file, project, playbackRate: 1, startSeconds: 1.1, id: 'generated' })];
  const packed = packNewEventsAroundFixedEvents(fixed, generated, 30);
  assert.equal(packed.find((event) => event.id === 'fixed').track, 4);
  assert.notEqual(packed.find((event) => event.id === 'generated').track, 4);
});

test('caption resolver validates footage_05_27_26_sfx identity and timebase', () => {
  const sourceProjectsPath = resolve(repoRoot, 'sfx_interface_compilation/sfx_interface_source_projects.json');
  const sourceProjects = JSON.parse(readFileSync(sourceProjectsPath, 'utf8')).projects;
  const meta = sourceProjects.find((item) => item.project_id === 'footage_05_27_26_sfx');
  assert.ok(meta, 'fixture project should exist in source compilation');
  const { project: sfxProject } = readLiveSFXDescriptor(meta.interface_path);
  const resolver = resolveCaptionProjectForMedia(sfxProject, { captionPath: meta.caption_source });
  assert.equal(resolver.status, 'ok');
  assert.equal(resolver.captionPath, meta.caption_source);
  assert.ok(Math.abs(Number(resolver.durationDeltaSec)) <= Math.max(0.5, Number(sfxProject.duration) * 0.005));
  assert.ok(Number(resolver.resolverConfidence) >= 100);
});

test('caption scorer does not treat missing zoom as zoom support', () => {
  const [scored] = scoreCaptionCandidatesLocal([{
    id: 'caption-no-zoom',
    kind: 'caption',
    targetSec: 10,
    targetFrame: 300,
    cueIds: ['cue-1'],
    zoomMarkerIds: [],
    text: 'Look at this one',
    features: {
      normalized: 'look at this one',
      anchorType: 'cue_end_minus_80ms',
      cueOverlapsZoom: false,
      nearestZoomStartDeltaSec: null,
      nearestZoomDistanceSec: null,
      previousGapSec: null,
      nextGapSec: null,
      speakerChangedFromPrevious: false,
      speakerChangesToNext: false,
      hasExclamationMark: false,
    },
  }]);
  assert.equal(scored.primaryFamily, 'none');
});

test('decoder rejects caption families when required score margin is missing', () => {
  const decoded = decodeTimeline([{
    primaryFamily: 'success',
    confidence: 0.99,
    candidate: {
      id: 'candidate-no-margin',
      kind: 'caption',
      targetSec: 10,
      targetFrame: 300,
      zoomMarkerIds: [],
      cueIds: ['cue-1'],
      features: { anchorType: 'cue_end_minus_80ms' },
    },
    reasonCode: 'test_missing_margin',
  }], project, {
    familyPolicies: {
      success: {
        enabled: true,
        threshold: 0.9,
        marginScore: 0.12,
        cooldownSeconds: 1,
        globalCooldownSeconds: 0.1,
        maxPerMinute: 10,
      },
    },
  });
  assert.equal(decoded.length, 0);
});

test('caption model scorer obeys trained family policy enablement', () => {
  const families = ['ding', 'success', 'bonk', 'funny', 'bruh', 'record_scratch'];
  const modelData = {
    schemaVersion: 2,
    modelVersion: 'test-caption-model',
    featureVersion: 2,
    families,
    dense: { names: [], mean: [], scale: [] },
    lexical: { vocabulary: [], inputScale: 0.35 },
    emitGate: { intercept: 5, denseWeights: [], lexicalWeights: [], platt: { a: 1, b: 0 } },
    familySoftmax: {
      intercepts: [5, 0, 0, 0, 0, 0],
      denseWeights: families.map(() => []),
      lexicalWeights: families.map(() => []),
      temperature: 1,
    },
    jointCalibration: Object.fromEntries(families.map((family) => [family, { a: 1, b: 0 }])),
  };
  const policyData = {
    families: {
      ding: {
        enabled: false,
        gateThreshold: 0.5,
        conditionalThreshold: 0.5,
        jointThreshold: 0.2,
        marginProbability: 0.01,
      },
    },
  };
  const [disabled] = scoreCaptionCandidatesModel([captionModelFixtureCandidate()], { modelData, policyData });
  assert.equal(disabled.primaryFamily, 'none');
  assert.equal(disabled.reasonCode, 'caption_model_v2_disabled_ding');

  const [enabled] = scoreCaptionCandidatesModel([captionModelFixtureCandidate()], {
    modelData,
    policyData: { families: { ding: { ...policyData.families.ding, enabled: true } } },
  });
  assert.equal(enabled.primaryFamily, 'ding');
  assert.equal(enabled.reasonCode, 'caption_model_v2_ding');
  assert.ok(enabled.confidence > 0.9);
});

test('caption v2 policy maps to decoder threshold and margin fields', () => {
  const policies = familyPoliciesForDecoder({
    families: {
      ding: {
        enabled: true,
        jointThreshold: 0.42,
        marginProbability: 0.17,
        cooldownSeconds: 5,
        globalCooldownSeconds: 0.9,
        maxPerMinute: 0.35,
        priority: 55,
      },
    },
  });
  assert.equal(policies.ding.threshold, 0.42);
  assert.equal(policies.ding.marginScore, 0.17);
  assert.equal(policies.ding.cooldownSeconds, 5);
});

function captionModelFixtureCandidate() {
  return {
    id: 'caption-model-fixture',
    kind: 'caption',
    targetSec: 10,
    targetFrame: 300,
    cueIds: ['cue-1'],
    zoomMarkerIds: [],
    anchorTypes: ['cue_end_minus_80ms'],
    text: 'Done',
    features: {
      cueStartSec: 9,
      cueEndSec: 10.08,
      targetSec: 10,
      anchorType: 'cue_end_minus_80ms',
      cueOverlapsZoom: false,
      nearestZoomStartDeltaSec: null,
      nearestZoomDistanceSec: null,
      previousGapSec: null,
      nextGapSec: null,
      speakerChangedFromPrevious: false,
      speakerChangesToNext: false,
      wordTimingAvailable: false,
      wordTimingCoverage: 0,
    },
  };
}
