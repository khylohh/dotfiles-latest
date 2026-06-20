#!/usr/bin/env python3
import argparse
import csv
import hashlib
import importlib.util
import json
import math
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sklearn
from scipy.optimize import linear_sum_assignment
from scipy import sparse
from sklearn.linear_model import LogisticRegression


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
OPENED_BLIND_CAPTION_ID = "blind_caption_only_06_17_26"
POSITIVE_FAMILIES = {"ding", "success"}
ROUTE_FAMILIES = ["ding", "success"]
NON_AUTOMATION_FAMILIES = {
    "ding", "success", "bonk", "funny", "bruh", "record_scratch",
    "pop", "dramatic", "scare", "suspense", "swoosh",
}
RANDOM_SEED = 20260618
MODEL_CONFIGS = [
    {"id": "positive-accent-linear-c003", "accentC": 0.03, "routeC": 0.03},
    {"id": "positive-accent-linear-c010", "accentC": 0.10, "routeC": 0.10},
    {"id": "positive-accent-linear-c030", "accentC": 0.30, "routeC": 0.30},
]
POLICY_QUANTILES = [0.70, 0.80, 0.90, 0.95, 0.975, 0.99]

PROMOTION_FLOORS = {
    "detector": {"precision": 0.75, "wilson": 0.60, "min_predictions": 40, "min_groups": 6},
    "materialized": {"precision": 0.80, "wilson": 0.65, "min_predictions": 40, "min_groups": 6},
    "ding": {"precision": 0.75, "wilson": 0.60, "min_predictions": 30, "min_groups": 6},
    "success": {"precision": 0.75, "wilson": 0.60, "min_predictions": 25, "min_groups": 6},
}


def load_trainer():
    path = EDITOR_ROOT / "scripts/sfx/train-caption-beat-model.py"
    spec = importlib.util.spec_from_file_location("caption_trainer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trainer = load_trainer()


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, default=json_default) + "\n", encoding="utf-8")


def json_default(value):
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    return str(value)


def write_jsonl(path, rows):
    with Path(path).open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, default=json_default) + "\n")


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sha256_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=json_default).encode()).hexdigest()


