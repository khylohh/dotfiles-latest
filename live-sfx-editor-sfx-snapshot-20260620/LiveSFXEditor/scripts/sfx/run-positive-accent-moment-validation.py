#!/usr/bin/env python3
import argparse
import csv
import json
import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
OPENED_BLIND_CAPTION_ID = "blind_caption_only_06_17_26"
RANDOM_SEED = 20260620
MODEL_C_GRID = [0.10, 0.30, 1.00, 3.00]
BUDGETS_PER_MINUTE = [0.50, 0.75, 1.00, 1.25, 1.50, 2.00]
SPACING_SECONDS = [2.5, 3.5, 5.0]
SEGMENT_CAPS = [1, 2]
THRESHOLD_QUANTILES = [0.50, 0.65, 0.80, 0.90, 0.95]
POSITIVE_FAMILIES = {"ding", "success"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, default=json_default) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    with Path(path).open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, default=json_default) + "\n")


def json_default(value):
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    return str(value)


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def load_moments(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row["projectId"] in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
                raise SystemExit(f"Prohibited project appears in moments: {row['projectId']}")
            rows.append(row)
    return rows


def load_corpus(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            project_id = row["project"]["projectId"]
            if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
                raise SystemExit(f"Prohibited project appears in corpus: {project_id}")
            rows.append(row)
    return rows


def normalize_family(value):
    family = str(value or "").strip().lower()
    if family.startswith("manual:"):
        family = family.split(":", 1)[1]
    return "".join(ch if ch.isalnum() else "_" for ch in family).strip("_")


def median(values):
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return 0.0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2


def cluster_manual_beats(events):
    normalized = []
    for event in events or []:
        if event.get("isAutomation"):
            continue
        family = normalize_family(event.get("family"))
        time = safe_float(event.get("audibleStartSeconds"), None)
        if family and time is not None:
            normalized.append({"family": family, "time": time})
    normalized.sort(key=lambda item: item["time"])
    beats = []
    for event in normalized:
        if not beats:
            beats.append([event])
            continue
        if abs(event["time"] - median(item["time"] for item in beats[-1])) <= 0.300:
            beats[-1].append(event)
        else:
            beats.append([event])
    out = []
    for beat in beats:
        families = sorted({event["family"] for event in beat})
        out.append({"time": median(event["time"] for event in beat), "families": families})
    return out


def manual_positive_counts(corpus_rows):
    counts = Counter()
    durations = {}
    for row in corpus_rows:
        if not row.get("trainEligible"):
            continue
        project_id = row["project"]["projectId"]
        durations[project_id] = safe_float(row["project"].get("durationSec"))
        for beat in cluster_manual_beats(row.get("manualEvents") or []):
            if set(beat["families"]) & POSITIVE_FAMILIES:
                counts[project_id] += 1
    return counts, durations


def usable_moments(moments):
    return [moment for moment in moments if moment["label"]["kind"] in {"positive", "hard_other", "clean_negative"}]


def label_value(moment):
    return 1 if moment["label"]["kind"] == "positive" else 0


def text_for(moment):
    return moment.get("context", {}).get("markedText") or ""


def numeric_features(moment):
    timing = moment.get("timingFeatures") or {}
    zoom = moment.get("zoomFeatures") or {}
    target = safe_float(moment.get("targetSec"))
    dense = {}
    options = moment.get("candidateOptions") or []
    dense["candidateOptionCount"] = len(options)
    dense["representativeBoundaryStrength"] = safe_float(timing.get("representativeBoundaryStrength"))
    dense["zoomMarkerCount"] = len(zoom.get("zoomMarkerIds") or [])
    dense["targetMinute"] = target / 60.0
    anchor_counts = Counter(anchor for option in options for anchor in option.get("anchorTypes", []))
    for anchor in [
        "final_word_end", "cue_end_minus_80ms", "pause_boundary",
        "speaker_turn_start", "cue_start", "zoom_onset", "internal_pause_word_end",
    ]:
        dense[f"anchor:{anchor}"] = anchor_counts[anchor]
    return dense


def fit_model(train_moments, c_value):
    positives = [moment for moment in train_moments if label_value(moment) == 1]
    hard = [moment for moment in train_moments if moment["label"]["kind"] == "hard_other"]
    clean = [moment for moment in train_moments if moment["label"]["kind"] == "clean_negative"]
    rng = random.Random(RANDOM_SEED)
    max_clean = max(400, 4 * len(positives))
    if len(clean) > max_clean:
        clean = rng.sample(clean, max_clean)
    rows = positives + hard + clean
    vectorizer = TfidfVectorizer(
        lowercase=True,
        ngram_range=(1, 2),
        min_df=3,
        max_features=12000,
        token_pattern=r"(?u)\b[a-zA-Z0-9][a-zA-Z0-9']+\b",
    )
    x_text = vectorizer.fit_transform([text_for(moment) for moment in rows])
    dense_names = sorted({key for moment in rows for key in numeric_features(moment)})
    x_dense, mean, scale = dense_matrix(rows, dense_names)
    x = sparse.hstack([x_text, x_dense], format="csr")
    y = np.array([label_value(moment) for moment in rows], dtype=np.int64)
    clf = LogisticRegression(C=c_value, solver="liblinear", max_iter=1000, class_weight="balanced", random_state=RANDOM_SEED)
    clf.fit(x, y)
    return {"vectorizer": vectorizer, "denseNames": dense_names, "mean": mean, "scale": scale, "clf": clf, "c": c_value}


def dense_matrix(moments, dense_names, mean=None, scale=None):
    values = np.zeros((len(moments), len(dense_names)), dtype=np.float64)
    for row, moment in enumerate(moments):
        features = numeric_features(moment)
        for col, name in enumerate(dense_names):
            values[row, col] = safe_float(features.get(name))
    if mean is None:
        mean = values.mean(axis=0) if len(values) else np.zeros(len(dense_names))
        scale = values.std(axis=0) if len(values) else np.ones(len(dense_names))
        scale = np.where(scale < 1e-6, 1.0, scale)
    return sparse.csr_matrix((values - mean) / scale), mean, scale


def predict(model, moments, fold_id="", choice_hash=""):
    if not moments:
        return []
    x_text = model["vectorizer"].transform([text_for(moment) for moment in moments])
    x_dense, _mean, _scale = dense_matrix(moments, model["denseNames"], model["mean"], model["scale"])
    x = sparse.hstack([x_text, x_dense], format="csr")
    probs = model["clf"].predict_proba(x)[:, 1]
    out = []
    for index, moment in enumerate(moments):
        out.append({
            "foldId": fold_id,
            "choiceHash": choice_hash,
            "projectId": moment["projectId"],
            "generalizationGroupId": moment["generalizationGroupId"],
            "segmentId": moment["segmentId"],
            "momentId": moment["momentId"],
            "beatGroupId": moment["beatGroupId"],
            "targetSec": safe_float(moment["targetSec"]),
            "score": float(probs[index]),
            "labelKind": moment["label"]["kind"],
            "labelFamilies": moment["label"].get("manualFamilies") or [],
            "labelSubtype": moment["label"].get("subtype"),
            "text": text_for(moment),
            "candidateOptions": moment.get("candidateOptions") or [],
        })
    return out


def decode(predictions, policy, durations):
    threshold = safe_float(policy["threshold"])
    spacing = safe_float(policy["minimumSpacingSeconds"])
    segment_cap = int(policy["segmentMax"])
    items = [row for row in predictions if row["score"] >= threshold]
    items.sort(key=lambda row: (-row["score"], row["targetSec"], row["momentId"]))
    selected = []
    per_project_counts = Counter()
    per_segment_counts = Counter()
    for row in items:
        project_id = row["projectId"]
        cap = math.ceil(max(0.1, durations.get(project_id, 0) / 60.0) * safe_float(policy["budgetPerMinute"]))
        if per_project_counts[project_id] >= cap:
            continue
        if per_segment_counts[row["segmentId"]] >= segment_cap:
            continue
        if any(existing["projectId"] == project_id and abs(existing["targetSec"] - row["targetSec"]) < spacing for existing in selected):
            continue
        selected.append(row)
        per_project_counts[project_id] += 1
        per_segment_counts[row["segmentId"]] += 1
    return sorted(selected, key=lambda row: (row["projectId"], row["targetSec"], row["momentId"]))


def score_selected(selected, manual_counts, durations):
    by_project = defaultdict(list)
    for row in selected:
        by_project[row["projectId"]].append(row)
    manual_total = sum(manual_counts.values())
    matched = sum(1 for row in selected if row["labelKind"] == "positive")
    generated = len(selected)
    false_additions = generated - matched
    duration_minutes = sum(durations.get(project_id, 0) for project_id in manual_counts) / 60.0
    project_rows = []
    positive_net_projects = 0
    coverages = []
    for project_id, manual in sorted(manual_counts.items()):
        rows = by_project.get(project_id, [])
        project_matched = sum(1 for row in rows if row["labelKind"] == "positive")
        project_generated = len(rows)
        project_false = project_generated - project_matched
        net = project_matched - project_false
        coverage = project_matched / manual if manual else None
        if coverage is not None:
            coverages.append(coverage)
        if net > 0:
            positive_net_projects += 1
        project_rows.append({
            "projectId": project_id,
            "manualPositive": manual,
            "generated": project_generated,
            "combinedMatched": project_matched,
            "combinedCoverage": coverage,
            "precision": project_matched / project_generated if project_generated else None,
            "falseAdditions": project_false,
            "netSavedEdits": net,
        })
    return {
        "manualPositive": manual_total,
        "generated": generated,
        "combinedMatched": matched,
        "combinedCoverage": matched / manual_total if manual_total else None,
        "precision": matched / generated if generated else None,
        "falseAdditions": false_additions,
        "falseAdditionsPerMinute": false_additions / duration_minutes if duration_minutes else None,
        "netSavedEdits": matched - false_additions,
        "netSavedEditFraction": (matched - false_additions) / manual_total if manual_total else None,
        "medianProjectCoverage": float(np.median(coverages)) if coverages else None,
        "p25ProjectCoverage": float(np.quantile(coverages, 0.25)) if coverages else None,
        "positiveNetProjectFraction": positive_net_projects / len(project_rows) if project_rows else None,
        "projectRows": project_rows,
    }


def inner_folds(train_project_ids, manifest_by_id):
    by_group = defaultdict(list)
    for project_id in train_project_ids:
        by_group[manifest_by_id[project_id]["generalizationGroupId"]].append(project_id)
    folds = []
    for index, group_id in enumerate(sorted(by_group)):
        test_ids = sorted(by_group[group_id])
        train_ids = sorted(project_id for project_id in train_project_ids if project_id not in test_ids)
        if train_ids:
            folds.append({"foldId": f"inner_{index + 1:02d}", "trainProjectIds": train_ids, "testProjectIds": test_ids})
    return folds


def policy_candidates(predictions):
    scores = [row["score"] for row in predictions]
    quantiles = [float(np.quantile(scores, q)) for q in THRESHOLD_QUANTILES] if scores else [1.0]
    thresholds = sorted(set([0.20, 0.35, 0.50, *quantiles]))
    for budget in BUDGETS_PER_MINUTE:
        for spacing in SPACING_SECONDS:
            for segment_cap in SEGMENT_CAPS:
                for threshold in thresholds:
                    yield {
                        "budgetPerMinute": budget,
                        "minimumSpacingSeconds": spacing,
                        "segmentMax": segment_cap,
                        "threshold": threshold,
                    }


def select_policy(predictions, manual_counts, durations):
    best = None
    for policy in policy_candidates(predictions):
        selected = decode(predictions, policy, durations)
        metrics = score_selected(selected, manual_counts, durations)
        score = (
            metrics["netSavedEdits"],
            metrics["combinedMatched"],
            metrics["precision"] if metrics["precision"] is not None else -1,
            -(metrics["falseAdditions"]),
            metrics["medianProjectCoverage"] if metrics["medianProjectCoverage"] is not None else -1,
            -policy["budgetPerMinute"],
        )
        item = {"policy": policy, "metrics": {key: value for key, value in metrics.items() if key != "projectRows"}, "score": score}
        if best is None or score > best["score"]:
            best = item
    return best


def write_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "manualPositive", "generated", "combinedMatched", "combinedCoverage", "precision", "falseAdditions", "netSavedEdits"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def report_markdown(report):
    m = report["metrics"]
    return "\n".join([
        "# Positive Accent Moment Ranker Validation",
        "",
        "This is a local moment-level selector baseline. It is product-scored by human placements found out of total human placements.",
        "",
        f"- Product score: {m['combinedMatched']}/{m['manualPositive']} human ding/success placements found",
        f"- Generated attempts: {m['generated']}",
        f"- Precision: {m['precision']}",
        f"- False additions: {m['falseAdditions']}",
        f"- False additions per minute: {m['falseAdditionsPerMinute']}",
        f"- Net saved edits: {m['netSavedEdits']}",
        f"- Median project coverage: {m['medianProjectCoverage']}",
        f"- Positive net project fraction: {m['positiveNetProjectFraction']}",
        "",
    ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--moments", default=str(EDITOR_ROOT / "data/sfx-automation-v2/positive-accent-moments.jsonl"))
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--project-manifest", default=str(EDITOR_ROOT / "validation/project-manifest-v1.json"))
    parser.add_argument("--outer-splits", default=str(EDITOR_ROOT / "validation/outer-splits-v1.json"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    moments = usable_moments(load_moments(args.moments))
    corpus_rows = load_corpus(args.corpus)
    manifest = read_json(args.project_manifest)
    splits = read_json(args.outer_splits)
    manifest_by_id = {project["projectId"]: project for project in manifest["projects"]}
    manual_counts, durations = manual_positive_counts(corpus_rows)
    by_project = defaultdict(list)
    for moment in moments:
        by_project[moment["projectId"]].append(moment)

    run_id = args.run_id or datetime.now(timezone.utc).strftime("positive-accent-moment-v1-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_predictions = []
    all_selected = []
    fold_choices = []
    project_rows = []
    model_cache = {}
    for outer in splits["folds"]:
        outer_train = [project_id for project_id in outer["trainProjectIds"] if project_id in by_project]
        outer_test = [project_id for project_id in outer["testProjectIds"] if project_id in by_project]
        best = None
        for c_value in MODEL_C_GRID:
            inner_predictions = []
            for inner in inner_folds(outer_train, manifest_by_id):
                key = (tuple(inner["trainProjectIds"]), c_value)
                if key not in model_cache:
                    train_rows = [moment for project_id in inner["trainProjectIds"] for moment in by_project[project_id]]
                    model_cache[key] = fit_model(train_rows, c_value)
                test_rows = [moment for project_id in inner["testProjectIds"] for moment in by_project[project_id]]
                inner_predictions.extend(predict(model_cache[key], test_rows, inner["foldId"]))
            inner_counts = Counter({project_id: manual_counts[project_id] for project_id in outer_train})
            inner_durations = {project_id: durations[project_id] for project_id in outer_train}
            selected = select_policy(inner_predictions, inner_counts, inner_durations)
            choice_score = (
                selected["metrics"]["netSavedEdits"],
                selected["metrics"]["combinedMatched"],
                selected["metrics"]["precision"] if selected["metrics"]["precision"] is not None else -1,
                selected["metrics"]["medianProjectCoverage"] if selected["metrics"]["medianProjectCoverage"] is not None else -1,
                -c_value,
            )
            if best is None or choice_score > best["choiceScore"]:
                best = {"c": c_value, "policy": selected["policy"], "innerMetrics": selected["metrics"], "choiceScore": choice_score}
        final_key = (tuple(outer_train), best["c"])
        if final_key not in model_cache:
            train_rows = [moment for project_id in outer_train for moment in by_project[project_id]]
            model_cache[final_key] = fit_model(train_rows, best["c"])
        test_rows = [moment for project_id in outer_test for moment in by_project[project_id]]
        predictions = predict(model_cache[final_key], test_rows, outer["foldId"])
        selected = decode(predictions, best["policy"], durations)
        outer_counts = Counter({project_id: manual_counts[project_id] for project_id in outer_test})
        outer_durations = {project_id: durations[project_id] for project_id in outer_test}
        outer_metrics = score_selected(selected, outer_counts, outer_durations)
        all_predictions.extend(predictions)
        all_selected.extend(selected)
        for row in outer_metrics["projectRows"]:
            project_rows.append({"foldId": outer["foldId"], **row})
        fold_choices.append({
            "foldId": outer["foldId"],
            "generalizationGroupId": outer["generalizationGroupId"],
            "trainProjectIds": outer_train,
            "testProjectIds": outer_test,
            "c": best["c"],
            "policy": best["policy"],
            "innerMetrics": best["innerMetrics"],
            "outerMetrics": {key: value for key, value in outer_metrics.items() if key != "projectRows"},
        })

    metrics = score_selected(all_selected, manual_counts, durations)
    report = {
        "protocol": "positive-accent-moment-ranker-nested-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "lockedFinalHoldout": HOLDOUT_ID,
        "openedBlindVideoExcluded": True,
        "metrics": {key: value for key, value in metrics.items() if key != "projectRows"},
        "foldChoices": fold_choices,
        "modelGrid": MODEL_C_GRID,
        "policyGrid": {
            "budgetsPerMinute": BUDGETS_PER_MINUTE,
            "spacingSeconds": SPACING_SECONDS,
            "segmentCaps": SEGMENT_CAPS,
            "thresholdQuantiles": THRESHOLD_QUANTILES,
        },
    }
    write_json(run_dir / "positive-accent-moment-validation-report.json", report)
    (run_dir / "positive-accent-moment-validation-report.md").write_text(report_markdown(report), encoding="utf-8")
    write_jsonl(run_dir / "positive-accent-moment-outer-predictions.jsonl", all_predictions)
    write_jsonl(run_dir / "positive-accent-moment-selected.jsonl", all_selected)
    write_project_csv(run_dir / "per-project-positive-accent-moment-metrics.csv", project_rows)
    print(json.dumps({
        "runDir": str(run_dir),
        "productScore": f"{metrics['combinedMatched']}/{metrics['manualPositive']}",
        "generated": metrics["generated"],
        "precision": metrics["precision"],
        "falseAdditions": metrics["falseAdditions"],
        "netSavedEdits": metrics["netSavedEdits"],
        "medianProjectCoverage": metrics["medianProjectCoverage"],
    }, indent=2))


if __name__ == "__main__":
    main()
