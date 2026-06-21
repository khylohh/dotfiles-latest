#!/usr/bin/env python3
import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from caption_moment_router_model import (
    attach_record_context,
    build_route_examples,
    decode_predictions,
    fit_router,
    fit_timing_ranker,
    human_events_for_records,
    load_corpus,
    predict_router,
    product_metrics,
    records_by_project,
    training_records,
    write_json,
    write_jsonl,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
C_GRID = [0.03, 0.10, 0.30]
THRESHOLDS = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]
MODEL_CACHE = {}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def inner_folds(records):
    by_group = defaultdict(list)
    for record in records:
        group_id = record["project"].get("generalizationGroupId") or record["project"]["projectId"]
        by_group[group_id].append(record)
    folds = []
    for index, group_id in enumerate(sorted(by_group)):
        test_ids = {record["project"]["projectId"] for record in by_group[group_id]}
        train_records = [record for record in records if record["project"]["projectId"] not in test_ids]
        if train_records:
            folds.append({
                "foldId": f"inner_{index + 1:02d}",
                "testGroupId": group_id,
                "trainRecords": train_records,
                "testRecords": by_group[group_id],
            })
    return folds


def fit_model_for_records(records, c_value):
    key = (tuple(sorted(record["project"]["projectId"] for record in records)), float(c_value))
    if key in MODEL_CACHE:
        return MODEL_CACHE[key]
    examples, timing_assignments = build_route_examples(records)
    model = fit_router(examples, c_value)
    model["timingRanker"] = fit_timing_ranker(timing_assignments, c_value)
    MODEL_CACHE[key] = model
    return model


def predict_records(model, records, fold_id):
    moments = attach_record_context(records)
    return predict_router(model, moments, fold_id)


def select_threshold(predictions, records):
    manual = human_events_for_records(records)
    best = None
    for threshold in THRESHOLDS:
        policy = {
            "schemaVersion": 3,
            "emitThreshold": threshold,
            "globalNmsSeconds": 0.30,
            "nonEmittingClasses": ["none", "other_sfx"],
            "selectionObjective": "inner_oof_net_saved_edits",
        }
        emissions = decode_predictions(predictions, policy)
        metrics = product_metrics(emissions, manual)
        key = (
            metrics["netSavedEdits"],
            metrics["matched"],
            -metrics["generatedAttempts"],
            threshold,
        )
        item = {
            "policy": policy,
            "metrics": {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}},
            "scoreKey": key,
        }
        if best is None or key > best["scoreKey"]:
            best = item
    return best


def select_model_and_policy(records):
    best = None
    for c_value in C_GRID:
        predictions = []
        for fold in inner_folds(records):
            model = fit_model_for_records(fold["trainRecords"], c_value)
            predictions.extend(predict_records(model, fold["testRecords"], fold["foldId"]))
        selected = select_threshold(predictions, records)
        key = (
            selected["metrics"]["netSavedEdits"],
            selected["metrics"]["matched"],
            -selected["metrics"]["generatedAttempts"],
            selected["policy"]["emitThreshold"],
            -c_value,
        )
        item = {
            "c": c_value,
            "policy": selected["policy"],
            "innerMetrics": selected["metrics"],
            "choiceKey": key,
        }
        if best is None or key > best["choiceKey"]:
            best = item
    return best


def compact_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}}


