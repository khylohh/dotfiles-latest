#!/usr/bin/env python3
import argparse
import csv
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression

from caption_moment_router_model import (
    attach_record_context,
    human_events_for_records,
    load_corpus,
    product_metrics,
    records_by_project,
    safe_float,
    training_records,
    write_json,
    write_jsonl,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_SPLITS = EDITOR_ROOT / "validation/outer-splits-v1.json"
DEFAULT_OUT_ROOT = EDITOR_ROOT / "validation/runs-a15"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def compact_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}}


def fix_sparse(matrix):
    matrix.indices = matrix.indices.astype(np.int32, copy=False)
    matrix.indptr = matrix.indptr.astype(np.int32, copy=False)
    return matrix


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


def pop_times(record):
    return sorted(
        safe_float(event.get("audibleStartSeconds"))
        for event in record.get("manualEvents") or []
        if event.get("routerFamily") == "pop" and not event.get("isAutomation")
    )


def zoom_pop_rows(records, match_window_sec):
    output = []
    for record in records:
        project_id = record["project"]["projectId"]
        duration = safe_float(record["project"].get("durationSec"))
        manual_pop_times = pop_times(record)
        raw = []
        seen = set()
        for moment in attach_record_context([record]):
            for option in moment.get("timingOptions") or []:
                if option.get("anchorType") != "zoom_onset" or not option.get("zoomMarkerIds"):
                    continue
                target = safe_float(option.get("targetSec"))
                signature = (project_id, round(target, 3))
                if signature in seen:
                    continue
                seen.add(signature)
                raw.append((target, moment, option))
        zoom_times = [target for target, _moment, _option in sorted(raw, key=lambda item: item[0])]
        for index, (target, moment, option) in enumerate(sorted(raw, key=lambda item: item[0])):
            previous_gap = target - zoom_times[index - 1] if index else 99.0
            next_gap = zoom_times[index + 1] - target if index + 1 < len(zoom_times) else 99.0
            dense = dict(((moment.get("features") or {}).get("dense") or {}))
            lexical = list(((moment.get("features") or {}).get("lexical") or []))
            output.append({
                "projectId": project_id,
                "generalizationGroupId": moment.get("generalizationGroupId", ""),
                "momentId": moment.get("momentId", ""),
                "beatGroupId": moment.get("beatGroupId", ""),
                "targetSec": target,
                "momentSec": safe_float(moment.get("momentSec")),
                "durationSec": duration,
                "text": moment.get("text", ""),
                "selectedTimingOptionId": option.get("optionId", ""),
                "selectedAnchorType": "zoom_onset",
                "previousZoomGapSec": previous_gap,
                "nextZoomGapSec": next_gap,
                "boundaryStrength": safe_float((option.get("parentFeatures") or {}).get("boundaryStrength")),
                "dense": dense,
                "lexical": lexical,
                "label": 1 if any(abs(target - manual_time) <= match_window_sec for manual_time in manual_pop_times) else 0,
            })
    return output


def row_features(row):
    text = str(row.get("text") or "").lower()
    tokens = re.findall(r"[a-z0-9']+", text)
    features = {
        "relativeTime": safe_float(row.get("targetSec")) / max(1.0, safe_float(row.get("durationSec"))),
        "previousZoomGapSec": min(30.0, safe_float(row.get("previousZoomGapSec"), 30.0)),
        "nextZoomGapSec": min(30.0, safe_float(row.get("nextZoomGapSec"), 30.0)),
        "boundaryStrength": safe_float(row.get("boundaryStrength")),
        "tokenCount": len(tokens),
        "hasQuestion": 1.0 if "?" in text else 0.0,
        "hasExclamation": 1.0 if "!" in text else 0.0,
    }
    for key, value in (row.get("dense") or {}).items():
        if key.startswith("candidate_median.") or key.startswith("moment."):
            features[f"dense:{key}"] = safe_float(value)
    for token in tokens:
        features[f"token:{token}"] = 1.0
    for token in row.get("lexical") or []:
        features[f"lexical:{token}"] = 1.0
    return features


def train_model(rows):
    vectorizer = DictVectorizer(sparse=True)
    x = fix_sparse(vectorizer.fit_transform([row_features(row) for row in rows]))
    y = np.array([int(row["label"]) for row in rows], dtype=np.int64)
    if len(set(y.tolist())) < 2:
        raise ValueError("Zoom-pop selector needs both positive and negative training candidates")
    clf = LogisticRegression(max_iter=1000, class_weight="balanced", C=0.4, random_state=20260621)
    clf.fit(x, y)
    return {"vectorizer": vectorizer, "clf": clf}


def score_rows(model, rows):
    x = fix_sparse(model["vectorizer"].transform([row_features(row) for row in rows]))
    return model["clf"].predict_proba(x)[:, 1]


