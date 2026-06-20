# Command Center SFX Automation Reset Reference Pack

This repo folder is a focused evidence pack for planning the next SFX automation architecture. It is not the full local project.

Read `PROMPT_FOR_PRO.md` first.

## Files

1. `PROMPT_FOR_PRO.md` - the actual prompt/request for Pro.
2. `CONTEXT_AND_RESULTS.md` - plain-English context and current results.
3. `OUTER04_RAW_REPORT.json` - clean held-out raw Codex selector report.
4. `OUTER04_RANKER_REPORT.json` - clean held-out ranker-filtered report.
5. `OUTER04_PROJECT_FILTER_REPORT.json` - project-level final filter diagnostic report.
6. `OUTER04_FAILURE_EXAMPLES.json` - scored matched/false selections from the clean outer_04 run.
7. `ORACLE_AND_FORENSIC_RESULTS.json` - oracle evidence plus forensic/dev run summaries.
8. `CODE_CONTEXT.md` - key implementation files/prompts/scoring code.
9. `PREVIOUS_PRO_CONTEXT.md` - prior Pro/context excerpts that led to this point.
10. `README.md` - this file.

## Core Takeaway

Current caption-only ding/success automation does not work for new videos. Clean outer_04 result was `15/82` with 47 false additions. The next plan should probably be a different architecture, not small prompt tweaking.
