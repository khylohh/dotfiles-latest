# Previous Pro / Planning Context

These excerpts are included so Pro can see the prior planning direction and why this is a reset, not a first attempt.

## Prior blunt verdict / architecture direction

## 1. Blunt verdict

**Yes. The current pointwise linear caption classifier is effectively failed for the product goal.** Treat the blind result as approximately **0/75 useful ding coverage**. The nested result is likewise about **12 matched positive placements out of 1,028 human positive beats—roughly 1.2% placement coverage**—with zero production events materialized. It is evidence that captions contain some signal, not evidence that the current system is close. 

The problem is larger than classifier capacity:

* The scorer is pointwise and largely lexical: regex semantic buckets, n-grams, punctuation, timing, and zoom proximity. It cannot reliably answer the editorial question, “Which of these nearby moments deserves the accent?” 
* The emissions show the failure mode directly: generic reactions or positive wording such as “That is so cool,” “Yeah,” and “that is good” score highly even when no positive accent was placed; “This is perfect” coincides with dramatic/meme treatment instead.
* The selection policy is structurally incompatible with coverage. The corpus contains 1,028 positive beats over roughly 6.21 hours, about **2.76 human positive beats per minute**, while every evaluated policy caps output at **0.35 per minute**. That is only about 13% of human density even with a perfect ranker.
* When nothing passes the promotion floors, the fallback policy favors precision and tiny output. It therefore selects silence rather than discovering whether the ranking can cover meaningful portions of a project.

Do not spend more time adjusting `C`, probability thresholds, or subtype margins. Preserve the candidate generator, hard-negative corpus, grouped validation, and normal project materializer. Replace the primary scorer and selection objective.

The best route is a **retrieval-augmented, segment-level semantic selector**, initially using an LLM for listwise editorial judgment, followed by a small learned reranker and deterministic sequence decoder. The current linear model may remain as one weak feature or baseline.

## 2. What Codex should build next, in order

### A. Fix the evaluation objective before another model run

Fork `07_run-positive-accent-validation.py` into a new v2 validator. Keep the current file frozen as the baseline.

Add these metrics:

```text
combinedCoverage = combinedMatched / manualPositive
exactFamilyCoverage = exactMatched / manualPositive
dingPlacementCoverage = positive matches on human ding beats / human ding beats
successPlacementCoverage = positive matches on human success beats / human success beats
falseAdditions = generated - combinedMatched
falseAdditionsPerMinute = falseAdditions / projectDurationMinutes
netSavedEdits = combinedMatched - falseAdditions
netSavedEditFraction = netSavedEdits / manualPositive
```

The current `recall` concept should be split into `exactRecall` and `combinedRecall`. A positive-accent detector must not call a ding near a human success beat a recall failure while simultaneously counting it as a combined precision success.

Evaluate the ranking at useful output budgets:

```python
BUDGETS_PER_MINUTE = [0.50, 0.75, 1.00, 1.25, 1.50, 2.00]
```

Select the budget, confidence cutoff, spacing, and routing rules only inside inner folds. Do not retain the hard-coded `0.35` as the only operating density.

Also produce **shadow-routed outer emissions** even when promotion fails. They are diagnostic artifacts only and must not enable production, but they prevent the current situation where subtype performance is unknowable because all routed events were suppressed.

### B. Verify candidate-generation ceiling

Before replacing the scorer, calculate the oracle:

```text
For every human ding/success beat:
    Does any caption candidate exist within 0.75 seconds?
    Does a strong candidate exist within 0.50 seconds?
    What is the best anchor type and timing error?
```

Report this by project and family.

The existing label summary has 852 strong positive candidates for 1,028 positive beats, suggesting approximately **83% strong caption-candidate observability** if those assignments are one-to-one. That makes candidate generation unlikely to be the main bottleneck, but Codex should verify it explicitly. 

If strong oracle coverage is below 60% on several projects, fix candidate anchors first. Otherwise freeze candidate generation and work on selection.

### C. Create one semantic “moment” per beat group

The present model treats multiple timing anchors as independent point examples. Replace that training unit with one moment per `beatGroupId`, retaining alternative timing anchors inside the moment.

Use records shaped like:

