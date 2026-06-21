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

## Proposed But Not Yet Tried

| ID | Approach | Status | Expected Reason To Try |
|---|---|---|---|
| P01 | Caption Moment V3: moment-level multiclass classifier with classes `none`, `pop`, `ding`, `success`, `bonk`, `funny`, `bruh`, `record_scratch`, `dramatic`, `other_sfx`, plus family-conditioned timing selector | Not tried | Directly addresses known failure: missing learned `none`/rival classes and duplicate anchor scoring. It should score one semantic moment once, then choose timing, so ding/success can be blocked by pop/bonk/funny/dramatic/none. |

## Implementation Notes

- 2026-06-21: P01 slice 1 implemented locally: preserve `captionProjectPath` / `captionProjectId`, pass explicit caption path into caption-only automation, remove the UI zoom-marker preflight blocker, and allow caption resolution when `sourceMediaPath` is empty. This is not a model/product score improvement by itself.

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
