import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSFXEvent, packEvents, packNewEventsAroundFixedEvents } from '../../../shared/sfx-event-core.mjs';
import { readLiveSFXDescriptor, writeLiveSFXDescriptorCopy } from '../../lib/live-sfx-project-io.mjs';
import { resolveCaptionProjectForMedia } from '../caption/find-caption-project.mjs';
import { decodeTimeline } from '../decoding/decode-timeline.mjs';
import { familyPoliciesForDecoder, scoreCaptionCandidatesModel } from '../scoring/caption-model-scorer.mjs';
import { scoreCaptionCandidatesLocal } from '../scoring/caption-rule-scorer.mjs';

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

test('caption resolver validates explicit caption identity and timebase', () => {
  const fixture = createCaptionResolverFixture();
  try {
    const resolver = resolveCaptionProjectForMedia(fixture.project, { captionPath: fixture.captionPath });
    assert.equal(resolver.status, 'ok');
    assert.equal(resolver.captionPath, fixture.captionPath);
    assert.ok(Math.abs(Number(resolver.durationDeltaSec)) <= Math.max(0.5, Number(fixture.project.duration) * 0.005));
    assert.ok(Number(resolver.resolverConfidence) >= 100);
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('caption resolver accepts explicit caption project without source media or zoom markers', () => {
  const fixture = createCaptionResolverFixture();
  try {
    const projectNoMedia = {
      ...fixture.project,
      sourceMediaPath: '',
      zoomMarkers: [],
      captionProjectPath: fixture.captionPath,
    };
    const resolver = resolveCaptionProjectForMedia(projectNoMedia);
    assert.equal(resolver.status, 'ok');
    assert.equal(resolver.captionPath, fixture.captionPath);
    assert.ok(Math.abs(Number(resolver.durationDeltaSec)) <= Math.max(0.5, Number(fixture.project.duration) * 0.005));
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test('live sfx descriptor copy preserves caption project path and id', () => {
  const fixture = createCaptionResolverFixture();
  try {
    const outPath = join(fixture.tempDir, 'Caption Round Trip.sfxinterface');
    const written = writeLiveSFXDescriptorCopy({
      ...fixture.project,
      sourceMediaPath: '',
      zoomMarkers: [],
      captionProjectPath: fixture.captionPath,
      captionProjectId: 'caption-fixture',
    }, outPath);
    assert.equal(written.descriptor.captionProjectPath, fixture.captionPath);
    assert.equal(written.descriptor.captionProjectId, 'caption-fixture');
    assert.equal(written.descriptor.projectSnapshot.captionProjectPath, fixture.captionPath);
    assert.equal(written.descriptor.projectSnapshot.captionProjectId, 'caption-fixture');

    const { descriptor, project: reloaded } = readLiveSFXDescriptor(outPath);
    assert.equal(descriptor.captionProjectPath, fixture.captionPath);
    assert.equal(descriptor.captionProjectId, 'caption-fixture');
    assert.equal(reloaded.captionProjectPath, fixture.captionPath);
    assert.equal(reloaded.captionProjectId, 'caption-fixture');
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
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

function createCaptionResolverFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), 'live-sfx-caption-'));
  const mediaPath = join(tempDir, 'Footage 05-27-26.mp4');
  const captionPath = join(tempDir, 'Captions 05-27-26.captionai');
  const duration = 1224.24;
  const descriptor = {
    kind: 'CaptionAIProject',
    version: 1,
    mediaPath,
    projectSnapshot: {
      name: 'Captions 05-27-26',
      sourceMediaPath: mediaPath,
      duration,
      cues: [
        { id: 'cue-1', start: 0.12, end: 1.44, text: 'Done.' },
        { id: 'cue-2', start: 1220.2, end: 1221.76, text: 'That worked.' },
      ],
    },
  };
  writeFileSync(captionPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  return {
    tempDir,
    captionPath,
    project: {
      version: 1,
      name: 'Footage 05-27-26 SFX',
      sourceMediaPath: mediaPath,
      outputDir: tempDir,
      libraryRoot: '/tmp/sfx-library',
      manualRoot: '/tmp/manual-sfx',
      fps: 59.94005994005994,
      duration,
      sampleRate: 48000,
      zoomXmlPath: '',
      zoomMarkers: [{
        id: 'zoom-1',
        name: 'Zoom 1',
        startFrame: 120,
        endFrame: 180,
        startSeconds: 2,
        endSeconds: 3,
        durationSeconds: 1,
      }],
      captionProjectPath: '',
      captionProjectId: '',
      reactionOffsetFrames: 5,
      maxPlaybackRate: 1.4,
      masterGainDb: -12,
      events: [],
      decks: {},
    },
  };
}
