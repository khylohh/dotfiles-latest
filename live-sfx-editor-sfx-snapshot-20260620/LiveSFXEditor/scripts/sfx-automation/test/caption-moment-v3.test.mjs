import test from 'node:test';
import assert from 'node:assert/strict';
import { EMITTABLE_ROUTER_CLASSES, assetFamilyForRouterClass } from '../editorial-router-taxonomy.mjs';
import { buildCaptionMoments, dedupeTimingOptions, flattenTimingOptions } from '../caption/build-caption-moments.mjs';

test('caption moment v3 groups candidates by beatGroupId', () => {
  const moments = buildCaptionMoments(emptyProject(), captionProjectFixture(), [
    candidateFixture('a', { beatGroupId: 'beat_group_1', targetSec: 10 }),
    candidateFixture('b', { beatGroupId: 'beat_group_1', targetSec: 10.12 }),
    candidateFixture('c', { beatGroupId: 'beat_group_1', targetSec: 10.2 }),
  ]);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].beatGroupId, 'beat_group_1');
  assert.equal(moments[0].candidates.length, 3);
});

test('caption moment v3 flattening preserves nested trigger options', () => {
  const options = flattenTimingOptions([
    candidateFixture('a', {
      triggerOptions: [
        { targetSec: 20.1, anchorType: 'cue_start', source: 'cue.start' },
        { targetSec: 20.8, anchorType: 'final_word_end', source: 'word.end' },
      ],
    }),
  ]);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((option) => option.anchorType), ['cue_start', 'final_word_end']);
  assert.deepEqual(options.map((option) => option.targetSec), [20.1, 20.8]);
});

test('caption moment v3 deduplicates timing options deterministically', () => {
  const deduped = dedupeTimingOptions([
    timingOption('candidate-b', 30, 'final_word_end', ['cue-1']),
    timingOption('candidate-a', 30, 'final_word_end', ['cue-1']),
    timingOption('candidate-c', 30.05, 'cue_end_minus_80ms', ['cue-1']),
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].candidateId, 'candidate-a');
  assert.equal(deduped[1].candidateId, 'candidate-c');
});

test('caption moment v3 creates one orphan zoom moment for unrepresented zoom', () => {
  const moments = buildCaptionMoments({
    ...emptyProject(),
    zoomMarkers: [{ id: 'zoom-1', startSeconds: 12, endSeconds: 13, durationSeconds: 1 }],
  }, captionProjectFixture(), []);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].kind, 'caption_zoom_moment');
  assert.equal(moments[0].timingOptions.length, 1);
  assert.equal(moments[0].timingOptions[0].anchorType, 'zoom_onset');
  assert.deepEqual(moments[0].timingOptions[0].zoomMarkerIds, ['zoom-1']);
});

test('caption moment v3 keeps other_sfx non-emittable and dramatic mapped to heavy', () => {
  assert.equal(EMITTABLE_ROUTER_CLASSES.has('other_sfx'), false);
  assert.equal(assetFamilyForRouterClass('other_sfx'), '');
  assert.equal(assetFamilyForRouterClass('dramatic'), 'heavy');
});

function emptyProject() {
  return {
    name: 'Fixture Project',
    sourceMediaPath: '',
    fps: 30,
    duration: 60,
    zoomMarkers: [],
  };
}

function captionProjectFixture() {
  return {
    descriptorPath: '/tmp/fixture.captionai',
    projectFilePath: '/tmp/fixture.captionai',
    cues: [
      { id: 'cue-1', start: 9.5, end: 10.5, speaker: 'speaker_1', text: 'That worked.' },
      { id: 'cue-2', start: 11.8, end: 12.4, speaker: 'speaker_1', text: 'Look at this.' },
    ],
    words: [],
  };
}

function candidateFixture(id, overrides = {}) {
  const targetSec = Number(overrides.targetSec ?? 20);
  return {
    id: `candidate-${id}`,
    beatGroupId: overrides.beatGroupId || 'beat_group_1',
    targetSec,
    targetFrame: Math.round(targetSec * 30),
    cueIds: ['cue-1'],
    wordIds: [`word-${id}`],
    zoomMarkerIds: [],
    anchorTypes: ['cue_end_minus_80ms'],
    triggerOptions: overrides.triggerOptions || [{
      targetSec,
      anchorType: 'cue_end_minus_80ms',
      source: 'cue.end_minus_80ms',
    }],
    text: 'That worked.',
    captionPath: '/tmp/fixture.captionai',
    captionProjectId: 'caption-fixture',
    captionWindow: 'speaker_1: That worked.',
    resolver: { status: 'ok', resolverConfidence: 100 },
    features: {
      cueStartSec: 9.5,
      cueEndSec: 10.5,
      nearestZoomStartSec: null,
      previousGapSec: 0.5,
      nextGapSec: 0.5,
      wordTimingAvailable: true,
      wordTimingCoverage: 1,
    },
    ...overrides,
  };
}

function timingOption(candidateId, targetSec, anchorType, cueIds) {
  return {
    optionId: `${candidateId}:${anchorType}:${targetSec.toFixed(6)}`,
    candidateId,
    targetSec,
    anchorType,
    source: anchorType,
    cueIds,
    wordIds: [],
    zoomMarkerIds: [],
    parentFeatures: {
      cueStartSec: 29.5,
      cueEndSec: 30.1,
      nearestZoomStartSec: null,
      boundaryStrength: 0.5,
      wordTimingAvailable: true,
    },
  };
}
