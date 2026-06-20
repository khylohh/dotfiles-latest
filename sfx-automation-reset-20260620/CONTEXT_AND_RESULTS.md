# Context and Results Summary

## Product Goal

The production target is not an abstract classifier. The target is an automation system that outputs an editable SFX Interface project file. The user should then be able to delete, swap, or add sounds manually in the existing SFX Interface.

The current build should focus only on sound types that are realistically automatable. For now, the tested blocker is ding/success positive-accent placement. Pop/zoom accents are likely more mathematical and should not be confused with caption-only ding/success selection.

## Evaluation Rule

The only useful score is on brand-new videos/scripts not used for training or tuning. Contaminated same-project numbers are useless except as diagnostics.

Main score format: `human placements found / total human placements`, plus generated count, false additions, and net saved edits.

Materialization gate currently used:
- Combined coverage >= 20%
- Precision >= 70%
- False additions/min <= 0.50
- Net saved edits > 0
- Median project coverage >= 15%
- Positive net on >= 75% held-out projects

## Current Result

Clean outer_04 raw selector: {'productScore': '15/82', 'generated': 62, 'precision': 0.24193548387096775, 'falseAdditions': 47, 'netSavedEdits': -32, 'partialEvaluation': False, 'productMaterializationGatePassed': False}

Clean outer_04 ranker filtered: {'productScore': '10/82', 'generated': 28, 'precision': 0.35714285714285715, 'falseAdditions': 18, 'netSavedEdits': -8, 'partialEvaluation': False, 'productMaterializationGatePassed': False}

Outer_04 project-level final filter diagnostic: {'productScore': '1/82', 'generated': 12, 'precision': 0.08333333333333333, 'falseAdditions': 11, 'netSavedEdits': -10, 'partialEvaluation': False, 'productMaterializationGatePassed': False}

## What Failed

The selector is finding real positives sometimes, but it is also selecting many moments that are merely positive, cute, explanatory, dramatic, funny, pop-like, boom-like, or unscored. This makes the generated SFX project worse than manual work.

The project-level final selector did not fix this. It accepted only 12 proposals and scored 1/82.

## Current Hypothesis

Caption-only positive-accent selection is probably the wrong core approach. The next plan should likely use a different representation or a multi-family/event-type model so ding/success cannot steal moments belonging to pop/funny/dramatic/boom/no-sound.
