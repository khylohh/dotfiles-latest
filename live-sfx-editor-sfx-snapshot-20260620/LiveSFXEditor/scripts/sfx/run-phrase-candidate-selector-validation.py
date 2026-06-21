#!/usr/bin/env python3
import argparse
import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import SGDClassifier

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
from phrase_cue_model import (
    build_phrase_cue_model,
    choose_phrase_timing,
    moment_phrase_keys,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_SPLITS = EDITOR_ROOT / "validation/outer-splits-v1.json"
DEFAULT_OUT_ROOT = EDITOR_ROOT / "validation/runs-a13"

POLICIES = [
    {
        "policyName": "top8_all",
        "topK": 8,
        "allowedFamilies": None,
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {},
    },
    {
        "policyName": "top12_all",
        "topK": 12,
        "allowedFamilies": None,
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {},
    },
    {
        "policyName": "top20_all",
        "topK": 20,
        "allowedFamilies": None,
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {},
    },
    {
        "policyName": "top20_core",
        "topK": 20,
        "allowedFamilies": ["pop", "ding", "bonk"],
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {"pop": 8, "ding": 12, "bonk": 4},
    },
    {
        "policyName": "top30_core",
        "topK": 30,
        "allowedFamilies": ["pop", "ding", "bonk"],
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {"pop": 10, "ding": 16, "bonk": 6},
    },
    {
        "policyName": "top20_positive",
        "topK": 20,
        "allowedFamilies": ["pop", "ding", "success"],
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {"pop": 8, "ding": 12, "success": 4},
    },
    {
        "policyName": "top12_ding_pop",
        "topK": 12,
        "allowedFamilies": ["pop", "ding"],
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {"pop": 6, "ding": 8},
    },
    {
        "policyName": "top20_ding_pop",
        "topK": 20,
        "allowedFamilies": ["pop", "ding"],
        "globalNmsSeconds": 0.75,
        "phraseCooldownSeconds": 8.0,
        "familyCaps": {"pop": 8, "ding": 14},
    },
]


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


def phrase_candidates(model, records, fold_id="", min_pos=1):
    rows = []
    for moment in attach_record_context(records):
        dense = ((moment.get("features") or {}).get("dense") or {})
        seen = set()
        for key in moment_phrase_keys(moment):
            for rule in model.get("rulesByKey", {}).get(key, []):
                if rule.get("source") != "cue" or rule.get("pos", 0) < min_pos:
                    continue
                timing = choose_phrase_timing(model, moment, rule)
                if not timing:
                    continue
                signature = (
                    moment["projectId"],
                    moment["momentId"],
                    rule["family"],
                    rule["phrase"],
                    round(safe_float(timing["targetSec"]), 2),
                )
                if signature in seen:
                    continue
                seen.add(signature)
                anchors = rule.get("anchors") or []
                top_anchor = anchors[0] if anchors else {}
                rows.append({
                    "foldId": fold_id,
                    "projectId": moment["projectId"],
                    "generalizationGroupId": moment.get("generalizationGroupId", ""),
                    "momentId": moment["momentId"],
                    "beatGroupId": moment.get("beatGroupId", ""),
                    "momentSec": moment.get("momentSec"),
                    "text": moment.get("text", ""),
                    "family": rule["family"],
                    "targetSec": timing["targetSec"],
                    "selectedTimingOptionId": timing["option"].get("optionId", ""),
                    "selectedAnchorType": timing["option"].get("anchorType", ""),
                    "timingScore": timing.get("timingScore"),
                    "dense": dense,
                    "evidence": {
                        "phrase": rule["phrase"],
                        "source": rule["source"],
                        "pos": rule["pos"],
                        "neg": rule["neg"],
                        "posProjects": rule["posProjects"],
                        "precision": rule["precision"],
                        "quality": rule["quality"],
                        "length": rule["length"],
                        "topAnchorCount": top_anchor.get("count", 0),
                        "topAnchorType": top_anchor.get("anchorType", ""),
                        "timingSource": timing.get("timingSource", ""),
                    },
                })
    return rows


def label_candidates(rows, manual, match_window_sec):
    manual_by_project_family = defaultdict(list)
    for event in manual:
        manual_by_project_family[(event["projectId"], event["family"])].append(event["time"])
    labels = []
    for row in rows:
        labels.append(1 if any(
            abs(safe_float(row["targetSec"]) - safe_float(time)) <= match_window_sec
            for time in manual_by_project_family.get((row["projectId"], row["family"]), [])
        ) else 0)
    return labels


def row_features(row):
    evidence = row.get("evidence") or {}
    dense = row.get("dense") or {}
    phrase = evidence.get("phrase") or ""
    output = {
        f"family:{row.get('family', '')}": 1,
        f"anchor:{row.get('selectedAnchorType', '')}": 1,
        f"topAnchor:{evidence.get('topAnchorType', '')}": 1,
        f"timingSource:{evidence.get('timingSource', '')}": 1,
        "length": safe_float(evidence.get("length")),
        "pos": math.log1p(safe_float(evidence.get("pos"))),
        "neg": math.log1p(safe_float(evidence.get("neg"))),
        "posProjects": safe_float(evidence.get("posProjects")),
        "precision": safe_float(evidence.get("precision")),
        "quality": safe_float(evidence.get("quality")),
        "topAnchorCount": math.log1p(safe_float(evidence.get("topAnchorCount"))),
        "moment.has_zoom": safe_float(dense.get("moment.has_zoom")),
        "moment.is_orphan_zoom": safe_float(dense.get("moment.is_orphan_zoom")),
        "moment.option_count": safe_float(dense.get("moment.option_count")),
        "text.has_question": 1.0 if "?" in str(row.get("text") or "") else 0.0,
        "text.has_exclamation": 1.0 if "!" in str(row.get("text") or "") else 0.0,
    }
    for token in re.findall(r"[a-z0-9']+", phrase.lower())[:6]:
        output[f"phraseToken:{token}"] = 1
    return output


def train_selector(rows, labels):
    vectorizer = DictVectorizer(sparse=True)
    x = fix_sparse(vectorizer.fit_transform([row_features(row) for row in rows]))
    clf = SGDClassifier(
        loss="log_loss",
        alpha=1e-5,
        max_iter=25,
        class_weight="balanced",
        random_state=20260621,
    )
    clf.fit(x, labels)
    return {"vectorizer": vectorizer, "clf": clf}


def score_candidates(selector, rows):
    x = fix_sparse(selector["vectorizer"].transform([row_features(row) for row in rows]))
    return selector["clf"].predict_proba(x)[:, 1]


def select_rows(rows, scores, policy):
    allowed = set(policy.get("allowedFamilies") or [])
    family_caps = policy.get("familyCaps") or {}
    family_counts = defaultdict(int)
    selected = []
    by_project_times = defaultdict(list)
    by_phrase_times = defaultdict(list)
    for score, row in sorted(zip(scores, rows), key=lambda item: (-item[0], item[1]["projectId"], item[1]["targetSec"])):
        if len(selected) >= policy["topK"]:
            break
        family = row["family"]
        if allowed and family not in allowed:
            continue
        if family in family_caps and family_counts[family] >= family_caps[family]:
            continue
        project_id = row["projectId"]
        target_sec = safe_float(row["targetSec"])
        if any(abs(target_sec - existing) < policy["globalNmsSeconds"] for existing in by_project_times[project_id]):
            continue
        phrase_key = (project_id, family, (row.get("evidence") or {}).get("phrase", ""))
        if any(abs(target_sec - existing) < policy["phraseCooldownSeconds"] for existing in by_phrase_times[phrase_key]):
            continue
        clean = {key: value for key, value in row.items() if key != "dense"}
        clean["selectorScore"] = float(score)
        selected.append(clean)
        by_project_times[project_id].append(target_sec)
        by_phrase_times[phrase_key].append(target_sec)
        family_counts[family] += 1
    return selected


def build_oof_training_candidates(train_records, match_window_sec):
    rows = []
    labels = []
    sorted_records = sorted(train_records, key=lambda record: record["project"]["projectId"])
    for index, test_record in enumerate(sorted_records):
        inner_train = [record for record in sorted_records if record["project"]["projectId"] != test_record["project"]["projectId"]]
        model = build_phrase_cue_model(inner_train)
        fold_id = f"oof_{index + 1:02d}"
        fold_rows = phrase_candidates(model, [test_record], fold_id)
        rows.extend(fold_rows)
        labels.extend(label_candidates(fold_rows, human_events_for_records([test_record]), match_window_sec))
    return rows, labels


def choose_policy(rows, scores, manual, match_window_sec):
    best = None
    reports = []
    for policy in POLICIES:
        emissions = select_rows(rows, scores, policy)
        metrics = product_metrics(emissions, manual, match_window_sec)
        key = (
            metrics["netSavedEdits"],
            metrics["matched"],
            -metrics["falseAdditions"],
            -metrics["generatedAttempts"],
        )
        report = {
            "policy": policy,
            "metrics": compact_metrics(metrics),
            "choiceKey": key,
        }
        reports.append(report)
        if best is None or key > best["choiceKey"]:
            best = report
    return best, reports


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
    run_id = args.run_id or datetime.now(timezone.utc).strftime("phrase-candidate-selector-v1-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_emissions = []
    all_suppressed = []
    fold_reports = []
    per_project_rows = []
    matches = []
    false_additions = []
    false_negatives = []

    for fold in splits:
        train = [by_project[project_id] for project_id in fold.get("trainProjectIds") or [] if project_id in by_project]
        test = [by_project[project_id] for project_id in fold.get("testProjectIds") or [] if project_id in by_project]
        if not test:
            continue
        oof_rows, oof_labels = build_oof_training_candidates(train, args.match_window_sec)
        selector = train_selector(oof_rows, oof_labels)
        oof_scores = score_candidates(selector, oof_rows)
        chosen_policy, policy_reports = choose_policy(oof_rows, oof_scores, human_events_for_records(train), args.match_window_sec)
        phrase_model = build_phrase_cue_model(train)
        test_candidates = phrase_candidates(phrase_model, test, fold.get("foldId", ""))
        test_scores = score_candidates(selector, test_candidates)
        emissions = select_rows(test_candidates, test_scores, chosen_policy["policy"])
        manual = human_events_for_records(test)
        metrics = product_metrics(emissions, manual, args.match_window_sec)
        all_emissions.extend(emissions)
        for row in metrics["matches"]:
            matches.append({**row, "foldId": fold.get("foldId", "")})
        for row in metrics["falseAdditionsRows"]:
            false_additions.append({**row, "foldId": fold.get("foldId", "")})
        for row in metrics["falseNegativesRows"]:
            false_negatives.append({**row, "foldId": fold.get("foldId", "")})
        for row in metrics["byProject"]:
            per_project_rows.append({"foldId": fold.get("foldId", ""), **row})
        fold_reports.append({
            "foldId": fold.get("foldId", ""),
            "generalizationGroupId": fold.get("generalizationGroupId", ""),
            "trainProjectIds": [record["project"]["projectId"] for record in train],
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "candidateCounts": {
                "oofRows": len(oof_rows),
                "oofPositiveLabels": int(sum(oof_labels)),
                "testRows": len(test_candidates),
            },
            "selectedPolicy": chosen_policy,
            "policyReports": policy_reports,
            "outerMetrics": compact_metrics(metrics),
        })
        print(json.dumps({
            "foldId": fold.get("foldId", ""),
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "policyName": chosen_policy["policy"]["policyName"],
            "matched": metrics["matched"],
            "humanTotal": metrics["humanTotal"],
            "generatedAttempts": metrics["generatedAttempts"],
            "falseAdditions": metrics["falseAdditions"],
            "netSavedEdits": metrics["netSavedEdits"],
        }), flush=True)

    selected_project_ids = sorted({project_id for fold in splits for project_id in fold.get("testProjectIds", []) if project_id in by_project})
    aggregate = product_metrics(all_emissions, human_events_for_records([by_project[project_id] for project_id in selected_project_ids]), args.match_window_sec)
    report = {
        "schemaVersion": 1,
        "protocol": "phrase-candidate-selector-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "metricBoundary": "outer-fold-only; selector trained on training-project OOF candidates only",
        "matchWindowSec": args.match_window_sec,
        "summary": compact_metrics(aggregate),
        "promotion": {
            "passes": aggregate["netSavedEdits"] > 0,
            "requiredCondition": "outer/test net saved edits > 0",
        },
        "foldReports": fold_reports,
    }
    write_json(run_dir / "run-manifest.json", {
        "schemaVersion": 1,
        "runId": run_id,
        "corpus": str(Path(args.corpus).resolve()),
        "outerSplits": str(Path(args.outer_splits).resolve()),
        "foldFilter": args.fold,
        "projectFilter": args.project,
        "matchWindowSec": args.match_window_sec,
    })
    write_json(run_dir / "phrase-candidate-selector-score.json", report)
    write_jsonl(run_dir / "phrase-candidate-selector-emissions.jsonl", all_emissions)
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