def write_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "humanTotal", "matched", "generatedAttempts", "falseAdditions", "netSavedEdits"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"))
    parser.add_argument("--project-manifest", default=str(EDITOR_ROOT / "validation/project-manifest-v1.json"))
    parser.add_argument("--outer-splits", default=str(EDITOR_ROOT / "validation/outer-splits-v1.json"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs-v3"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    by_project = records_by_project(records)
    splits = read_json(args.outer_splits)["folds"]
    run_id = args.run_id or datetime.now(timezone.utc).strftime("caption-moment-v3-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_predictions = []
    all_emissions = []
    fold_choices = []
    per_project_rows = []
    false_additions = []
    false_negatives = []

    for outer in splits:
        train = [by_project[project_id] for project_id in outer["trainProjectIds"] if project_id in by_project]
        test = [by_project[project_id] for project_id in outer["testProjectIds"] if project_id in by_project]
        if not test:
            continue
        choice = select_model_and_policy(train)
        model = fit_model_for_records(train, choice["c"])
        predictions = predict_records(model, test, outer["foldId"])
        emissions = decode_predictions(predictions, choice["policy"])
        manual = human_events_for_records(test)
        metrics = product_metrics(emissions, manual)
        all_predictions.extend(predictions)
        all_emissions.extend(emissions)
        false_additions.extend({**row, "foldId": outer["foldId"]} for row in metrics["falseAdditionsRows"])
        false_negatives.extend({**row, "foldId": outer["foldId"]} for row in metrics["falseNegativesRows"])
        for row in metrics["byProject"]:
            per_project_rows.append({"foldId": outer["foldId"], **row})
        fold_choices.append({
            "foldId": outer["foldId"],
            "generalizationGroupId": outer["generalizationGroupId"],
            "trainProjectIds": [record["project"]["projectId"] for record in train],
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "c": choice["c"],
            "policy": choice["policy"],
            "innerMetrics": choice["innerMetrics"],
            "outerMetrics": compact_metrics(metrics),
        })
        print(json.dumps({
            "foldId": outer["foldId"],
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "c": choice["c"],
            "threshold": choice["policy"]["emitThreshold"],
            "outer": {
                "matched": metrics["matched"],
                "humanTotal": metrics["humanTotal"],
                "generatedAttempts": metrics["generatedAttempts"],
                "falseAdditions": metrics["falseAdditions"],
                "netSavedEdits": metrics["netSavedEdits"],
            },
        }), flush=True)

    outer_manual = human_events_for_records(records)
    aggregate = product_metrics(all_emissions, outer_manual)
    report = {
        "schemaVersion": 3,
        "protocol": "caption-moment-router-v3-nested-grouped",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "metricBoundary": "outer-fold-only; model and threshold selected without each outer project/group",
        "summary": compact_metrics(aggregate),
        "promotion": {
            "outerAggregateNetSavedEdits": aggregate["netSavedEdits"],
            "passes": aggregate["netSavedEdits"] > 0,
            "requiredCondition": "outer aggregate net saved edits > 0",
        },
        "foldChoices": fold_choices,
        "modelGrid": C_GRID,
        "thresholdGrid": THRESHOLDS,
    }
    write_json(run_dir / "run-manifest.json", {
        "schemaVersion": 3,
        "runId": run_id,
        "corpus": str(Path(args.corpus).resolve()),
        "projectManifest": str(Path(args.project_manifest).resolve()),
        "outerSplits": str(Path(args.outer_splits).resolve()),
    })
    write_jsonl(run_dir / "outer-predictions.jsonl", all_predictions)
    write_jsonl(run_dir / "outer-emissions.jsonl", all_emissions)
    write_json(run_dir / "outer-product-score.json", report)
    write_project_csv(run_dir / "per-project-score.csv", per_project_rows)
    write_jsonl(run_dir / "false-additions.jsonl", false_additions)
    write_jsonl(run_dir / "false-negatives.jsonl", false_negatives)
    write_json(run_dir / "choice-influence-audit.json", {"foldChoices": fold_choices})
    print(json.dumps({
        "runDir": str(run_dir),
        "matched": aggregate["matched"],
        "humanTotal": aggregate["humanTotal"],
        "generatedAttempts": aggregate["generatedAttempts"],
        "falseAdditions": aggregate["falseAdditions"],
        "netSavedEdits": aggregate["netSavedEdits"],
        "passes": aggregate["netSavedEdits"] > 0,
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