```json
{
  "schemaVersion": 1,
  "projectId": "footage_...",
  "generalizationGroupId": "group_...",
  "segmentId": "project:segment_0042",
  "momentId": "project:beat_group_123",
  "candidateOptions": [
    {
      "candidateId": "...",
      "targetSec": 123.45,
      "targetFrame": 3704,
      "anchorTypes": ["final_word_end"],
      "zoomMarkerIds": []
    }
  ],
  "context": {
    "previousCues": [],
    "currentCue": {},
    "nextCues": [],
    "markedText": "...previous... <CANDIDATE>current text</CANDIDATE> ...next..."
  },
  "timingFeatures": {},
  "zoomFeatures": {},
  "label": {
    "kind": "positive|hard_other|clean_negative|ignore",
    "manualBeatId": "...",
    "manualTime": 123.39,
    "manualFamilies": ["ding"],
    "subtype": "ding"
  }
}
```

Use approximately three caption cues before and after, plus timestamps, speaker changes, gaps, and nearby zoom markers. The LLM and retrieval encoder need enough context to distinguish “we are going to try” from “it worked,” and a setup from its payoff.

### D. Build retrieval over prior human editorial decisions

Embed each moment’s marked caption context. For each fold, build the retrieval index from **training projects only**.

Maintain three namespaces:

```text
positive: ding or success
hard_other: pop, dramatic, swoosh, bonk, riser, meme, etc.
clean_negative: no nearby manual SFX
```

For each query moment retrieve, from distinct training projects:

```text
top 12 positive neighbors
top 12 hard-other neighbors
top 12 clean negatives
```

Create features:

```text
bestPositiveSimilarity
meanTop3PositiveSimilarity
bestHardOtherSimilarity
meanTop3HardOtherSimilarity
positiveMinusHardMargin
positiveSupportingProjectCount
hardOtherSupportingProjectCount
neighborDingVote
neighborSuccessVote
```

Pure nearest-neighbor should be evaluated as a baseline, but it should not be the final selector. It will work well for recurring editorial patterns and poorly for ambiguous generic captions.

### E. Use an LLM as a listwise segment selector

This has the best chance of moving rapidly from effectively 0/75 coverage.

Divide each video into overlapping 30–45 second segments. Start a new segment at a substantial caption pause or speaker/topic break, with a maximum length limit. For each segment:

1. Deduplicate candidates by `beatGroupId`.
2. Shortlist roughly eight candidates using retrieval margin, boundary strength, and mined high-precision patterns.
3. Provide the full caption segment, candidate IDs, timing information, and retrieved training examples.
4. Ask the model to select zero, one, or two candidates from the supplied IDs.

Use a fixed structured output:

```json
{
  "selections": [
    {
      "candidateId": "candidate_123",
      "confidence": 0.86,
      "momentType": "completed_result",
      "family": "success",
      "captionSufficient": true,
      "otherSfxRisk": "none"
    }
  ]
}
```

The prompt must explicitly reject:

```text
future plans or attempts without a realized result
generic reactions without a specific payoff
failure, mishap, suspense, dramatic escalation, or comedy beats
sentence fragments whose meaning depends on an unseen visual
duplicate accents for the same semantic payoff
```

It should distinguish:

```text
success:
completion, achievement, solved problem, win, correct result, finished task

ding:
reveal, item attribute, pleasant discovery, selection confirmation,
specific answer, count, price/value reveal, positive detail

either:
clear positive payoff where subtype is editorially interchangeable
```

For `either`, materialize a normal `ding` unless training-side routing strongly favors `success`. Do not suppress a high-confidence placement merely because subtype is ambiguous.

For validation, the prompt, model identifier, decoding settings, and taxonomy must be frozen and hashed. Few-shot examples must be retrieved exclusively from that fold’s training projects.

### F. Add a pairwise reranker

Use the LLM output as semantic evidence, not as an unconstrained final oracle.

For every training segment, generate pairs:

```python
for positive in human_positive_candidates:
    for negative in same_segment_hard_other:
        train(x_positive - x_negative, label=1)
        train(x_negative - x_positive, label=0)

    for negative in most_semantically_similar_clean_negatives[:5]:
        train(x_positive - x_negative, label=1)
        train(x_negative - x_positive, label=0)
```