def policy_presets():
    policies = []
    for top_k in [30, 40, 50, 60]:
        policies.append({"policyName": f"top{top_k}_nms5", "topK": top_k, "threshold": 0.0, "nmsSeconds": 5.0})
    for per_minute in [1.5, 2.0, 2.5]:
        policies.append({"policyName": f"perMinute{per_minute:g}_nms5", "topK": None, "maxPerMinute": per_minute, "threshold": 0.0, "nmsSeconds": 5.0})
    for threshold in [0.70, 0.80, 0.90]:
        policies.append({"policyName": f"threshold{threshold:.2f}_nms5", "topK": 9999, "threshold": threshold, "nmsSeconds": 5.0})
    return policies


def select_rows(scored_rows, records, policy):
    if policy.get("topK") is None:
        duration = sum(safe_float(record["project"].get("durationSec")) for record in records)
        max_attempts = max(1, int(math.ceil(duration / 60.0 * safe_float(policy.get("maxPerMinute")))))
    else:
        max_attempts = int(policy["topK"])
    selected = []
    for score, row in sorted(scored_rows, key=lambda item: (-item[0], item[1]["targetSec"], item[1]["momentId"])):
        if score < safe_float(policy.get("threshold")):
            continue
        if len(selected) >= max_attempts:
            break
        if any(
            existing["projectId"] == row["projectId"]
            and abs(safe_float(existing["targetSec"]) - safe_float(row["targetSec"])) < safe_float(policy.get("nmsSeconds"), 5.0)
            for existing in selected
        ):
            continue
        selected.append({
            "projectId": row["projectId"],
            "generalizationGroupId": row.get("generalizationGroupId", ""),
            "momentId": row["momentId"],
            "beatGroupId": row.get("beatGroupId", ""),
            "family": "pop",
            "targetSec": safe_float(row["targetSec"]),
            "selectedTimingOptionId": row.get("selectedTimingOptionId", ""),
            "selectedAnchorType": "zoom_onset",
            "text": row.get("text", ""),
            "evidence": {
                "score": float(score),
                "previousZoomGapSec": row.get("previousZoomGapSec"),
                "nextZoomGapSec": row.get("nextZoomGapSec"),
                "boundaryStrength": row.get("boundaryStrength"),
                "source": "zoom_pop_selector_v1",
            },
        })
    return sorted(selected, key=lambda row: (row["projectId"], row["targetSec"], row["momentId"]))


def inner_folds(records):
    sorted_records = sorted(records, key=lambda record: record["project"]["projectId"])
    return [
        {
            "foldId": f"inner_{index + 1:02d}",
            "train": [record for record in sorted_records if record["project"]["projectId"] != test_record["project"]["projectId"]],
            "test": [test_record],
        }
        for index, test_record in enumerate(sorted_records)
    ]


