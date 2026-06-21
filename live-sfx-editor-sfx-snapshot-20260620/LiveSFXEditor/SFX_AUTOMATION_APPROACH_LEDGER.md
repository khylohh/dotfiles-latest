# SFX Automation Approach Ledger

Purpose: prevent looping. Before trying a new SFX automation approach, check this file. After any real run, add the approach, score, result, and why it succeeded or failed.

Product score format:

```text
family: matched / human total, generated, false additions, net saved edits
net saved edits = matched - false additions
```

Precision-only, generated-only, same-project, contaminated, or inner-fold scores are diagnostic only. The real target is fewer edits on unseen projects/generalization groups.

## Non-Negotiable Direction

- Current build direction is caption-based only.
- Use captions, cue timing, word timing, pauses, speaker turns, zoom marker timing/IDs, and human SFX labels.
- Do not make video/audio/source-media extraction a blocker.
- Do not use multimodal/frame/audio embeddings for the current system.
- Output must be a normal editable `.sfxinterface` project.

## Approaches Tried

| ID | Approach | Status | Honest Score | Why It Failed Or Succeeded |
|---|---|---|---|---|
| A01 | Production restored baseline: legacy pop/zoom scorer plus caption-family model disabled by policy | Failed, but this is the restored baseline | pop: 331 / 964, generated 701, false 370, net -39. Caption families all 0 generated. | Produces too many pop false additions and does not automate ding/success/bonk/funny/bruh/record scratch. Better than the bad detour, but not useful as the product. |
| A02 | Official nested caption-family validation, candidate-level emit gate plus six-family softmax | Failed closed | 0 official caption-family emissions; `captionFamiliesEnabled: []`. | The structure did not pass clean outer-fold floors. It scores individual anchors and lacks a learned `none`, `pop`, `dramatic`, and `other_sfx` rival class. Re-enabling this as-is is expected to alternate between false additions and zero output. |
| A03 | Ding-only quick binary research pass | Partial diagnostic only | about 7 / 686 ding beats, generated 45, precision about 15.6%. | Showed ding has learnable signal, but not enough to ship. It did not solve full-family routing or edit savings. |
| A04 | Raw Codex positive-accent selector on clean outer_04 | Failed | 15 / 82, generated 62, false 47, net -32. | Too many false additions. It treated vaguely accentable/positive lines as ding/success and stole from none/other families. |
| A05 | Ranker-filtered positive-accent selector on clean outer_04 | Failed | 10 / 82, generated 28, false 18, net -8. | Reduced false additions but still negative net saved edits. Better filtering did not fix the decision structure. |
| A06 | Project-level final filter diagnostic | Failed | 1 / 82, generated 12, false 11, net -10. | Over-filtered into near-zero useful recall while still creating false additions. |
| A07 | Candidate oracle / reachability analysis | Succeeded as diagnostic only | about 1000 / 1028 positive placements within 0.75s; about 972 / 1028 within 0.50s. | Proved candidate timing coverage is not the main bottleneck. It did not solve family selection or edit savings. |
| A08 | Wrong detour: pop/zoom-only V2 runtime plus video/audio feature extraction path | Reverted; failed | pop: 22 / 964, generated 51, false 29, net -7. Overall scored families: 22 / 3574, generated 51, false 29, net -7. | Disabled caption-family generation and moved toward video/audio/multimodal extraction, which is not the current product. It made production worse and was restored out. |
| A09 | P01 Caption Moment V3 offline full-class router: one caption moment per beat group, ten-class route decision, family-conditioned timing selector | Failed; do not wire runtime | Overall: 11 / 4064, generated 49, false 38, net -27. By family: pop 11 / 675, generated 44, false 33, net -22; ding 0 / 686, generated 2, false 2, net -2; success 0 / 345, generated 0, false 0, net 0; bonk 0 / 373, generated 0, false 0, net 0; funny 0 / 321, generated 1, false 1, net -1; bruh 0 / 23, generated 0, false 0, net 0; record_scratch 0 / 51, generated 0, false 0, net 0; dramatic 0 / 652, generated 2, false 2, net -2; other_sfx 0 / 938, generated 0, false 0, net 0. | Correctly tested the untried rival-class structure, but it still failed on grouped outer-only product scoring. Most folds emitted nothing; the folds with recall overproduced false pop attempts. Positive-net project fraction was 1 / 12. This proves the current caption-only dataset plus linear moment router is not useful enough to promote. It does not prove future local LLM/editorial-worker approaches are impossible. |
| A10 | Editorial SFX packet worker: caption-only packets with V3 moments, timing options, fold-safe examples, conservative candidate gates, Codex editorial decisions, and direct product scoring | Failed in first full held-out project run; do not retry with prompt/gate tweaks alone | On `outer_04` / `footage_05_11_26_sfx`: 15 / 326, generated 76, false 61, net -46. By family: pop 11 / 66, generated 33, false 22, net -11; ding 3 / 67, generated 21, false 18, net -15; success 0 / 15, generated 3, false 3, net -3; bonk 1 / 46, generated 6, false 5, net -4; funny 0 / 26, generated 1, false 1, net -1; bruh 0 / 3, generated 1, false 1, net -1; record_scratch 0 / 7, generated 11, false 11, net -11; dramatic 0 / 46, generated 0, false 0, net 0; other_sfx 0 / 50, generated 0, false 0, net 0. | The Codex/editorial worker understood the schema and avoided invalid choices, but it still over-read captions and produced far too many false additions. The candidate gate fixed obvious weak smoke false positives, but the full project remained strongly negative. This proves that a single-pass LLM/editorial selector over broad caption packets is not enough. It does not prove caption automation is impossible. |
| A11 | Evidence-only caption motif model: train-side human motif mining for `pop`, `ding`, and `bonk`, plus fold-safe nearest-neighbor/timing evidence and inner train-side policy selection | Failed closed; do not promote | On `outer_04` / `footage_05_11_26_sfx` with inner policy selection: 0 / 326, generated 0, false 0, net 0. By family: pop 0 / 66, generated 0, false 0, net 0; ding 0 / 67, generated 0, false 0, net 0; bonk 0 / 46, generated 0, false 0, net 0. Inner selection chose `strict` after also scoring 0 / 3738 on training-side inner projects. | This changed the decision structure away from broad LLM/editorial selection, but exact repeated motif evidence was too brittle and emitted nothing. It proves train-side motif replay by itself cannot remove manual SFX work. Do not retry with threshold-only changes; the next approach must use a different representation of editorial intent, not just stricter or looser motif gates. |