Features should include:

```text
LLM confidence and semantic tags
retrieval features
existing dense timing/zoom features
current linear-model score
candidate boundary strength
distance to competing candidates
segment-relative position
```

A pairwise logistic model is sufficient for the first implementation. The critical change is the relative training objective and semantic representation, not using a larger classifier. A gradient-boosted ranking model can follow after the pipeline works.

### G. Replace greedy thresholding with budgeted sequence decoding

For each project, sort moments by time and use dynamic programming to maximize total rank score under:

```text
selected budget per minute
minimum spacing, selected from [2.5, 3.5, 5.0] seconds
maximum two positive accents per 30-second segment
one selected timing option per beatGroupId
hard veto for high other-SFX risk
```

Do not globally force one accent every five seconds; use spacing as a constraint, not the core model.

The decoder should select the best anchor option for each accepted moment based on training-side timing distributions by `momentType` and anchor type.

## 3. Priority among the candidate approaches

The order should be:

1. **Retrieval-augmented LLM listwise selection.** Best immediate probability of capturing editorial payoff, context, and sparse relative choice.
2. **Pairwise ranker over semantic, retrieval, and timing features.** Use as reranker and eventual local distillation target.
3. **Editorial pattern mining.** Use high-confidence multi-project patterns as candidate seeds and vetoes, not as the whole system.
4. **Sequence decoding.** Essential, but initially deterministic rather than a neural sequence model.
5. **Pure nearest-neighbor.** Valuable baseline and explanation source, unlikely to handle generic or novel phrasing alone.
6. **A trained neural caption sequence model.** Not today. The corpus is small enough that a new transformer-style sequence model is more likely to consume time and overfit than produce the fastest useful result.

The current pointwise classifier should only contribute a feature. It should no longer determine placement or policy.

## 4. Exact file changes

### Preserve

`07_run-positive-accent-validation.py`

Keep it unchanged as the reproducible linear baseline.

### Modify

`08_export-visible-caption-corpus.mjs`

Add:

```text
generalizationGroupId
segment-boundary inputs
full candidate-context cue references
stable moment/segment IDs
all alternative anchors for each beatGroupId
```

Continue retaining every non-caption SFX family as a hard negative. The exporter already emits ordinary manual event family and timing fields and excludes the locked holdout; retain those safeguards.

`09_extract-caption-beat-features.mjs`

Keep the current timing, pause, speaker, and zoom features. Add only sequence-relative features:

```text
candidatesInPrevious10Sec
candidatesInNext10Sec
timeSincePreviousSegmentBoundary
timeToNextSegmentBoundary
candidateRankWithinCue
nearbyGenericReactionCount
```

Do not spend the build expanding the regex vocabulary. The lexical feature system is already saturated for this approach. 

`10_run-sfx-pass.mjs`

Add a scorer selection path:

```js
scorePositiveAccentCandidatesHybrid(...)
decodePositiveAccentTimeline(...)
```

Then reuse the existing path:

```js
materializeDecisions(...)
packNewEventsAroundFixedEvents(...)
nextProject.events = packedEvents
```

The current function already produces a normal project by materializing decisions and packing generated events with existing events. Preserve that path. 

### Add

```text
11_run-positive-accent-hybrid-validation.py
build-positive-accent-moments.mjs
annotate-positive-accent-moments.mjs
build-positive-accent-retrieval-index.py
train-positive-accent-ranker.py

sfx-automation/scoring/positive-accent-hybrid-scorer.mjs
sfx-automation/decoding/decode-positive-accent-timeline.mjs

config/sfx-automation-v2/positive-accent-policy.json

tests/positive-accent-holdout-guard.test.py
tests/positive-accent-train-only-retrieval.test.py
tests/positive-accent-normal-event-materialization.test.mjs
```

The model artifact should contain:

```json
{
  "modelVersion": "positive-accent-hybrid-v1",
  "embeddingModelId": "...",
  "semanticModelId": "...",
  "promptHash": "...",
  "trainingProjectIdsHash": "...",
  "momentSchemaVersion": 1,
  "ranker": {},
  "policy": {
    "budgetPerMinute": 1.0,
    "minimumSpacingSeconds": 3.5,
    "segmentMax": 2,
    "confidenceThreshold": 0.0
  }
}
```

