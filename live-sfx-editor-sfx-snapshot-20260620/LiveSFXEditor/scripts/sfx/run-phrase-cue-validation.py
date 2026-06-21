#!/usr/bin/env python3
import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

from caption_moment_router_model import (
    attach_record_context,
    human_events_for_records,
    load_corpus,
    product_metrics,
    records_by_project,
    training_records,
    write_json,
    write_jsonl,
)
from phrase_cue_model import (
    build_phrase_cue_model,
    default_policy,
    policy_presets,
    score_moment,
    summarize_model,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_SPLITS = EDITOR_ROOT / "validation/outer-splits-v1.json"
DEFAULT_OUT_ROOT = EDITOR_ROOT / "validation/runs-a12"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def compact_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}}


def apply_nms(rows, seconds):
    selected = []
    suppressed = []
    phrase_cooldown = 0.0
    if rows:
        phrase_cooldown = rows[0].get("policyPhraseCooldownSeconds", 0.0)
    for row in sorted(rows, key=lambda item: (-item["evidence"]["score"], item["projectId"], item["targetSec"], item["momentId"])):
        if any(
            existing["projectId"] == row["projectId"]
            and abs(existing["targetSec"] - row["targetSec"]) < seconds
            for existing in selected
        ):
            suppressed.append(row)
            continue
        phrase = row.get("evidence", {}).get("phrase")
        if phrase_cooldown > 0 and phrase and any(
            existing["projectId"] == row["projectId"]
            and existing["family"] == row["family"]
            and existing.get("evidence", {}).get("phrase") == phrase
            and abs(existing["targetSec"] - row["targetSec"]) < phrase_cooldown
            for existing in selected
        ):
            suppressed.append(row)
            continue
        selected.append(row)
    return sorted(selected, key=lambda item: (item["projectId"], item["targetSec"], item["momentId"])), suppressed


def predict_records(model, records, fold_id, policy):
    rows = []
    for moment in attach_record_context(records):
        scored = score_moment(model, moment, policy)
        if not scored:
            continue
        rows.append({
            "foldId": fold_id,
            "projectId": moment.get("projectId", ""),
            "generalizationGroupId": moment.get("generalizationGroupId", ""),
            "momentId": moment.get("momentId", ""),
            "beatGroupId": moment.get("beatGroupId", ""),
            "momentSec": moment.get("momentSec"),
            "text": moment.get("text", ""),
            "family": scored["family"],
            "targetSec": scored["targetSec"],
            "selectedTimingOptionId": scored["selectedTimingOptionId"],
            "selectedAnchorType": scored["selectedAnchorType"],
            "timingScore": scored["timingScore"],
            "policyPhraseCooldownSeconds": policy.get("phrase_cooldown_seconds", 0.0),
            "evidence": scored["evidence"],
        })
    return apply_nms(rows, policy["global_nms_seconds"])


def write_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "humanTotal", "matched", "generatedAttempts", "falseAdditions", "netSavedEdits"]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})


def selected_splits(splits, fold_filter="", project_filter=""):
    folds = splits.get("folds") or []
    if fold_filter:
        wanted = {item.strip() for item in fold_filter.split(",") if item.strip()}
        folds = [fold for fold in folds if fold.get("foldId") in wanted]
    if project_filter:
        wanted = {item.strip() for item in project_filter.split(",") if item.strip()}
        filtered = []
        for fold in folds:
            test_ids = [project_id for project_id in fold.get("testProjectIds") or [] if project_id in wanted]
            if test_ids:
                filtered.append({**fold, "testProjectIds": test_ids})
        folds = filtered
    return folds


def inner_folds(records):
    folds = []
    sorted_records = sorted(records, key=lambda record: record["project"]["projectId"])
    for index, test_record in enumerate(sorted_records):
        train = [record for record in sorted_records if record["project"]["projectId"] != test_record["project"]["projectId"]]
        if not train:
            continue
        folds.append({
            "foldId": f"inner_{index + 1:02d}",
            "train": train,
            "test": [test_record],
        })
    return folds