## Proposed But Not Yet Tried

| ID | Approach | Status | Expected Reason To Try |
|---|---|---|---|
| P01 | Caption Moment V3: moment-level multiclass classifier with classes `none`, `pop`, `ding`, `success`, `bonk`, `funny`, `bruh`, `record_scratch`, `dramatic`, `other_sfx`, plus family-conditioned timing selector | Tried as A09; failed | It directly addressed the known V2 structure failure, but grouped outer validation showed negative net saved edits. Do not retry with threshold-only tuning. |

## Implementation Notes

- 2026-06-21: P01 slice 1 implemented locally: preserve `captionProjectPath` / `captionProjectId`, pass explicit caption path into caption-only automation, remove the UI zoom-marker preflight blocker, and allow caption resolution when `sourceMediaPath` is empty. This is not a model/product score improvement by itself.
- 2026-06-21: P01 Steps 1-3 implemented and validated offline only. Validation run `validation/runs-v3/caption-moment-v3-001` used grouped outer folds with inner-only model/threshold selection. Result failed promotion: 11 / 4064, generated 49, false 38, net -27. Per the stop/go rule, runtime wiring was not implemented.
- 2026-06-21: A10 implementation started as an offline-only loop: `sfx:editorial-packets-v1`, `sfx:editorial-worker-v1`, `sfx:editorial-worker-batch-v1`, and `sfx:editorial-score-v1`. This is not a product win until actual worker decisions score positive net saved edits on held-out projects.
- 2026-06-21: A10 first full held-out run completed on `outer_04` / `footage_05_11_26_sfx` using gated 480-second packets and Codex decisions. Result failed: 15 / 326, generated 76, false 61, net -46. The next attempt must change the decision structure, not merely wording/thresholds.
- 2026-06-21: A11 implemented as `sfx:evidence-motifs-v1` and `sfx:evidence-motif-validation-v1`. Fixed strict and inner-selected runs both failed closed on `outer_04` / `footage_05_11_26_sfx`: 0 / 326, generated 0, false 0, net 0. The inner selector chose `strict` because all train-side inner policies failed to produce positive saved edits.

## Required Log Entry For Future Runs

Every new run must add:

```text
ID:
Approach:
Train/test boundary:
Families enabled:
Scores by family:
Overall net saved edits:
Succeeded or failed:
Why:
What it proves:
What it does not prove:
Next action:
```

## Duplicate-Work Rule

Do not retry an approach above unless the next attempt changes the specific failure cause listed in the right column. Threshold retuning alone is not a new approach when the failure was the model structure.