All `positive_accent`, retrieval, semantic, and ranking fields remain internal model/debug data.

Immediately before existing materialization, convert the selected internal result to the exact ordinary decision shape already used by `decodeTimeline`:

```js
{
  candidateId,
  targetSec,
  targetFrame,
  family: selectedFamily, // exactly "ding" or "success"
  score: placementScore,
  source: "caption"
}
```

The resulting saved event must use the existing asset/materializer output with `categoryId` equal to `ding` or `success`. No `positive_accent` category, event type, track, or project schema field should be introduced. Add a test that scans every saved event and rejects `categoryId === "positive_accent"`.

## 5. Validation and product criteria

For every outer fold:

```text
1. Build semantic examples, patterns, retrieval indexes, and ranker from outer-train only.
2. Use grouped inner folds to select:
   - output budget
   - LLM confidence cutoff
   - pairwise model configuration
   - spacing and segment cap
   - routing confidence and ambiguous-family fallback
3. Freeze the fold choice and hash it.
4. Score the outer group once.
```

The outer-test captions may be embedded or sent through the frozen semantic prompt because this uses no labels. No retrieved demonstration, mined pattern, vocabulary, calibration point, or prompt edit may come from outer-test labels.

`footage_06_10_26_sfx` remains absent from all indexes, caches, examples, and validation splits. The June 17 project remains absent from official prompt examples, semantic-pattern discovery, retrieval data, and policy selection.

Report macro and per-project results, not only pooled totals:

```text
combined placement coverage
exact family coverage
precision
false additions per minute
net saved edits
median project coverage
25th-percentile project coverage
percentage of projects with positive net saved edits
```

A reasonable threshold for initial app use is:

```text
combined coverage >= 20%
combined precision >= 70%
false additions <= 0.5 per minute
positive net saved edits on at least 75% of held-out projects
median project coverage >= 15%
```

On a project with 75 human placements, 20% coverage means roughly 15 placements found rather than one. That is the first result that begins to reduce real work.

A strong production result would be:

```text
combined coverage >= 30%
combined precision >= 75%
median project coverage >= 25%
```

Stop the caption-only approach when either condition holds:

* Candidate oracle coverage is below 60%; the target is not sufficiently caption-observable.
* Candidate oracle coverage is above 75%, but retrieval-augmented listwise selection cannot exceed 10% combined coverage at 60% precision across clean outer groups.

In the second case, the remaining editorial decision depends materially on visuals, performance, or audio delivery. Do not respond by adding more lexical rules; add multimodal context or narrow the automatable target taxonomy.

## 6. Additional files Codex should inspect

No additional evidence is needed for the strategic call. For exact production wiring, Codex should inspect these repository files before editing:

```text
scoring/caption-model-scorer.mjs
decoding/decode-timeline.mjs
rendering/materialize-events.mjs
loaders/load-asset-pack.mjs
one representative editable SFX Interface project JSON
```

Those are needed only to copy the exact existing scored-candidate and materialized-event shapes. The architecture should not wait on further exploratory analysis.


## Later progress direction update

According to a document from June 20, 2026, the architecture is now the right shape, but the current selector is still a failed product.

1. Blunt diagnosis

The correct architecture is now:

deterministic candidates → listwise semantic selection → deterministic editable project materialization

The evidence is unusually clear. Candidate generation covers 1,000 of 1,028 human placements within 0.75 seconds and 972 within 0.50 seconds; median candidate timing error is about 0.10 seconds. The current ranker, however, finds only 50 of 1,028 placements, adds 84 wrong sounds, produces net saved edits of −34, and reaches only 4.3% median project coverage. Candidate timing is solved well enough; editorial selection is not.  

The project is therefore in this state:

* Candidate and timing infrastructure: ready enough to freeze.
* Editable project materialization: already essentially ready.
* Editorial selector: unproven and currently unusable.
* Overall product: not ready.

The existing pipeline already turns decisions into ordinary events, packs them alongside existing events, and returns a normal project. The .sfxinterface writer preserves a normal project snapshot and backing project file. That path should be reused unchanged rather than inventing a new automation-specific project format.  