def median(values):
    nums = sorted(values)
    if not nums:
        return 0
    return nums[len(nums) // 2]


def choose_policy_on_training(records, match_window_sec):
    artifacts = []
    for fold in inner_folds(records):
        model = train_model(zoom_pop_rows(fold["train"], match_window_sec))
        rows = zoom_pop_rows(fold["test"], match_window_sec)
        scores = score_rows(model, rows)
        artifacts.append({"foldId": fold["foldId"], "test": fold["test"], "scoredRows": list(zip(scores, rows))})

    reports = []
    for policy in policy_presets():
        emissions = []
        manual_records = []
        for artifact in artifacts:
            emissions.extend(select_rows(artifact["scoredRows"], artifact["test"], policy))
            manual_records.extend(artifact["test"])
        metrics = product_metrics(emissions, human_events_for_records(manual_records), match_window_sec)
        project_nets = [row["netSavedEdits"] for row in metrics["byProject"]]
        positive_projects = sum(1 for net in project_nets if net > 0)
        pop = metrics["byFamily"]["pop"]
        key = (
            positive_projects / len(project_nets) if project_nets else 0.0,
            median(project_nets),
            pop["netSavedEdits"],
            pop["matched"],
            -pop["falseAdditions"],
            -pop["generatedAttempts"],
        )
        reports.append({
            "policy": policy,
            "metrics": compact_metrics(metrics),
            "popMetrics": pop,
            "positiveProjectCount": positive_projects,
            "medianProjectNetSavedEdits": median(project_nets),
            "choiceKey": key,
        })
    reports.sort(key=lambda item: item["choiceKey"], reverse=True)
    return reports[0], reports


def write_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "humanTotal", "matched", "generatedAttempts", "falseAdditions", "netSavedEdits"]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--outer-splits", default=str(DEFAULT_SPLITS))
    parser.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--fold", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--match-window-sec", type=float, default=5.0)
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    by_project = records_by_project(records)
    splits = selected_splits(read_json(args.outer_splits), args.fold, args.project)
    if not splits:
        raise SystemExit("No folds selected")

    run_id = args.run_id or datetime.now(timezone.utc).strftime("zoom-pop-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_emissions = []
    matches = []
    false_additions = []
    false_negatives = []
    per_project_rows = []
    fold_reports = []

    for fold in splits:
        train = [by_project[project_id] for project_id in fold.get("trainProjectIds") or [] if project_id in by_project]
        test = [by_project[project_id] for project_id in fold.get("testProjectIds") or [] if project_id in by_project]
        if not test:
            continue
        policy_choice, policy_reports = choose_policy_on_training(train, args.match_window_sec)
        model = train_model(zoom_pop_rows(train, args.match_window_sec))
        rows = zoom_pop_rows(test, args.match_window_sec)
        scores = score_rows(model, rows)
        emissions = select_rows(list(zip(scores, rows)), test, policy_choice["policy"])
        manual = human_events_for_records(test)
        metrics = product_metrics(emissions, manual, args.match_window_sec)
        all_emissions.extend(emissions)
        matches.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["matches"])
        false_additions.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["falseAdditionsRows"])
        false_negatives.extend({**row, "foldId": fold.get("foldId", "")} for row in metrics["falseNegativesRows"])
        for row in metrics["byProject"]:
            per_project_rows.append({"foldId": fold.get("foldId", ""), **row})
        fold_reports.append({
            "foldId": fold.get("foldId", ""),
            "generalizationGroupId": fold.get("generalizationGroupId", ""),
            "trainProjectIds": [record["project"]["projectId"] for record in train],
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "candidateCount": len(rows),
            "positiveCandidateCount": sum(1 for row in rows if row["label"]),
            "selectedPolicy": policy_choice,
            "policyReports": policy_reports,
            "outerMetrics": compact_metrics(metrics),
        })
        print(json.dumps({
            "foldId": fold.get("foldId", ""),
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "policyName": policy_choice["policy"]["policyName"],
            "matched": metrics["matched"],
            "humanTotal": metrics["humanTotal"],
            "popMatched": metrics["byFamily"]["pop"]["matched"],
            "popHumanTotal": metrics["byFamily"]["pop"]["humanTotal"],
            "generatedAttempts": metrics["generatedAttempts"],
            "falseAdditions": metrics["falseAdditions"],
            "netSavedEdits": metrics["netSavedEdits"],
        }), flush=True)

    selected_project_ids = sorted({project_id for fold in splits for project_id in fold.get("testProjectIds", []) if project_id in by_project})
    manual = human_events_for_records([by_project[project_id] for project_id in selected_project_ids])
    aggregate = product_metrics(all_emissions, manual, args.match_window_sec)
    report = {
        "schemaVersion": 1,
        "protocol": "zoom-pop-selector-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "metricBoundary": "outer-fold-only; zoom-pop selector and policy selected from trainProjectIds only",
        "matchWindowSec": args.match_window_sec,
        "summary": compact_metrics(aggregate),
        "promotion": {
            "passes": aggregate["netSavedEdits"] > 0,
            "requiredCondition": "outer/test net saved edits > 0",
        },
        "foldReports": fold_reports,
    }
    write_json(run_dir / "zoom-pop-score.json", report)
    write_jsonl(run_dir / "zoom-pop-emissions.jsonl", all_emissions)
    write_jsonl(run_dir / "matches.jsonl", matches)
    write_jsonl(run_dir / "false-additions.jsonl", false_additions)
    write_jsonl(run_dir / "false-negatives.jsonl", false_negatives)
    write_project_csv(run_dir / "per-project-score.csv", per_project_rows)
    write_json(run_dir / "run-manifest.json", {
        "script": str(Path(__file__).relative_to(EDITOR_ROOT)),
        "corpus": str(Path(args.corpus).resolve()),
        "outerSplits": str(Path(args.outer_splits).resolve()),
        "runDir": str(run_dir.resolve()),
        "foldFilter": args.fold,
        "projectFilter": args.project,
        "matchWindowSec": args.match_window_sec,
    })
    print(json.dumps({
        "runDir": str(run_dir),
        "matched": aggregate["matched"],
        "humanTotal": aggregate["humanTotal"],
        "popMatched": aggregate["byFamily"]["pop"]["matched"],
        "popHumanTotal": aggregate["byFamily"]["pop"]["humanTotal"],
        "generatedAttempts": aggregate["generatedAttempts"],
        "falseAdditions": aggregate["falseAdditions"],
        "netSavedEdits": aggregate["netSavedEdits"],
        "passes": report["promotion"]["passes"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