def load_corpus(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            project_id = row["project"]["projectId"]
            if project_id == HOLDOUT_ID or project_id == OPENED_BLIND_CAPTION_ID:
                raise SystemExit(f"Refusing validation because prohibited project appears in corpus: {project_id}")
            rows.append(row)
    return rows


def category_family(value):
    family = str(value or "").strip().lower()
    if family.startswith("manual:"):
        family = family.split(":", 1)[1]
    family = re.sub(r"[^a-z0-9]+", "_", family).strip("_")
    return family


def cluster_manual_beats_all(events):
    normalized = []
    for event in events:
        if event.get("isAutomation"):
            continue
        family = category_family(event.get("family"))
        if not family:
            continue
        normalized.append({**event, "family": family, "time": safe_float(event.get("audibleStartSeconds"))})
    normalized.sort(key=lambda item: item["time"])
    beats = []
    for event in normalized:
        if not beats:
            beats.append({"events": [event]})
            continue
        median = float(np.median([item["time"] for item in beats[-1]["events"]]))
        if abs(event["time"] - median) <= 0.300:
            beats[-1]["events"].append(event)
        else:
            beats.append({"events": [event]})
    for index, beat in enumerate(beats):
        times = [event["time"] for event in beat["events"]]
        families = sorted(set(event["family"] for event in beat["events"]))
        beat["id"] = f"manual_beat_{index + 1}"
        beat["time"] = float(np.median(times))
        beat["families"] = families
        beat["positiveAccent"] = bool(POSITIVE_FAMILIES & set(families))
        if set(families) == {"ding"}:
            beat["subtype"] = "ding"
        elif set(families) == {"success"}:
            beat["subtype"] = "success"
        else:
            beat["subtype"] = None
    return beats


def assign_positive_accent_labels(row):
    candidates = row["candidates"]
    all_beats = cluster_manual_beats_all(row["manualEvents"])
    positive_beats = [beat for beat in all_beats if beat["positiveAccent"]]
    hard_other_beats = [beat for beat in all_beats if not beat["positiveAccent"] and beat["families"]]
    labels = {
        candidate["id"]: {
            "emit": None,
            "labelKind": "unlabeled",
            "families": [],
            "manualFamilies": [],
            "positiveAccent": None,
            "subtype": None,
            "hardOtherSfxNegative": False,
            "delta": None,
        }
        for candidate in candidates
    }
    audit = []
    if not all_beats:
        for candidate in candidates:
            labels[candidate["id"]].update({"emit": 0, "labelKind": "clean_negative", "positiveAccent": False})
        return labels, audit, all_beats, positive_beats, hard_other_beats

    candidate_by_id = {candidate["id"]: candidate for candidate in candidates}
    bag_candidate_ids = sorted({
        candidate["id"]
        for beat in all_beats
        for candidate in candidates
        if abs(safe_float(candidate["targetSec"]) - beat["time"]) <= 0.750
    })
    col_candidates = [candidate_by_id[candidate_id] for candidate_id in bag_candidate_ids]
    n_beats = len(all_beats)
    n_cols = len(col_candidates) + n_beats
    cost = np.full((n_beats, n_cols), 999.0, dtype=np.float64)
    for row_idx, beat in enumerate(all_beats):
        for col_idx, candidate in enumerate(col_candidates):
            if abs(safe_float(candidate["targetSec"]) - beat["time"]) <= 0.750:
                cost[row_idx, col_idx] = trainer.assignment_cost(candidate, beat)
        cost[row_idx, len(col_candidates) + row_idx] = 0.66

    row_ind, col_ind = linear_sum_assignment(cost)
    assigned_or_weak_groups = set()
    for row_idx, col_idx in zip(row_ind, col_ind):
        beat = all_beats[row_idx]
        if col_idx >= len(col_candidates) or cost[row_idx, col_idx] >= 900:
            audit.append({
                "projectId": row["project"]["projectId"],
                "beatId": beat["id"],
                "kind": "caption_unobservable",
                "time": beat["time"],
                "families": beat["families"],
                "positiveAccent": beat["positiveAccent"],
            })
            continue
        candidate = col_candidates[col_idx]
        delta = safe_float(candidate["targetSec"]) - beat["time"]
        distinct_costs = sorted(
            trainer.assignment_cost(other, beat)
            for other in col_candidates
            if other["id"] != candidate["id"]
            and other.get("beatGroupId") != candidate.get("beatGroupId")
            and abs(safe_float(other["targetSec"]) - beat["time"]) <= 0.750
        )
        margin = (distinct_costs[0] - cost[row_idx, col_idx]) if distinct_costs else 999.0
        strong = abs(delta) <= 0.500 and cost[row_idx, col_idx] <= 0.550 and margin >= 0.100
        weak = abs(delta) <= 0.750 and cost[row_idx, col_idx] <= 0.750
        family_set = set(beat["families"])
        if strong:
            kind = "strong_positive_accent" if beat["positiveAccent"] else "hard_other_sfx_negative"
            labels[candidate["id"]].update({
                "emit": 1,
                "families": beat["families"],
                "manualFamilies": beat["families"],
                "labelKind": kind,
                "positiveAccent": beat["positiveAccent"],
                "subtype": beat["subtype"],
                "hardOtherSfxNegative": not beat["positiveAccent"],
                "delta": delta,
                "assignmentCost": float(cost[row_idx, col_idx]),
                "assignmentMargin": margin,
            })
            assigned_or_weak_groups.add(candidate.get("beatGroupId"))
        elif weak:
            kind = "weak_ambiguous"
            labels[candidate["id"]].update({
                "labelKind": kind,
                "families": beat["families"],
                "manualFamilies": beat["families"],
                "delta": delta,
                "assignmentCost": float(cost[row_idx, col_idx]),
                "assignmentMargin": margin,
            })
            assigned_or_weak_groups.add(candidate.get("beatGroupId"))
        else:
            kind = "caption_unobservable"
        audit.append({
            "projectId": row["project"]["projectId"],
            "beatId": beat["id"],
            "kind": kind,
            "time": beat["time"],
            "families": beat["families"],
            "positiveAccent": beat["positiveAccent"],
            "candidateId": candidate["id"],
            "delta": delta,
            "cost": float(cost[row_idx, col_idx]),
            "margin": margin,
            "candidatePositiveAccent": labels[candidate["id"]]["positiveAccent"],
        })

    beat_times = [beat["time"] for beat in all_beats]
    for candidate in candidates:
        label = labels[candidate["id"]]
        if label["labelKind"] != "unlabeled":
            continue
        nearest = min([abs(safe_float(candidate["targetSec"]) - time) for time in beat_times], default=999)
        if candidate.get("beatGroupId") in assigned_or_weak_groups:
            label["labelKind"] = "near_beat_ignored"
        elif nearest > 1.250:
            label.update({"emit": 0, "labelKind": "clean_negative", "positiveAccent": False})
        else:
            label["labelKind"] = "dead_zone_ignored"
    return labels, audit, all_beats, positive_beats, hard_other_beats


def build_stores(rows):
    inputs = {}
    labels = {}
    manual_beats = {}
    label_summary = Counter()
    audits = []
    for row in rows:
        if not row.get("trainEligible"):
            continue
        project_id = row["project"]["projectId"]
        project_labels, audit, all_beats, positive_beats, hard_other_beats = assign_positive_accent_labels(row)
        audits.extend(audit)
        inputs[project_id] = {
            "projectId": project_id,
            "durationSec": row["project"]["durationSec"],
            "candidates": [],
        }
        labels[project_id] = {}
        manual_beats[project_id] = [
            {
                "projectId": project_id,
                "beatId": beat["id"],
                "time": beat["time"],
                "families": beat["families"],
                "positiveAccent": beat["positiveAccent"],
                "subtype": beat["subtype"],
            }
            for beat in all_beats
        ]
        label_summary["manual_beats"] += len(all_beats)
        label_summary["positive_beats"] += len(positive_beats)
        label_summary["hard_other_sfx_beats"] += len(hard_other_beats)
        for beat in all_beats:
            family_set = set(beat["families"])
            for family in family_set:
                label_summary[f"manual_family_{family}"] += 1
            if family_set == {"ding"}:
                label_summary["ding_only_beats"] += 1
            elif family_set == {"success"}:
                label_summary["success_only_beats"] += 1
            elif family_set == {"ding", "success"}:
                label_summary["ding_success_beats"] += 1
            elif beat["positiveAccent"]:
                label_summary["positive_with_other_beats"] += 1
        for candidate in row["candidates"]:
            item = {
                "projectId": project_id,
                "candidateId": candidate["id"],
                "targetSec": safe_float(candidate["targetSec"]),
                "targetFrame": int(candidate.get("targetFrame") or 0),
                "beatGroupId": candidate.get("beatGroupId") or candidate["id"],
                "cueIds": candidate.get("cueIds") or [],
                "anchorTypes": candidate.get("anchorTypes") or [],
                "text": candidate.get("text") or "",
                "dense": candidate["denseFeatures"],
                "lexical": candidate["lexicalTokens"],
            }
            inputs[project_id]["candidates"].append(item)
            labels[project_id][candidate["id"]] = project_labels[candidate["id"]]
            label_summary[f"candidate_{project_labels[candidate['id']]['labelKind']}"] += 1
            if project_labels[candidate["id"]]["positiveAccent"] is True:
                label_summary["candidate_positive_accent"] += 1
            elif project_labels[candidate["id"]]["positiveAccent"] is False:
                label_summary["candidate_not_positive_accent"] += 1
            if project_labels[candidate["id"]]["hardOtherSfxNegative"]:
                label_summary["candidate_hard_other_sfx_negative"] += 1
    return inputs, labels, manual_beats, label_summary, audits


def examples_for(project_inputs, project_labels, project_ids, include_labels=True):
    examples = []
    for project_id in sorted(project_ids):
        for candidate in project_inputs[project_id]["candidates"]:
            example = dict(candidate)
            if include_labels:
                example.update(project_labels[project_id][candidate["candidateId"]])
            examples.append(example)
    return examples


def vocabulary_for(examples):
    counts = Counter()
    project_df = defaultdict(set)
    for example in examples:
        for token in set(example["lexical"]):
            counts[token] += 1
            project_df[token].add(example["projectId"])
    return sorted(token for token, count in counts.items() if count >= 10 and len(project_df[token]) >= 3)


def matrix(examples, dense_names, vocab, mean=None, scale=None):
    dense = np.zeros((len(examples), len(dense_names)), dtype=np.float64)
    vocab_index = {token: index for index, token in enumerate(vocab)}
    rows, cols, data = [], [], []
    for row_index, example in enumerate(examples):
        for col_index, name in enumerate(dense_names):
            dense[row_index, col_index] = safe_float(example["dense"].get(name))
        for token in set(example["lexical"]):
            col = vocab_index.get(token)
            if col is not None:
                rows.append(row_index)
                cols.append(col)
                data.append(0.35)
    if mean is None:
        mean = dense.mean(axis=0) if len(examples) else np.zeros(len(dense_names))
        scale = dense.std(axis=0) if len(examples) else np.ones(len(dense_names))
        scale = np.where(scale < 1e-6, 1.0, scale)
    dense = (dense - mean) / scale
    lexical = sparse.csr_matrix((data, (rows, cols)), shape=(len(examples), len(vocab)), dtype=np.float64)
    return sparse.hstack([sparse.csr_matrix(dense), lexical], format="csr"), mean, scale


def fit_positive_accent_model(project_inputs, project_labels, project_ids, config):
    examples = examples_for(project_inputs, project_labels, project_ids, include_labels=True)
    accent_rows = [example for example in examples if example["positiveAccent"] is not None]
    positives = [example for example in accent_rows if example["positiveAccent"] is True]
    negatives = [example for example in accent_rows if example["positiveAccent"] is False]
    rng = random.Random(RANDOM_SEED)
    max_negatives = max(300, 6 * len(positives))
    if len(negatives) > max_negatives:
        negatives = rng.sample(negatives, max_negatives)
    accent_train = positives + negatives
    dense_names = sorted({key for example in accent_train for key in example["dense"].keys()})
    vocab = vocabulary_for(accent_train)
    x_accent, mean, scale = matrix(accent_train, dense_names, vocab)
    y_accent = np.array([1 if example["positiveAccent"] else 0 for example in accent_train], dtype=np.int64)
    accent_clf = LogisticRegression(C=safe_float(config["accentC"]), solver="liblinear", max_iter=1000, random_state=RANDOM_SEED)
    accent_clf.fit(x_accent, y_accent)

    route_rows = [example for example in positives if example.get("subtype") in ROUTE_FAMILIES]
    route_clf = None
    if len(set(example["subtype"] for example in route_rows)) >= 2:
        x_route, _, _ = matrix(route_rows, dense_names, vocab, mean, scale)
        y_route = np.array([ROUTE_FAMILIES.index(example["subtype"]) for example in route_rows], dtype=np.int64)
        route_clf = LogisticRegression(C=safe_float(config["routeC"]), solver="liblinear", max_iter=1000, random_state=RANDOM_SEED)
        route_clf.fit(x_route, y_route)
    return {
        "config": config,
        "denseNames": dense_names,
        "vocab": vocab,
        "mean": mean,
        "scale": scale,
        "accent": accent_clf,
        "route": route_clf,
    }


def predict_positive_accent(model, project_inputs, project_ids, fold_id="", choice_hash=""):
    examples = examples_for(project_inputs, {}, project_ids, include_labels=False)
    x, _, _ = matrix(examples, model["denseNames"], model["vocab"], model["mean"], model["scale"])
    accent_p = model["accent"].predict_proba(x)[:, 1]
    route_p = np.zeros((len(examples), len(ROUTE_FAMILIES)), dtype=np.float64) + 0.5
    if model["route"] is not None:
        pred = model["route"].predict_proba(x)
        route_p[:] = 1e-9
        for pos, cls in enumerate(model["route"].classes_):
            route_p[:, int(cls)] = pred[:, pos]
        route_p /= route_p.sum(axis=1, keepdims=True)
    out = []
    for index, example in enumerate(examples):
        ding_p = float(route_p[index, ROUTE_FAMILIES.index("ding")])
        success_p = float(route_p[index, ROUTE_FAMILIES.index("success")])
        predicted_family = "ding" if ding_p >= success_p else "success"
        out.append({
            "foldId": fold_id,
            "choiceHash": choice_hash,
            "projectId": example["projectId"],
            "candidateId": example["candidateId"],
            "targetSec": example["targetSec"],
            "targetFrame": example["targetFrame"],
            "beatGroupId": example["beatGroupId"],
            "cueIds": example.get("cueIds") or [],
            "anchorTypes": example.get("anchorTypes") or [],
            "text": example.get("text") or "",
            "positiveAccentP": float(accent_p[index]),
            "subtypeP": {"ding": ding_p, "success": success_p},
            "predictedSubtype": predicted_family,
            "subtypeMargin": abs(ding_p - success_p),
        })
    return out


def wilson_lower(matches, total, z=1.28155):
    if total <= 0:
        return None
    p = matches / total
    denom = 1 + z * z / total
    centre = p + z * z / (2 * total)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return (centre - spread) / denom


def max_count(duration_sec, max_per_minute):
    return max(0, math.ceil(max(0.1, duration_sec / 60.0) * safe_float(max_per_minute)))


def decode_positive_detector(predictions, policy, duration_by_project):
    items = []
    for prediction in predictions:
        if prediction["positiveAccentP"] < safe_float(policy["accentThreshold"]):
            continue
        ding_p = safe_float(prediction["subtypeP"]["ding"])
        success_p = safe_float(prediction["subtypeP"]["success"])
        family = "ding" if ding_p >= success_p else "success"
        items.append({**prediction, "family": family, "routeP": max(ding_p, success_p)})
    items.sort(key=lambda item: (-item["positiveAccentP"], -item["routeP"], item["targetSec"], item["candidateId"]))
    selected = []
    per_project_counts = Counter()
    for item in items:
        project_id = item["projectId"]
        cap = max_count(duration_by_project[project_id], policy["maxPerMinute"])
        if per_project_counts[project_id] >= cap:
            continue
        if any(existing["projectId"] == project_id and existing["beatGroupId"] == item["beatGroupId"] for existing in selected):
            continue
        if any(existing["projectId"] == project_id and abs(existing["targetSec"] - item["targetSec"]) < safe_float(policy["cooldownSeconds"]) for existing in selected):
            continue
        selected.append({
            "foldId": item.get("foldId", ""),
            "choiceHash": item.get("choiceHash", ""),
            "projectId": project_id,
            "candidateId": item["candidateId"],
            "targetSec": item["targetSec"],
            "targetFrame": item.get("targetFrame", 0),
            "beatGroupId": item["beatGroupId"],
            "text": item.get("text", ""),
            "anchorTypes": item.get("anchorTypes") or [],
            "family": item["family"],
            "positiveAccentP": item["positiveAccentP"],
            "subtypeP": item["subtypeP"],
            "subtypeMargin": item["subtypeMargin"],
            "policy": policy,
            "detectorOnly": True,
        })
        per_project_counts[project_id] += 1
    return sorted(selected, key=lambda item: (item["projectId"], item["targetSec"], item["candidateId"]))


def decode_positive_accent(predictions, policy, duration_by_project):
    items = []
    for prediction in predictions:
        if prediction["positiveAccentP"] < safe_float(policy["accentThreshold"]):
            continue
        ding_p = safe_float(prediction["subtypeP"]["ding"])
        success_p = safe_float(prediction["subtypeP"]["success"])
        family = "ding" if ding_p >= success_p else "success"
        if family == "ding":
            if not policy.get("dingEnabled"):
                continue
            if ding_p < safe_float(policy["dingThreshold"]):
                continue
            if ding_p - success_p < safe_float(policy["subtypeMargin"]):
                continue
        else:
            if not policy.get("successEnabled"):
                continue
            if success_p < safe_float(policy["successThreshold"]):
                continue
            if success_p - ding_p < safe_float(policy["subtypeMargin"]):
                continue
        items.append({**prediction, "family": family, "routeP": ding_p if family == "ding" else success_p})
    items.sort(key=lambda item: (-item["positiveAccentP"], -item["routeP"], item["targetSec"], item["candidateId"]))
    selected = []
    per_project_counts = Counter()
    for item in items:
        project_id = item["projectId"]
        cap = max_count(duration_by_project[project_id], policy["maxPerMinute"])
        if per_project_counts[project_id] >= cap:
            continue
        if any(existing["projectId"] == project_id and existing["beatGroupId"] == item["beatGroupId"] for existing in selected):
            continue
        if any(existing["projectId"] == project_id and abs(existing["targetSec"] - item["targetSec"]) < safe_float(policy["cooldownSeconds"]) for existing in selected):
            continue
        selected.append({
            "foldId": item.get("foldId", ""),
            "choiceHash": item.get("choiceHash", ""),
            "projectId": project_id,
            "candidateId": item["candidateId"],
            "targetSec": item["targetSec"],
            "targetFrame": item.get("targetFrame", 0),
            "beatGroupId": item["beatGroupId"],
            "text": item.get("text", ""),
            "anchorTypes": item.get("anchorTypes") or [],
            "family": item["family"],
            "positiveAccentP": item["positiveAccentP"],
            "subtypeP": item["subtypeP"],
            "subtypeMargin": item["subtypeMargin"],
            "policy": policy,
        })
        per_project_counts[project_id] += 1
    return sorted(selected, key=lambda item: (item["projectId"], item["targetSec"], item["candidateId"]))


def manual_for(manual_beats, project_ids):
    return [beat for project_id in sorted(project_ids) for beat in manual_beats[project_id]]


def match_emissions_to_manual_beats(emissions, manual_beats, tolerance=0.75):
    beats_by_project = defaultdict(list)
    for manual_index, beat in enumerate(manual_beats):
        beats_by_project[beat["projectId"]].append((manual_index, beat))
    possible = []
    for emission_index, emission in enumerate(emissions):
        for manual_index, beat in beats_by_project.get(emission["projectId"], []):
            delta = emission["targetSec"] - beat["time"]
            if abs(delta) <= tolerance:
                possible.append((abs(delta), delta, emission_index, manual_index))
    possible.sort()
    used_emissions, used_manuals = set(), set()
    matches = []
    for _abs_delta, delta, emission_index, manual_index in possible:
        if emission_index in used_emissions or manual_index in used_manuals:
            continue
        used_emissions.add(emission_index)
        used_manuals.add(manual_index)
        matches.append({
            "emission": emissions[emission_index],
            "manualBeat": manual_beats[manual_index],
            "delta": delta,
        })
    return matches


def metric_for(emissions, manual_beats, family=None):
    if family:
        scoped_emissions = [emission for emission in emissions if emission["family"] == family]
        scoped_manuals = [beat for beat in manual_beats if family in beat["families"]]
    else:
        scoped_emissions = list(emissions)
        scoped_manuals = [beat for beat in manual_beats if beat["positiveAccent"]]
    matches = match_emissions_to_manual_beats(scoped_emissions, scoped_manuals)
    exact = 0
    cross_positive = 0
    combined = 0
    for match in matches:
        predicted = match["emission"]["family"]
        families = set(match["manualBeat"]["families"])
        if predicted in families:
            exact += 1
        if families & POSITIVE_FAMILIES:
            combined += 1
            if predicted not in families:
                cross_positive += 1
    generated = len(scoped_emissions)
    manual_count = len(scoped_manuals)
    return {
        "exactMatched": exact,
        "combinedMatched": combined,
        "crossPositiveMatched": cross_positive,
        "generated": generated,
        "manual": manual_count,
        "exactPrecision": exact / generated if generated else None,
        "combinedPrecision": combined / generated if generated else None,
        "exactWilsonLower90": wilson_lower(exact, generated),
        "combinedWilsonLower90": wilson_lower(combined, generated),
        "recall": exact / manual_count if manual_count else None,
        "groups": len(set(emission.get("generalizationGroupId", emission["projectId"]) for emission in scoped_emissions)),
    }


def confusion_matrix(emissions, manual_beats):
    columns = ["ding", "success", "ding+success", "bonk", "pop", "dramatic", "other", "none"]
    matrix = {family: Counter() for family in ROUTE_FAMILIES}
    matches = match_emissions_to_manual_beats(emissions, manual_beats)
    matched_ids = set()
    for match in matches:
        emission = match["emission"]
        matched_ids.add(emission["candidateId"])
        families = set(match["manualBeat"]["families"])
        if "ding" in families and "success" in families:
            column = "ding+success"
        elif "ding" in families:
            column = "ding"
        elif "success" in families:
            column = "success"
        elif "bonk" in families:
            column = "bonk"
        elif "pop" in families:
            column = "pop"
        elif "dramatic" in families:
            column = "dramatic"
        else:
            column = "other"
        matrix[emission["family"]][column] += 1
    for emission in emissions:
        if emission["candidateId"] not in matched_ids:
            matrix[emission["family"]]["none"] += 1
    return matrix, columns, matches


def groups_for_projects(project_ids, manifest_by_id):
    return sorted(set(manifest_by_id[project_id]["generalizationGroupId"] for project_id in project_ids))


def passes_detector(metric):
    floor = PROMOTION_FLOORS["detector"]
    return (
        metric["generated"] >= floor["min_predictions"]
        and metric["groups"] >= floor["min_groups"]
        and metric["combinedPrecision"] is not None
        and metric["combinedPrecision"] >= floor["precision"]
        and metric["combinedWilsonLower90"] is not None
        and metric["combinedWilsonLower90"] >= floor["wilson"]
    )


def passes_materialized(metric):
    floor = PROMOTION_FLOORS["materialized"]
    return (
        metric["generated"] >= floor["min_predictions"]
        and metric["groups"] >= floor["min_groups"]
        and metric["combinedPrecision"] is not None
        and metric["combinedPrecision"] >= floor["precision"]
        and metric["combinedWilsonLower90"] is not None
        and metric["combinedWilsonLower90"] >= floor["wilson"]
    )


def passes_route(metric, family):
    floor = PROMOTION_FLOORS[family]
    return (
        metric["generated"] >= floor["min_predictions"]
        and metric["groups"] >= floor["min_groups"]
        and metric["exactPrecision"] is not None
        and metric["exactPrecision"] >= floor["precision"]
        and metric["exactWilsonLower90"] is not None
        and metric["exactWilsonLower90"] >= floor["wilson"]
    )


def select_policy(predictions, manual_beats, duration_by_project, manifest_by_id):
    thresholds = sorted(set([0.5, 0.6, 0.7, 0.8, 0.9, *[float(np.quantile([p["positiveAccentP"] for p in predictions], q)) for q in POLICY_QUANTILES]]))
    ding_thresholds = [0.50, 0.60, 0.70]
    success_thresholds = [0.50, 0.60, 0.70]
    margins = [0.00, 0.10, 0.20]
    candidates = []
    for accent_threshold in thresholds:
        threshold_predictions = [prediction for prediction in predictions if prediction["positiveAccentP"] >= accent_threshold]
        detector_policy = {
            "accentThreshold": accent_threshold,
            "cooldownSeconds": 5,
            "maxPerMinute": 0.35,
        }
        detector_emissions = decode_positive_detector(threshold_predictions, detector_policy, duration_by_project)
        for emission in detector_emissions:
            emission["generalizationGroupId"] = manifest_by_id[emission["projectId"]]["generalizationGroupId"]
        detector_metric = metric_for(detector_emissions, manual_beats)
        detector_ok = passes_detector(detector_metric)
        for ding_threshold in ding_thresholds:
            for success_threshold in success_thresholds:
                for margin in margins:
                    for route_mode in ["both", "ding", "success"]:
                        policy = {
                            "accentThreshold": accent_threshold,
                            "dingThreshold": ding_threshold,
                            "successThreshold": success_threshold,
                            "subtypeMargin": margin,
                            "cooldownSeconds": 5,
                            "maxPerMinute": 0.35,
                            "dingEnabled": route_mode in ("both", "ding"),
                            "successEnabled": route_mode in ("both", "success"),
                        }
                        emissions = decode_positive_accent(threshold_predictions, policy, duration_by_project)
                        for emission in emissions:
                            emission["generalizationGroupId"] = manifest_by_id[emission["projectId"]]["generalizationGroupId"]
                        materialized_metric = metric_for(emissions, manual_beats)
                        ding_metric = metric_for(emissions, manual_beats, "ding")
                        success_metric = metric_for(emissions, manual_beats, "success")
                        materialized_ok = passes_materialized(materialized_metric)
                        ding_ok = passes_route(ding_metric, "ding")
                        success_ok = passes_route(success_metric, "success")
                        candidates.append({
                            "policy": policy,
                            "detectorMetric": detector_metric,
                            "materializedMetric": materialized_metric,
                            "combinedMetric": materialized_metric,
                            "dingMetric": ding_metric,
                            "successMetric": success_metric,
                            "detectorQualified": detector_ok,
                            "materializedQualified": materialized_ok,
                            "dingQualified": ding_ok,
                            "successQualified": success_ok,
                        })
    passing = [item for item in candidates if item["detectorQualified"] and item["materializedQualified"] and (item["dingQualified"] or item["successQualified"])]
    if passing:
        selected = sorted(passing, key=policy_sort_key)[0]
    else:
        selected = sorted(candidates, key=diagnostic_sort_key)[0]
    selected_policy = dict(selected["policy"])
    selected_policy["detectorQualified"] = selected["detectorQualified"]
    selected_policy["materializedQualified"] = selected["materializedQualified"]
    selected_policy["dingQualified"] = selected["dingQualified"]
    selected_policy["successQualified"] = selected["successQualified"]
    selected_policy["dingEnabled"] = selected_policy["dingEnabled"] and selected["dingQualified"]
    selected_policy["successEnabled"] = selected_policy["successEnabled"] and selected["successQualified"]
    selected["selectedPolicy"] = selected_policy
    return selected_policy, {key: value for key, value in selected.items() if key != "policy"}, candidates


def policy_sort_key(item):
    return (
        -(item["combinedMetric"]["recall"] or 0),
        -(item["combinedMetric"]["combinedWilsonLower90"] or 0),
        -(item["combinedMetric"]["combinedPrecision"] or 0),
        item["combinedMetric"]["generated"],
        -safe_float(item["policy"]["accentThreshold"]),
        -safe_float(item["policy"]["subtypeMargin"]),
        json.dumps(item["policy"], sort_keys=True),
    )


def diagnostic_sort_key(item):
    detector = item.get("detectorMetric") or item["combinedMetric"]
    materialized = item.get("materializedMetric") or item["combinedMetric"]
    return (
        -(detector["combinedPrecision"] if detector["combinedPrecision"] is not None else -1),
        -(detector["combinedWilsonLower90"] or -1),
        -(detector["recall"] or -1),
        detector["generated"],
        -(materialized["combinedPrecision"] if materialized["combinedPrecision"] is not None else -1),
        -(materialized["recall"] or -1),
        -safe_float(item["policy"]["accentThreshold"]),
        json.dumps(item["policy"], sort_keys=True),
    )


def inner_folds(train_project_ids, manifest_by_id):
    group_to_ids = defaultdict(list)
    for project_id in train_project_ids:
        group_to_ids[manifest_by_id[project_id]["generalizationGroupId"]].append(project_id)
    folds = []
    for index, group_id in enumerate(sorted(group_to_ids)):
        test_ids = sorted(group_to_ids[group_id])
        train_ids = sorted(project_id for project_id in train_project_ids if project_id not in test_ids)
        if train_ids:
            folds.append({"foldId": f"inner_{index + 1:02d}", "trainProjectIds": train_ids, "testProjectIds": test_ids})
    return folds


def score_emissions(emissions, manual_beats):
    combined = metric_for(emissions, manual_beats)
    ding = metric_for(emissions, manual_beats, "ding")
    success = metric_for(emissions, manual_beats, "success")
    matrix, _columns, matches = confusion_matrix(emissions, manual_beats)
    subtype_exact = ding["exactMatched"] + success["exactMatched"]
    cross = ding["crossPositiveMatched"] + success["crossPositiveMatched"]
    return {
        "combined": combined,
        "ding": ding,
        "success": success,
        "subtypeAccuracyOnPositiveMatches": subtype_exact / (subtype_exact + cross) if (subtype_exact + cross) else None,
        "confusion": {family: dict(counts) for family, counts in matrix.items()},
        "matchCount": len(matches),
    }


def write_confusion_csv(path, matrix):
    columns = ["ding", "success", "ding+success", "bonk", "pop", "dramatic", "other", "none"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["predicted", *columns])
        writer.writeheader()
        for family in ROUTE_FAMILIES:
            row = {"predicted": family}
            row.update({column: matrix.get(family, {}).get(column, 0) for column in columns})
            writer.writerow(row)


def write_per_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "generalizationGroupId", "manualPositive", "detectorGenerated", "detectorCombinedMatched", "detectorCombinedPrecision", "generated", "combinedMatched", "combinedPrecision", "dingGenerated", "dingExactMatched", "dingExactPrecision", "successGenerated", "successExactMatched", "successExactPrecision", "crossPositiveMatched", "nonPositiveConfusions"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def scored_emission_rows(emissions, matches):
    matched_by_candidate = {
        (match["emission"]["projectId"], match["emission"]["candidateId"]): match
        for match in matches
    }
    rows = []
    for emission in emissions:
        match = matched_by_candidate.get((emission["projectId"], emission["candidateId"]))
        manual = match["manualBeat"] if match else None
        families = manual["families"] if manual else []
        exact = bool(manual and emission["family"] in families)
        combined = bool(manual and set(families) & POSITIVE_FAMILIES)
        rows.append({
            "foldId": emission["foldId"],
            "projectId": emission["projectId"],
            "targetSec": emission["targetSec"],
            "text": emission["text"],
            "positiveAccentP": emission["positiveAccentP"],
            "subtypeP": emission["subtypeP"],
            "predictedFamily": emission["family"],
            "matchedManualFamilies": families,
            "delta": match["delta"] if match else None,
            "exactMatch": exact,
            "combinedPositiveMatch": combined,
            "outcome": "exact" if exact else "cross_positive" if combined else "non_positive_or_none",
        })
    return rows


def git_value(args, default=""):
    try:
        return subprocess.check_output(["git", *args], cwd=EDITOR_ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return default


def run_manifest(run_id, args):
    status = git_value(["status", "--short"])
    return {
        "runId": run_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "gitCommit": git_value(["rev-parse", "HEAD"]),
        "gitDirty": bool(status),
        "gitStatusShort": status.splitlines(),
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "sklearn": sklearn.__version__,
        "datasetHash": sha256_file(args.corpus),
        "projectManifestHash": sha256_file(args.project_manifest),
        "outerSplitsHash": sha256_file(args.outer_splits),
        "thisScriptHash": sha256_file(Path(__file__).resolve()),
        "trainerHash": sha256_file(EDITOR_ROOT / "scripts/sfx/train-caption-beat-model.py"),
        "featureExtractorHash": sha256_file(EDITOR_ROOT / "scripts/sfx-automation/caption/extract-caption-beat-features.mjs"),
        "lockedFinalHoldout": HOLDOUT_ID,
        "openedBlindVideoExcluded": True,
    }


def report_markdown(report):
    lines = ["# Positive Accent Nested Validation", ""]
    lines.append("Target: detect positive_accent = ding OR success, then route to ding/success only when subtype is clear.")
    lines.append("")
    lines.append(f"- Detector promoted: {str(report['promotion']['detectorPromoted']).lower()}")
    lines.append(f"- Ding enabled: {str(report['promotion']['dingEnabled']).lower()}")
    lines.append(f"- Success enabled: {str(report['promotion']['successEnabled']).lower()}")
    lines.append("")
    detector = report["metrics"]["detector"]
    combined = report["metrics"]["materialized"]
    ding = report["metrics"]["ding"]
    success = report["metrics"]["success"]
    lines.append(f"- Detector: generated {detector['generated']}, matched {detector['combinedMatched']}, precision {detector['combinedPrecision']}, wilson90 {detector['combinedWilsonLower90']}, recall {detector['recall']}")
    lines.append(f"- Materialized combined: generated {combined['generated']}, matched {combined['combinedMatched']}, precision {combined['combinedPrecision']}, wilson90 {combined['combinedWilsonLower90']}, recall {combined['recall']}")
    lines.append(f"- Ding exact: generated {ding['generated']}, matched {ding['exactMatched']}, precision {ding['exactPrecision']}, wilson90 {ding['exactWilsonLower90']}, recall {ding['recall']}")
    lines.append(f"- Success exact: generated {success['generated']}, matched {success['exactMatched']}, precision {success['exactPrecision']}, wilson90 {success['exactWilsonLower90']}, recall {success['recall']}")
    lines.append(f"- Subtype accuracy on positive matches: {report['metrics']['subtypeAccuracyOnPositiveMatches']}")
    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--project-manifest", default=str(EDITOR_ROOT / "validation/project-manifest-v1.json"))
    parser.add_argument("--outer-splits", default=str(EDITOR_ROOT / "validation/outer-splits-v1.json"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    manifest = read_json(args.project_manifest)
    splits = read_json(args.outer_splits)
    rows = load_corpus(args.corpus)
    manifest_by_id = {project["projectId"]: project for project in manifest["projects"]}
    if any(HOLDOUT_ID in ids for fold in splits["folds"] for ids in [fold["trainProjectIds"], fold["testProjectIds"]]):
        raise SystemExit("Locked holdout appears in splits")

    project_inputs, project_labels, manual_beats, label_summary, label_audit = build_stores(rows)
    duration_by_project = {project_id: item["durationSec"] for project_id, item in project_inputs.items()}
    run_id = args.run_id or datetime.now(timezone.utc).strftime("positive-accent-v1-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    model_cache = {}
    all_predictions = []
    all_detector_emissions = []
    all_emissions = []
    all_manual = []
    policy_audit = []
    per_project_rows = []

    for outer in splits["folds"]:
        outer_train = outer["trainProjectIds"]
        outer_test = outer["testProjectIds"]
        best = None
        for config in MODEL_CONFIGS:
            inner_predictions = []
            for inner in inner_folds(outer_train, manifest_by_id):
                key = (tuple(inner["trainProjectIds"]), config["id"])
                if key not in model_cache:
                    model_cache[key] = fit_positive_accent_model(project_inputs, project_labels, inner["trainProjectIds"], config)
                inner_predictions.extend(predict_positive_accent(model_cache[key], project_inputs, inner["testProjectIds"], inner["foldId"]))
            inner_manual = manual_for(manual_beats, outer_train)
            policy, selected, candidates = select_policy(inner_predictions, inner_manual, {pid: duration_by_project[pid] for pid in outer_train}, manifest_by_id)
            choice = {"config": config, "policy": policy, "selected": selected}
            choice_hash = sha256_json(choice)
            score = (
                int(policy["detectorQualified"]),
                int(policy["materializedQualified"]),
                int(policy["dingQualified"]) + int(policy["successQualified"]),
                selected["detectorMetric"]["combinedPrecision"] or -1,
                selected["detectorMetric"]["recall"] or -1,
                selected["materializedMetric"]["combinedPrecision"] or -1,
                -selected["detectorMetric"]["generated"],
            )
            if best is None or score > best["score"]:
                best = {"score": score, "config": config, "policy": policy, "selected": selected, "choiceHash": choice_hash}
        final_key = (tuple(outer_train), best["config"]["id"])
        if final_key not in model_cache:
            model_cache[final_key] = fit_positive_accent_model(project_inputs, project_labels, outer_train, best["config"])
        predictions = predict_positive_accent(model_cache[final_key], project_inputs, outer_test, outer["foldId"], best["choiceHash"])
        detector_emissions = decode_positive_detector(predictions, best["policy"], duration_by_project)
        for emission in detector_emissions:
            emission["generalizationGroupId"] = manifest_by_id[emission["projectId"]]["generalizationGroupId"]
        emissions = decode_positive_accent(predictions, best["policy"], duration_by_project)
        for emission in emissions:
            emission["generalizationGroupId"] = manifest_by_id[emission["projectId"]]["generalizationGroupId"]
        outer_manual = manual_for(manual_beats, outer_test)
        all_predictions.extend(predictions)
        all_detector_emissions.extend(detector_emissions)
        all_emissions.extend(emissions)
        all_manual.extend(outer_manual)
        policy_audit.append({
            "foldId": outer["foldId"],
            "generalizationGroupId": outer["generalizationGroupId"],
            "trainProjectIds": outer_train,
            "testProjectIds": outer_test,
            "choiceHash": best["choiceHash"],
            "config": best["config"],
            "policy": best["policy"],
            "innerSelected": best["selected"],
        })
        for project_id in outer_test:
            project_detector_emissions = [emission for emission in detector_emissions if emission["projectId"] == project_id]
            project_emissions = [emission for emission in emissions if emission["projectId"] == project_id]
            project_manual = [beat for beat in outer_manual if beat["projectId"] == project_id]
            detector_score = score_emissions(project_detector_emissions, project_manual)
            score = score_emissions(project_emissions, project_manual)
            confusion = score["confusion"]
            per_project_rows.append({
                "foldId": outer["foldId"],
                "projectId": project_id,
                "generalizationGroupId": outer["generalizationGroupId"],
                "manualPositive": score["metrics"]["combined"]["manual"] if "metrics" in score else score["combined"]["manual"],
                "detectorGenerated": detector_score["combined"]["generated"],
                "detectorCombinedMatched": detector_score["combined"]["combinedMatched"],
                "detectorCombinedPrecision": detector_score["combined"]["combinedPrecision"],
                "generated": score["combined"]["generated"],
                "combinedMatched": score["combined"]["combinedMatched"],
                "combinedPrecision": score["combined"]["combinedPrecision"],
                "dingGenerated": score["ding"]["generated"],
                "dingExactMatched": score["ding"]["exactMatched"],
                "dingExactPrecision": score["ding"]["exactPrecision"],
                "successGenerated": score["success"]["generated"],
                "successExactMatched": score["success"]["exactMatched"],
                "successExactPrecision": score["success"]["exactPrecision"],
                "crossPositiveMatched": score["combined"]["crossPositiveMatched"],
                "nonPositiveConfusions": sum(confusion.get(family, {}).get(column, 0) for family in ROUTE_FAMILIES for column in ["bonk", "pop", "dramatic", "other", "none"]),
            })

    detector_metrics = score_emissions(all_detector_emissions, all_manual)
    metrics = score_emissions(all_emissions, all_manual)
    detector_promoted = passes_detector(detector_metrics["combined"])
    materialized_promoted = detector_promoted and passes_materialized(metrics["combined"])
    ding_enabled = materialized_promoted and passes_route(metrics["ding"], "ding")
    success_enabled = materialized_promoted and passes_route(metrics["success"], "success")
    report = {
        "protocol": "positive-accent-nested-grouped-v1",
        "metrics": {
            "detector": detector_metrics["combined"],
            "materialized": metrics["combined"],
            "combined": metrics["combined"],
            "ding": metrics["ding"],
            "success": metrics["success"],
            "subtypeAccuracyOnPositiveMatches": metrics["subtypeAccuracyOnPositiveMatches"],
            "confusion": metrics["confusion"],
            "matchCount": metrics["matchCount"],
        },
        "promotion": {
            "detectorPromoted": detector_promoted,
            "materializedPromoted": materialized_promoted,
            "dingEnabled": ding_enabled,
            "successEnabled": success_enabled,
            "lockedFinalHoldoutRunAllowed": bool(ding_enabled or success_enabled),
        },
        "floors": PROMOTION_FLOORS,
    }
    matrix, _columns, matches = confusion_matrix(all_emissions, all_manual)
    _detector_matrix, _detector_columns, detector_matches = confusion_matrix(all_detector_emissions, all_manual)
    scored_rows = scored_emission_rows(all_emissions, matches)
    scored_detector_rows = scored_emission_rows(all_detector_emissions, detector_matches)

    write_json(run_dir / "run-manifest.json", run_manifest(run_id, args))
    write_json(run_dir / "positive-accent-label-summary.json", dict(label_summary))
    write_json(run_dir / "positive-accent-nested-cv-report.json", report)
    (run_dir / "positive-accent-nested-cv-report.md").write_text(report_markdown(report), encoding="utf-8")
    write_confusion_csv(run_dir / "positive-accent-confusion-matrix.csv", {family: dict(counts) for family, counts in matrix.items()})
    write_jsonl(run_dir / "positive-accent-scored-emissions.jsonl", scored_rows)
    write_jsonl(run_dir / "positive-accent-scored-detector-emissions.jsonl", scored_detector_rows)
    write_per_project_csv(run_dir / "per-project-positive-accent-metrics.csv", per_project_rows)
    write_json(run_dir / "positive-accent-policy-choice-audit.json", {"foldChoices": policy_audit})
    write_json(run_dir / "positive-accent-promotion-decision.json", report["promotion"])
    write_jsonl(run_dir / "positive-accent-outer-predictions.jsonl", all_predictions)
    write_jsonl(run_dir / "positive-accent-outer-detector-emissions.jsonl", all_detector_emissions)
    write_jsonl(run_dir / "positive-accent-outer-emissions.jsonl", all_emissions)
    write_jsonl(run_dir / "positive-accent-label-audit.jsonl", label_audit)
    print(json.dumps({
        "runDir": str(run_dir),
        "predictions": len(all_predictions),
        "detectorEmissions": len(all_detector_emissions),
        "emissions": len(all_emissions),
        "promotion": report["promotion"],
        "detectorCombinedPrecision": detector_metrics["combined"]["combinedPrecision"],
        "materializedCombinedPrecision": metrics["combined"]["combinedPrecision"],
        "dingExactPrecision": metrics["ding"]["exactPrecision"],
        "successExactPrecision": metrics["success"]["exactPrecision"],
    }, indent=2))


if __name__ == "__main__":
    main()