2. Fastest honest path

Do not build another trained classifier first. Do not tune the existing ranker. Do not build voting, calibration, or a complicated decoder.

Build one strong frontier-model selector that directly answers the unresolved editorial question:

Given this caption segment and these supplied candidate IDs, which moments would a human editor accent with ding or success?

Run that selector across clean grouped holdouts with training-only retrieved examples. Count every valid selection in the product score; do not hide weak output behind a confidence threshold. If it produces useful clean-holdout coverage, materialize it through the existing pipeline. Only then run the identical prompt packets through a local model.

This order establishes whether the task is semantically solvable from the available caption context. Trying local models first would conflate two questions: whether the selector design works and whether a small quantized model is capable enough.

3. Model recommendations

Best API/frontier model: gpt-5.5-2026-04-23.

Use the fixed snapshot, the Responses API, reasoning effort medium, and strict structured output. GPT-5.5 is OpenAI’s current frontier model for complex professional work, supports structured outputs, and provides a dated snapshot so model behavior can be frozen for validation.  

Qwen3.7-Max: treat it as a second API benchmark, not the first implementation target. It is a proprietary cloud model announced for complex reasoning and long-horizon agentic work, not a downloadable local model. It may be useful later as an independent comparison, but GPT-5.5’s fixed snapshot and native strict-output support make it the cleaner first proof.  

Best local candidate for the M2/16 GB Mac: mlx-community/Qwen3.5-9B-MLX-4bit.

It is approximately 5.6–6 GB and explicitly targets Apple Silicon. Run it through MLX with an 8K context cap, short structured output, and thinking disabled initially. This is the best first local candidate, not a claim that it will match the frontier selector. Qwen3-8B 4-bit remains the smaller fallback if Qwen3.5 runtime behavior is unstable.  

Rule out Qwen3.6 27B and 35B locally on this machine. The common MLX 4-bit packages are approximately 16.1 GB for Qwen3.6-27B and 20.4 GB for Qwen3.6-35B-A3B. The former consumes essentially all unified memory before KV cache, runtime buffers, and macOS; the latter does not fit. Extreme low-bit compression or CPU offloading might launch a model, but it would be a slow, fragile detour rather than a viable production path.  

4. First selector harness

Segmentation

Use:

* 30-second selectable core
* 8 seconds of read-only caption context before and after
* Only candidates whose target falls inside the 30-second core may be returned.
* Deduplicate by beatGroupId.
* If a core contains more than 32 moment groups, split it at the largest caption gap rather than pruning candidates.
* Permit zero to four selections per core. Do not impose a project-wide per-minute budget in the first proof.

This prevents overlapping segments from creating duplicate selectable regions while still giving the model enough setup and payoff context. It also avoids introducing a shortlist ranker that could become another recall bottleneck.

Candidate fields

Each visible moment should contain only concise, editorially relevant data:

{
  "candidateId": "cand_caption_beat_...",
  "momentId": "project:beat_group_123",
  "relativeTimeSec": 17.42,
  "cueIds": ["cue-123"],
  "speakerKey": "speaker_2",
  "captionText": "Yeah, we finally got it working",
  "anchorTypes": ["final_word_end", "pause_boundary"],
  "precedingGapSec": 0.12,
  "followingGapSec": 0.64,
  "boundaryStrength": 0.8,
  "nearestZoomDeltaSec": null
}

Do not send the large raw dense-feature dictionaries. Choose one canonical candidate option deterministically for each moment group; keep alternate anchors internal. The LLM decides whether the moment deserves an accent, not where the sound waveform should begin.

The existing moment data already provides grouped candidate options, three-cue context windows, marked text, timing features, and zoom references.  

Caption context

Send ordered cues from the complete 46-second context window:

{
  "segmentId": "project:segment_0042",
  "coreStartSec": 120,
  "coreEndSec": 150,
  "contextStartSec": 112,
  "contextEndSec": 158,
  "cues": [
    {
      "cueId": "cue-120",
      "startSec": 118.4,
      "endSec": 120.1,
      "speakerKey": "speaker_1",
      "text": "Let's see whether this works"
    }
  ],
  "candidates": []
}

Also generate a human-readable caption rendering with candidate markers:

