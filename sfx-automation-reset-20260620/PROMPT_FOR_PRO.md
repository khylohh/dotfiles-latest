# Prompt for Pro

We need a blunt reset on the Command Center SFX automation plan. Please read the reference files in this repo folder before answering.

Current situation: we are NOT in a good position. The current approach has hints of signal, but it is failing badly enough that the next plan should probably be substantially different, not another small prompt/ranker tweak.

Goal:
A = the user has manual SFX placement work to do.
B = the system generates an editable SFX Interface project file, so the user can delete/swap/add sounds afterward as if a human had started the SFX project.

Current narrow scope tested:
Only ding/success positive-accent moments. Pop/zoom accents are expected to be easier and more deterministic, but they were not the current blocker.

Important evidence:
- Candidate/timing generation is not the main problem. The oracle coverage was very high: roughly 1000/1028 positives within 0.75s and 972/1028 within 0.50s.
- The hard part is deciding which candidate moments actually deserve ding/success, not finding possible timestamps.
- Clean future-video-style test outer_04 failed badly.

Clean outer_04 results:
1. Raw Codex caption selector:
   - 15/82 human ding/success placements found
   - 62 generated
   - 47 false additions
   - precision 24.2%
   - net saved edits -32

2. Same clean outer_04 with ranker filter:
   - 10/82 found
   - 28 generated
   - 18 false additions
   - precision 35.7%
   - net saved edits -8

3. Project-level final LLM filter diagnostic:
   - 1/82 found
   - 12 generated
   - 11 false additions
   - worse

Failure mode:
The system keeps mistaking “positive-sounding caption” or “accent-worthy moment” for “human would place ding/success here.” Many false positives are actually moments where the human used pop/funny/dramatic/boom or no sound at all. So caption-only ding/success selection is not reliably learning the editor’s taste.

We do NOT want:
- More tiny prompt tweaks.
- More guardrails/voting systems unless they are part of a clearly better architecture.
- Metrics that do not predict brand-new videos/scripts.
- Same-project contamination.
- “Looks promising” results that still create more cleanup than saved edits.

We need you to propose a new path from A to B. You may suggest anything that seems most effective, including things we are not currently doing. Assume the current segment-level caption LLM selector is probably the wrong core approach.

Please answer with:
1. A blunt diagnosis of why the current approach is failing.
2. The best new architecture you would try next.
3. What data/features it should use beyond current caption-only selection, if any.
4. How to handle multiple SFX families so ding/success does not steal pop/funny/dramatic/boom moments.
5. A contamination-safe testing plan for brand-new videos/scripts.
6. Concrete build instructions for Codex to implement next.
7. Any specific files/reports you need next, keeping in mind we can provide at most 10 reference files at a time.

Assume Codex will do the implementation locally. The user does not want paid API cost; using local files, local models, or the Codex subscription workflow is acceptable if practical.