def select_policy_on_training(records):
    prepared_folds = [
        {**fold, "model": build_phrase_cue_model(fold["train"])}
        for fold in inner_folds(records)
    ]
    best = None
    for policy in policy_presets():
        emissions = []
        manual_records = []
        for fold in prepared_folds:
            fold_emissions, _suppressed = predict_records(fold["model"], fold["test"], fold["foldId"], policy)
            emissions.extend(fold_emissions)
            manual_records.extend(fold["test"])
        metrics = product_metrics(emissions, human_events_for_records(manual_records))
        key = (
            metrics["netSavedEdits"],
            metrics["matched"],
            -metrics["falseAdditions"],
            -metrics["generatedAttempts"],
            1 if policy["policyName"] == "strict" else 0,
        )
        item = {
            "policy": policy,
            "metrics": compact_metrics(metrics),
            "choiceKey": key,
        }
        if best is None or key > best["choiceKey"]:
            best = item
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--outer-splits", default=str(DEFAULT_SPLITS))
    parser.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--fold", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--select-policy", action="store_true")
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    by_project = records_by_project(records)
    splits = selected_splits(read_json(args.outer_splits), args.fold, args.project)
    if not splits:
        raise SystemExit("No folds selected")
    fixed_policy = default_policy()
    run_id = args.run_id or datetime.now(timezone.utc).strftime("phrase-cues-v1-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_emissions = []
    all_suppressed = []
    fold_reports = []
    per_project_rows = []
    matches = []
    false_additions = []
    false_negatives = []
    model_summaries = []

    for fold in splits:
        train = [by_project[project_id] for project_id in fold.get("trainProjectIds") or [] if project_id in by_project]
        test = [by_project[project_id] for project_id in fold.get("testProjectIds") or [] if project_id in by_project]
        if not test:
            continue
        policy_choice = select_policy_on_training(train) if args.select_policy else {
            "policy": fixed_policy,
            "metrics": None,
            "choiceKey": None,
        }
        policy = policy_choice["policy"]
        model = build_phrase_cue_model(train)
        emissions, suppressed = predict_records(model, test, fold.get("foldId", ""), policy)
        manual = human_events_for_records(test)
        metrics = product_metrics(emissions, manual)
        all_emissions.extend(emissions)
        all_suppressed.extend(suppressed)
        matches.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["matches"])
        false_additions.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["falseAdditionsRows"])
        false_negatives.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["falseNegativesRows"])
        for row in metrics["byProject"]:
            per_project_rows.append({"foldId": fold.get("foldId", ""), **row})
        model_summary = summarize_model(model)
        model_summaries.append({"foldId": fold.get("foldId", ""), **model_summary})
        fold_reports.append({
            "foldId": fold.get("foldId", ""),
            "generalizationGroupId": fold.get("generalizationGroupId", ""),
            "trainProjectIds": [record["project"]["projectId"] for record in train],
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "outerMetrics": compact_metrics(metrics),
            "modelSummary": model_summary,
            "policy": policy,
            "innerPolicyMetrics": policy_choice.get("metrics"),
        })
        print(json.dumps({
            "foldId": fold.get("foldId", ""),
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "policyName": policy.get("policyName"),
            "matched": metrics["matched"],
            "humanTotal": metrics["humanTotal"],
            "generatedAttempts": metrics["generatedAttempts"],
            "falseAdditions": metrics["falseAdditions"],
            "netSavedEdits": metrics["netSavedEdits"],
        }), flush=True)

    selected_project_ids = sorted({project_id for fold in splits for project_id in fold.get("testProjectIds", []) if project_id in by_project})
    manual = human_events_for_records([by_project[project_id] for project_id in selected_project_ids])
    aggregate = product_metrics(all_emissions, manual)
    report = {
        "schemaVersion": 1,
        "protocol": "phrase-cues-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "metricBoundary": "outer-fold-only; phrase cue rules built from trainProjectIds only",
        "enabledFamilies": sorted(model_summaries[-1]["enabledFamilies"]) if model_summaries else [],
        "policySelection": "inner_leave_one_project" if args.select_policy else "fixed_strict",
        "defaultPolicy": fixed_policy,
        "summary": compact_metrics(aggregate),
        "promotion": {
            "passes": aggregate["netSavedEdits"] > 0,
            "requiredCondition": "outer/test net saved edits > 0",
        },
        "foldReports": fold_reports,
        "modelSummaries": model_summaries,
    }
    write_json(run_dir / "run-manifest.json", {
        "schemaVersion": 1,
        "runId": run_id,
        "corpus": str(Path(args.corpus).resolve()),
        "outerSplits": str(Path(args.outer_splits).resolve()),
        "foldFilter": args.fold,
        "projectFilter": args.project,
    })
    write_json(run_dir / "phrase-cue-score.json", report)
    write_jsonl(run_dir / "phrase-cue-emissions.jsonl", all_emissions)
    write_jsonl(run_dir / "phrase-cue-nms-suppressed.jsonl", all_suppressed)
    write_jsonl(run_dir / "matches.jsonl", matches)
    write_jsonl(run_dir / "false-additions.jsonl", false_additions)
    write_jsonl(run_dir / "false-negatives.jsonl", false_negatives)
    write_project_csv(run_dir / "per-project-score.csv", per_project_rows)
    print(json.dumps({
        "runDir": str(run_dir),
        "matched": aggregate["matched"],
        "humanTotal": aggregate["humanTotal"],
        "generatedAttempts": aggregate["generatedAttempts"],
        "falseAdditions": aggregate["falseAdditions"],
        "netSavedEdits": aggregate["netSavedEdits"],
        "passes": report["promotion"]["passes"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