[00:13.20 speaker_1] We just need one more.
[00:17.42 speaker_2] Yeah, we finally got it working. <cand_caption_beat_abc>
[00:19.10 speaker_1] Okay, next one.

Retrieval examples

Create a fold-specific retrieval index using outer-training projects only. No example may come from the tested project, its generalization group, the locked holdout, or the opened blind project.

For every segment, retrieve eight examples, preferably from distinct projects:

* 2 human ding decisions
* 2 human success/either decisions
* 2 hard-other decisions
* 2 clean negatives

Each example should contain:

{
  "exampleId": "train_example_...",
  "markedCaptionContext": "... <CANDIDATE> ...",
  "humanDecision": "ding",
  "otherFamily": null
}

For hard-other examples:

{
  "humanDecision": "other_sfx",
  "otherFamily": "dramatic"
}

Do not add synthetic explanations to the historical examples. The human decision itself is the evidence. The available corpus has 995 positive moments, 2,396 hard-other moments, and 9,112 clean negatives, which is sufficient for a meaningful retrieval layer.  

For the first API harness, use text-embedding-3-large and cache all embeddings. It is OpenAI’s current most capable embedding model.  

Selector rules

The system prompt should define:

* success: completed task, achieved result, solved problem, correct answer, win, finished outcome.
* ding: reveal, positive detail, pleasant discovery, item attribute, specific answer, count/value, selection confirmation.
* Interchangeable positive accents should become ding unless completion is clearly the point.

Explicitly reject:

* Future plans, attempts, or setup without a realized payoff
* Generic “yeah,” “cool,” or “good” reactions without a specific editorial point
* Failure, suspense, mishap, dramatic escalation, or comedy beats
* Moments whose meaning requires an unseen visual
* Multiple accents for the same payoff

These distinctions match the failure cases already identified in the project evidence.  

Exact JSON output schema

Do not request confidence scores or arbitrary timestamps. The first score should evaluate the model’s actual placement decisions, not a tunable confidence proxy.

{
  "name": "positive_accent_segment_selection",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "segmentId",
      "selections"
    ],
    "properties": {
      "schemaVersion": {
        "type": "integer",
        "const": 1
      },
      "segmentId": {
        "type": "string"
      },
      "selections": {
        "type": "array",
        "maxItems": 4,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "candidateId",
            "family",
            "momentType"
          ],
          "properties": {
            "candidateId": {
              "type": "string",
              "enum": [
                "<dynamically insert this segment's allowed candidate IDs>"
              ]
            },
            "family": {
              "type": "string",
              "enum": [
                "ding",
                "success"
              ]
            },
            "momentType": {
              "type": "string",
              "enum": [
                "reveal",
                "positive_detail",
                "selection_confirmation",
                "specific_answer",
                "completed_result",
                "correct_result",
                "achievement"
              ]
            }
          }
        }
      }
    }
  }
}

The runtime must also reject duplicate candidateId values.

Arbitrary timestamp hallucination becomes impossible because the schema has no timestamp field, each candidateId is a request-specific enum, and code—not the model—resolves the selected ID to targetSec and targetFrame. An invalid response gets one schema retry; a second failure becomes an empty selection plus a recorded model error. That is validation, not voting.

5. What Codex should build next

Give Codex this implementation directive:

Build a validation-first positive-accent LLM selector.
Do not modify or retune the current linear/moment-ranker baseline.
Do not add voting, confidence thresholds, model ensembles, or policy sweeps.
Do not open the locked final holdout.
1. Freeze:
   - existing caption/beat candidate generation
   - existing moment dataset
   - existing clean evaluation baseline
   - existing materializeDecisions/packNewEvents project path
2. Add:
   - build-positive-accent-selector-segments.mjs
   - build-positive-accent-retrieval-index.py
   - run-positive-accent-llm-selector.py
   - validate-positive-accent-llm-selector.py
   - positive-accent-selector-schema.json
3. Segment projects into 30-second selectable cores with 8-second
   read-only context on each side. Deduplicate by beatGroupId.
   Split segments with more than 32 moment groups; do not shortlist
   using the failed classifier.
4. Build each outer fold's retrieval index from outer-training
   projects only. Add explicit assertions preventing test-project,
   same-generalization-group, locked-holdout, and opened-blind
   examples from entering prompts.
5. Call gpt-5.5-2026-04-23 once per segment with reasoning effort
   medium and strict structured output. Cache request and response
   by model ID + prompt hash + schema hash + segment hash.
6. Validate every returned candidateId against that segment's
   allow-list. Resolve IDs to deterministic candidate timestamps.
   Count every valid returned selection; do not threshold confidence.
7. Perform one-to-one matching against human ding/success beats at
   0.75 seconds. Also report 0.50-second results diagnostically.
8. Output:
   - aggregate metrics JSON
   - per-project metrics JSON/CSV
   - all selected candidate IDs
   - false-addition audit rows with caption context
   - prompt/model/schema/retrieval hashes
   - API usage and model-error counts
   - a boolean productMaterializationGatePassed
9. Add tests:
   - test labels never enter selector prompts
   - retrieval is outer-train-only
   - unknown candidate IDs fail closed
   - duplicate IDs are rejected
   - no arbitrary timestamp field is accepted
   - generated events use categoryId ding or success
   - no positive_accent project category exists
   - generated .sfxinterface files reload successfully
10. Only after the clean frontier evaluation passes the product gate,
    add an API scorer path to generateSFXPass. Convert selections to:
    {
      candidateId,
      targetSec,
      targetFrame,
      family: "ding" | "success",
      score: 1,
      source: "caption"
    }
    Then reuse materializeDecisions, packNewEventsAroundFixedEvents,
    and the existing .sfxinterface writer.

The current code already has the required final materialization route; the new work is principally the selector, leakage-safe retrieval, and honest validation.  

After that frontier run, replay the exact cached selector inputs through Qwen3.5-9B locally. Do not rewrite the prompt for the local model before obtaining its first comparative score. That gives a clean frontier-to-local capability gap.

6. Honest acceptance metrics

Use one-to-one matching so one generated sound cannot claim multiple human placements.

combinedCoverage =
    matched human ding-or-success placements
    / total human ding-or-success placements
exactFamilyCoverage =
    matched placements with correct ding/success family
    / total human ding-or-success placements
wrongAdditions =
    generated placements - combinedMatched
falseAdditionsPerMinute =
    wrongAdditions / total project minutes
netSavedEdits =
    combinedMatched - wrongAdditions
projectCoverage[j] =
    combinedMatched[j] / manualPositive[j]
medianProjectCoverage =
    median(projectCoverage)
positiveNetProjectFraction =
    projects where matched[j] - wrongAdditions[j] > 0
    / evaluated projects

Minimum gate for producing an editable first-pass project as a real product feature:

combined coverage >= 20%
precision >= 70%
false additions per minute <= 0.50
net saved edits > 0 overall
median project coverage >= 15%
positive net saved edits on >= 75% of held-out projects
all generated project files reload successfully

Strong result:

combined coverage >= 30%
precision >= 75%
median project coverage >= 25%

The current system is at 4.9% combined coverage, 37.3% precision, −34 net saved edits, and 4.3% median coverage, so it clearly fails this gate.   The proposed initial and strong thresholds are consistent with the prior project evaluation recommendations.  

Technically, any valid output can be materialized for shadow inspection because the project remains editable. It should not be presented as a useful generated first pass until the minimum gate passes on clean unseen projects.

7. Proxy metric traps

Do not accept any of these as product progress:

* “Nine predictions, one correct” without reporting that the project contained 75 human placements.
* High precision obtained by making almost no placements.
* AUC, classifier accuracy, F1, or top-k ranking accuracy without found / total human placements.
* Candidate-oracle coverage presented as selector coverage.
* Scores from projects used to choose examples, prompts, rules, thresholds, or output density.
* Pooled coverage that hides projects with near-zero coverage; always report median project coverage.
* Exact-family accuracy used to obscure low combined ding/success coverage.
* Model agreement, majority voting, or confidence calibration treated as correctness.
* Successful .sfxinterface generation treated as proof that the selected sounds are editorially useful.

The shortest honest route is therefore: one frozen frontier listwise selector, clean grouped evaluation, existing deterministic materializer, then an identical local-model comparison.
