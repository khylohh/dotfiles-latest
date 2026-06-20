#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy import sparse
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.model_selection import GroupKFold


FAMILIES = ["ding", "success", "bonk", "funny", "bruh", "record_scratch"]
HOLDOUT_ID = "footage_06_10_26_sfx"
RANDOM_SEED = 20260618
C_GRID_EMIT = [0.03, 0.10, 0.30, 1.00]
C_GRID_FAMILY = [0.03, 0.10, 0.30]

PRECISION_FLOORS = {
    "ding": {"precision": 0.75, "wilson": 0.60, "min_predictions": 30, "min_projects": 6},
    "success": {"precision": 0.75, "wilson": 0.60, "min_predictions": 25, "min_projects": 6},
    "bonk": {"precision": 0.78, "wilson": 0.62, "min_predictions": 25, "min_projects": 6},
    "funny": {"precision": 0.82, "wilson": 0.65, "min_predictions": 20, "min_projects": 6},
    "bruh": {"precision": 0.90, "wilson": 0.72, "min_predictions": 15, "min_projects": 5},
    "record_scratch": {"precision": 0.90, "wilson": 0.72, "min_predictions": 15, "min_projects": 5},
}

FAMILY_POLICY_DEFAULTS = {
    "ding": {"gateThreshold": 0.60, "conditionalThreshold": 0.55, "jointThreshold": 0.75, "marginProbability": 0.12, "cooldownSeconds": 5, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.35, "priority": 55},
    "success": {"gateThreshold": 0.60, "conditionalThreshold": 0.60, "jointThreshold": 0.78, "marginProbability": 0.15, "cooldownSeconds": 10, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.20, "priority": 75},
    "bonk": {"gateThreshold": 0.65, "conditionalThreshold": 0.60, "jointThreshold": 0.80, "marginProbability": 0.18, "cooldownSeconds": 8, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.25, "priority": 80},
    "funny": {"gateThreshold": 0.70, "conditionalThreshold": 0.65, "jointThreshold": 0.84, "marginProbability": 0.20, "cooldownSeconds": 15, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.08, "priority": 40},
    "bruh": {"gateThreshold": 0.80, "conditionalThreshold": 0.75, "jointThreshold": 0.92, "marginProbability": 0.25, "cooldownSeconds": 60, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.03, "priority": 90},
    "record_scratch": {"gateThreshold": 0.85, "conditionalThreshold": 0.80, "jointThreshold": 0.94, "marginProbability": 0.30, "cooldownSeconds": 90, "globalCooldownSeconds": 0.9, "beatNmsSeconds": 0.45, "maxPerMinute": 0.03, "priority": 95},
}


def load_corpus(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            project_id = row["project"]["projectId"]
            if project_id == HOLDOUT_ID:
                raise SystemExit(f"Refusing to train with locked holdout project: {HOLDOUT_ID}")
            rows.append(row)
    return rows


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def cluster_manual_beats(events):
    events = sorted([e for e in events if e["family"] in FAMILIES and not e.get("isAutomation")], key=lambda x: x["audibleStartSeconds"])
    beats = []
    for event in events:
        if not beats:
            beats.append({"events": [event]})
            continue
        median = float(np.median([e["audibleStartSeconds"] for e in beats[-1]["events"]]))
        if abs(event["audibleStartSeconds"] - median) <= 0.300:
            beats[-1]["events"].append(event)
        else:
            beats.append({"events": [event]})
    for index, beat in enumerate(beats):
        times = [e["audibleStartSeconds"] for e in beat["events"]]
        beat["id"] = f"manual_beat_{index + 1}"
        beat["time"] = float(np.median(times))
        beat["families"] = sorted(set(e["family"] for e in beat["events"]))
    return beats


def anchor_penalty(candidate, family):
    types = set(candidate.get("anchorTypes") or [])
    values = []
    if "final_word_end" in types:
        values.append(0.00)
    if "cue_end_minus_80ms" in types:
        values.append(0.03)
    if "pause_boundary" in types:
        values.append(0.03)
    if "speaker_turn_start" in types:
        values.append(0.05)
    if "internal_pause_word_end" in types:
        values.append(0.06)
    if "cue_start" in types:
        values.append(0.10)
    if "zoom_onset" in types:
        values.append(0.08)
    base = min(values) if values else 0.12
    if family == "record_scratch":
        if "speaker_turn_start" in types or "cue_start" in types:
            base -= 0.04
        else:
            base += 0.04
    elif "cue_start" in types and len(types) == 1:
        base += 0.04
    return max(0.0, base)


def structural_penalty(candidate):
    dense = candidate["denseFeatures"]
    penalty = 0.0
    boundary = safe_float(dense.get("anchor.boundary_strength"))
    if boundary < 0.20:
        penalty += 0.10
    if safe_float(dense.get("anchor.word_timing_available")) <= 0:
        penalty += 0.05
    if safe_float(dense.get("anchor.is_cue_start")) > 0 and boundary < 0.30:
        penalty += 0.08
    return penalty


def assignment_cost(candidate, beat):
    family = beat["families"][0] if beat["families"] else "ding"
    delta = abs(safe_float(candidate["targetSec"]) - beat["time"])
    return delta + anchor_penalty(candidate, family) + structural_penalty(candidate)


def assign_project_labels(project):
    candidates = project["candidates"]
    beats = cluster_manual_beats(project["manualEvents"])
    labels = {c["id"]: {"emit": None, "families": [], "labelKind": "unlabeled", "delta": None} for c in candidates}
    audit = []
    if not beats:
        for c in candidates:
            labels[c["id"]]["emit"] = 0
            labels[c["id"]]["labelKind"] = "clean_negative"
        return labels, audit, beats

    bag_candidate_ids = sorted({
        c["id"]
        for beat in beats
        for c in candidates
        if abs(safe_float(c["targetSec"]) - beat["time"]) <= 0.750
    })
    col_candidates = [next(c for c in candidates if c["id"] == cid) for cid in bag_candidate_ids]
    n_beats = len(beats)
    n_cols = len(col_candidates) + n_beats
    cost = np.full((n_beats, n_cols), 999.0, dtype=np.float64)
    for row_idx, beat in enumerate(beats):
        for col_idx, candidate in enumerate(col_candidates):
            if abs(safe_float(candidate["targetSec"]) - beat["time"]) <= 0.750:
                cost[row_idx, col_idx] = assignment_cost(candidate, beat)
        cost[row_idx, len(col_candidates) + row_idx] = 0.66

    row_ind, col_ind = linear_sum_assignment(cost)
    assigned_candidate_ids = set()
    positive_or_weak_groups = set()
    for row_idx, col_idx in zip(row_ind, col_ind):
        beat = beats[row_idx]
        if col_idx >= len(col_candidates) or cost[row_idx, col_idx] >= 900:
            audit.append({"projectId": project["project"]["projectId"], "beatId": beat["id"], "kind": "caption_unobservable", "time": beat["time"], "families": beat["families"]})
            continue
        candidate = col_candidates[col_idx]
        assigned_candidate_ids.add(candidate["id"])
        delta = safe_float(candidate["targetSec"]) - beat["time"]
        distinct_costs = sorted(
            assignment_cost(other, beat)
            for other in col_candidates
            if other["id"] != candidate["id"]
            and other.get("beatGroupId") != candidate.get("beatGroupId")
            and abs(safe_float(other["targetSec"]) - beat["time"]) <= 0.750
        )
        margin = (distinct_costs[0] - cost[row_idx, col_idx]) if distinct_costs else 999.0
        strong = abs(delta) <= 0.500 and cost[row_idx, col_idx] <= 0.550 and margin >= 0.100
        weak = abs(delta) <= 0.750 and cost[row_idx, col_idx] <= 0.750
        if strong:
            kind = "strong_positive"
            labels[candidate["id"]].update({"emit": 1, "families": beat["families"], "labelKind": kind, "delta": delta, "assignmentCost": float(cost[row_idx, col_idx]), "assignmentMargin": margin})
            positive_or_weak_groups.add(candidate.get("beatGroupId"))
        elif weak:
            kind = "weak_ambiguous"
            labels[candidate["id"]].update({"emit": None, "families": [], "labelKind": kind, "delta": delta, "assignmentCost": float(cost[row_idx, col_idx]), "assignmentMargin": margin})
            positive_or_weak_groups.add(candidate.get("beatGroupId"))
        else:
            kind = "caption_unobservable"
        audit.append({"projectId": project["project"]["projectId"], "beatId": beat["id"], "kind": kind, "time": beat["time"], "families": beat["families"], "candidateId": candidate["id"], "delta": delta, "cost": float(cost[row_idx, col_idx]), "margin": margin})

    beat_times = [b["time"] for b in beats]
    for candidate in candidates:
        label = labels[candidate["id"]]
        if label["labelKind"] != "unlabeled":
            continue
        nearest = min([abs(safe_float(candidate["targetSec"]) - t) for t in beat_times], default=999)
        if candidate.get("beatGroupId") in positive_or_weak_groups:
            label["labelKind"] = "near_positive_ignored"
        elif nearest > 1.250:
            label["emit"] = 0
            label["labelKind"] = "clean_negative"
        else:
            label["labelKind"] = "dead_zone_ignored"
    return labels, audit, beats


def build_examples(rows):
    projects = []
    audits = []
    for row in rows:
        if not row.get("trainEligible"):
            continue
        labels, audit, beats = assign_project_labels(row)
        audits.extend(audit)
        examples = []
        for c in row["candidates"]:
            label = labels[c["id"]]
            examples.append({
                "projectId": row["project"]["projectId"],
                "durationSec": row["project"]["durationSec"],
                "candidateId": c["id"],
                "targetSec": safe_float(c["targetSec"]),
                "beatGroupId": c.get("beatGroupId") or c["id"],
                "dense": c["denseFeatures"],
                "lexical": c["lexicalTokens"],
                "emit": label["emit"],
                "families": label["families"],
                "labelKind": label["labelKind"],
            })
        projects.append({"row": row, "examples": examples, "beats": beats})
    return projects, audits


def dense_names_for(examples):
    return sorted({k for ex in examples for k in ex["dense"].keys()})


def vocabulary_for(examples):
    counts = Counter()
    project_df = defaultdict(set)
    positive_project_df = defaultdict(set)
    for ex in examples:
        tokens = set(ex["lexical"])
        for t in tokens:
            counts[t] += 1
            project_df[t].add(ex["projectId"])
            if ex["emit"] == 1:
                positive_project_df[t].add(ex["projectId"])
    vocab = sorted([t for t, c in counts.items() if c >= 10 and len(project_df[t]) >= 3])
    positive_ok = {t for t in vocab if len(positive_project_df[t]) >= 2}
    return vocab, positive_ok


def make_matrix(examples, dense_names, vocab, mean=None, scale=None):
    dense = np.zeros((len(examples), len(dense_names)), dtype=np.float64)
    vocab_index = {t: i for i, t in enumerate(vocab)}
    rows, cols, data = [], [], []
    for r, ex in enumerate(examples):
        for c, name in enumerate(dense_names):
            dense[r, c] = safe_float(ex["dense"].get(name))
        for token in set(ex["lexical"]):
            c = vocab_index.get(token)
            if c is not None:
                rows.append(r)
                cols.append(c)
                data.append(0.35)
    if mean is None:
        mean = dense.mean(axis=0) if len(dense) else np.zeros(len(dense_names))
        scale = dense.std(axis=0) if len(dense) else np.ones(len(dense_names))
        scale = np.where(scale < 1e-6, 1.0, scale)
    dense = (dense - mean) / scale
    lexical = sparse.csr_matrix((data, (rows, cols)), shape=(len(examples), len(vocab)), dtype=np.float64)
    return sparse.hstack([sparse.csr_matrix(dense), lexical], format="csr"), mean, scale


def emit_and_family_rows(examples, max_neg_ratio=4):
    positives = [ex for ex in examples if ex["emit"] == 1]
    negatives = [ex for ex in examples if ex["emit"] == 0]
    rng = random.Random(RANDOM_SEED)
    max_negatives = max(200, max_neg_ratio * len(positives))
    if len(negatives) > max_negatives:
        negatives = rng.sample(negatives, max_negatives)
    emit_rows = positives + negatives
    family_rows, family_y, family_w = [], [], []
    for ex in positives:
        families = [f for f in ex["families"] if f in FAMILIES]
        if not families:
            continue
        weight = 1.0 / len(families)
        for f in families:
            family_rows.append(ex)
            family_y.append(FAMILIES.index(f))
            family_w.append(weight)
    return emit_rows, np.array([ex["emit"] for ex in emit_rows], dtype=np.int64), family_rows, np.array(family_y, dtype=np.int64), np.array(family_w, dtype=np.float64)


def project_groups(examples):
    return np.array([ex["projectId"] for ex in examples])


def choose_emit_c(examples, dense_names, vocab):
    rows, y, _, _, _ = emit_and_family_rows(examples)
    groups = project_groups(rows)
    if len(set(groups)) < 3 or len(set(y)) < 2:
        return 0.10
    best = None
    splits = list(GroupKFold(n_splits=min(4, len(set(groups)))).split(rows, y, groups))
    for c in C_GRID_EMIT:
        losses = []
        for train_idx, test_idx in splits:
            train = [rows[i] for i in train_idx]
            test = [rows[i] for i in test_idx]
            y_train = y[train_idx]
            y_test = y[test_idx]
            if len(set(y_train)) < 2:
                continue
            x_train, mean, scale = make_matrix(train, dense_names, vocab)
            x_test, _, _ = make_matrix(test, dense_names, vocab, mean, scale)
            clf = LogisticRegression(C=c, solver="liblinear", max_iter=1000, random_state=RANDOM_SEED)
            clf.fit(x_train, y_train)
            probs = clf.predict_proba(x_test)[:, 1]
            losses.append(log_loss(y_test, probs, labels=[0, 1]))
        avg = float(np.mean(losses)) if losses else 999
        if best is None or avg < best[0] - 1e-9 or (abs(avg - best[0]) < 1e-9 and c < best[1]):
            best = (avg, c)
    return best[1]


def choose_family_c(examples, dense_names, vocab):
    _, _, rows, y, w = emit_and_family_rows(examples)
    if len(rows) < 10 or len(set(y)) < 2:
        return 0.10
    groups = project_groups(rows)
    if len(set(groups)) < 3:
        return 0.10
    best = None
    for c in C_GRID_FAMILY:
        losses = []
        for train_idx, test_idx in GroupKFold(n_splits=min(4, len(set(groups)))).split(rows, y, groups):
            if len(set(y[train_idx])) < 2:
                continue
            train = [rows[i] for i in train_idx]
            test = [rows[i] for i in test_idx]
            x_train, mean, scale = make_matrix(train, dense_names, vocab)
            x_test, _, _ = make_matrix(test, dense_names, vocab, mean, scale)
            clf = LogisticRegression(C=c, solver="lbfgs", max_iter=1000, random_state=RANDOM_SEED)
            clf.fit(x_train, y[train_idx], sample_weight=w[train_idx])
            probs = np.zeros((len(test), len(FAMILIES)), dtype=np.float64) + 1e-9
            pred = clf.predict_proba(x_test)
            for class_pos, cls in enumerate(clf.classes_):
                probs[:, int(cls)] = pred[:, class_pos]
            probs /= probs.sum(axis=1, keepdims=True)
            losses.append(log_loss(y[test_idx], probs, labels=list(range(len(FAMILIES)))))
        avg = float(np.mean(losses)) if losses else 999
        if best is None or avg < best[0] - 1e-9 or (abs(avg - best[0]) < 1e-9 and c < best[1]):
            best = (avg, c)
    return best[1]


def fit_models(examples, emit_c=None, family_c=None, dense_names=None, vocab=None):
    if dense_names is None:
        dense_names = dense_names_for(examples)
    if vocab is None:
        vocab, positive_ok = vocabulary_for(examples)
    else:
        positive_ok = set(vocab)
    if emit_c is None:
        emit_c = choose_emit_c(examples, dense_names, vocab)
    if family_c is None:
        family_c = choose_family_c(examples, dense_names, vocab)
    emit_rows, y_emit, family_rows, y_family, w_family = emit_and_family_rows(examples)
    x_emit, mean, scale = make_matrix(emit_rows, dense_names, vocab)
    emit_clf = LogisticRegression(C=emit_c, solver="liblinear", max_iter=1000, random_state=RANDOM_SEED)
    emit_clf.fit(x_emit, y_emit)

    if len(family_rows) and len(set(y_family)) >= 2:
        x_family, _, _ = make_matrix(family_rows, dense_names, vocab, mean, scale)
        family_clf = LogisticRegression(C=family_c, solver="lbfgs", max_iter=1000, random_state=RANDOM_SEED)
        family_clf.fit(x_family, y_family, sample_weight=w_family)
    else:
        family_clf = None
    return {
        "dense_names": dense_names,
        "vocab": vocab,
        "positive_ok": positive_ok,
        "mean": mean,
        "scale": scale,
        "emit": emit_clf,
        "family": family_clf,
        "emit_c": emit_c,
        "family_c": family_c,
    }


def predict(model, examples):
    x, _, _ = make_matrix(examples, model["dense_names"], model["vocab"], model["mean"], model["scale"])
    emit_p = model["emit"].predict_proba(x)[:, 1]
    family_p = np.zeros((len(examples), len(FAMILIES)), dtype=np.float64) + (1.0 / len(FAMILIES))
    if model["family"] is not None:
        pred = model["family"].predict_proba(x)
        family_p[:] = 1e-9
        for class_pos, cls in enumerate(model["family"].classes_):
            family_p[:, int(cls)] = pred[:, class_pos]
        family_p /= family_p.sum(axis=1, keepdims=True)
    joint = emit_p[:, None] * family_p
    return emit_p, family_p, joint


def lopo_predictions(projects):
    out = []
    eligible = [p for p in projects if p["examples"]]
    for held in eligible:
        train_examples = [ex for p in eligible if p is not held for ex in p["examples"]]
        model = fit_models(train_examples)
        emit_p, family_p, joint = predict(model, held["examples"])
        for idx, ex in enumerate(held["examples"]):
            top = int(np.argmax(joint[idx]))
            sorted_joint = np.sort(joint[idx])
            margin = float(sorted_joint[-1] - sorted_joint[-2]) if len(sorted_joint) > 1 else float(sorted_joint[-1])
            out.append({
                "projectId": ex["projectId"],
                "candidateId": ex["candidateId"],
                "targetSec": ex["targetSec"],
                "beatGroupId": ex["beatGroupId"],
                "labelKind": ex["labelKind"],
                "trueFamilies": ex["families"],
                "emitP": float(emit_p[idx]),
                "familyP": {FAMILIES[i]: float(family_p[idx, i]) for i in range(len(FAMILIES))},
                "jointP": {FAMILIES[i]: float(joint[idx, i]) for i in range(len(FAMILIES))},
                "topFamily": FAMILIES[top],
                "scoreMargin": margin,
            })
    return out


def manual_events(projects):
    events = []
    for project in projects:
        pid = project["row"]["project"]["projectId"]
        for event in project["row"]["manualEvents"]:
            if event["family"] in FAMILIES and not event.get("isAutomation"):
                events.append({"projectId": pid, "family": event["family"], "time": event["audibleStartSeconds"]})
    return events


def decode_family(preds, family, policy):
    items = []
    for p in preds:
        if p["topFamily"] != family:
            continue
        family_p = p["familyP"][family]
        joint_p = p["jointP"][family]
        second = max([v for k, v in p["jointP"].items() if k != family] or [0.0])
        margin = joint_p - second
        if p["emitP"] < policy["gateThreshold"] or family_p < policy["conditionalThreshold"] or joint_p < policy["jointThreshold"] or margin < policy["marginProbability"]:
            continue
        items.append({**p, "family": family, "familyScore": joint_p, "margin": margin})
    items.sort(key=lambda x: (-x["familyScore"], -x["margin"], x["targetSec"]))
    selected = []
    for item in items:
        if any(s["projectId"] == item["projectId"] and s["beatGroupId"] == item["beatGroupId"] for s in selected):
            continue
        if any(s["projectId"] == item["projectId"] and abs(s["targetSec"] - item["targetSec"]) < policy["cooldownSeconds"] for s in selected):
            continue
        selected.append(item)
    return selected


def strict_match(emissions, manual, family, tolerance=0.75):
    manual_family = [m for m in manual if m["family"] == family]
    possible = []
    for gi, gen in enumerate(emissions):
        for mi, man in enumerate(manual_family):
            if gen["projectId"] != man["projectId"]:
                continue
            delta = gen["targetSec"] - man["time"]
            if abs(delta) <= tolerance:
                possible.append((abs(delta), gi, mi))
    possible.sort()
    used_g, used_m = set(), set()
    for _, gi, mi in possible:
        if gi in used_g or mi in used_m:
            continue
        used_g.add(gi)
        used_m.add(mi)
    return len(used_g), len(emissions), len(manual_family)


def wilson_lower(matches, total, z=1.28155):
    if total <= 0:
        return None
    p = matches / total
    denom = 1 + z * z / total
    centre = p + z * z / (2 * total)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return (centre - spread) / denom


def select_policy(oof, manual):
    policies = {}
    report = {"families": {}}
    for family in FAMILIES:
        base = dict(FAMILY_POLICY_DEFAULTS[family])
        scores = sorted([p["jointP"][family] for p in oof if p["topFamily"] == family])
        quantiles = sorted(set(float(x) for x in np.quantile(scores, np.linspace(0.50, 0.995, 35)))) if scores else []
        candidates = []
        for joint_threshold in sorted(set([base["jointThreshold"], *quantiles])):
            policy = {**base, "jointThreshold": joint_threshold}
            emissions = decode_family(oof, family, policy)
            matched, generated, manual_count = strict_match(emissions, manual, family)
            precision = matched / generated if generated else None
            recall = matched / manual_count if manual_count else None
            projects = len(set(e["projectId"] for e in emissions))
            lower = wilson_lower(matched, generated)
            floor = PRECISION_FLOORS[family]
            passes = (
                generated >= floor["min_predictions"]
                and projects >= floor["min_projects"]
                and precision is not None
                and precision >= floor["precision"]
                and lower is not None
                and lower >= floor["wilson"]
            )
            candidates.append({
                "matched": matched,
                "generated": generated,
                "manual": manual_count,
                "precision": precision,
                "wilsonLower90": lower,
                "recall": recall,
                "projects": projects,
                "passes": passes,
                "policy": policy,
            })
        passing = [c for c in candidates if c["passes"]]
        if passing:
            selected = sorted(passing, key=lambda c: (-(c["recall"] or 0), c["policy"]["jointThreshold"]))[0]
            enabled = True
        else:
            selected = sorted(candidates, key=lambda c: ((c["precision"] if c["precision"] is not None else -1), c["generated"]), reverse=True)[0] if candidates else {"matched": 0, "generated": 0, "manual": 0, "precision": None, "wilsonLower90": None, "recall": None, "projects": 0, "passes": False, "policy": base}
            enabled = False
        policies[family] = {**selected["policy"], "enabled": enabled}
        report["families"][family] = {k: v for k, v in selected.items() if k != "policy"}
        report["families"][family]["selectedPolicy"] = policies[family]
    return policies, report


def model_json(model, dataset_sha):
    dense_n = len(model["dense_names"])
    emit_coef = model["emit"].coef_[0]
    emit_intercept = float(model["emit"].intercept_[0])
    family_dense = np.zeros((len(FAMILIES), dense_n), dtype=np.float64)
    family_lex = np.zeros((len(FAMILIES), len(model["vocab"])), dtype=np.float64)
    family_intercepts = np.full((len(FAMILIES),), -20.0, dtype=np.float64)
    if model["family"] is not None:
        coef = model["family"].coef_
        intercept = model["family"].intercept_
        for pos, cls in enumerate(model["family"].classes_):
            family_intercepts[int(cls)] = float(intercept[pos])
            family_dense[int(cls), :] = coef[pos, :dense_n]
            family_lex[int(cls), :] = coef[pos, dense_n:]
    return {
        "schemaVersion": 2,
        "modelVersion": "caption-beat-linear-v1",
        "featureVersion": 2,
        "families": FAMILIES,
        "candidateConfig": {"cueEndOffsetSec": 0.08, "internalWordPauseSec": 0.24, "pauseBoundarySec": 0.30, "anchorClusterSec": 0.12, "beatGroupSec": 0.45, "labelWindowSec": 0.75},
        "dense": {"names": model["dense_names"], "mean": model["mean"].tolist(), "scale": model["scale"].tolist()},
        "lexical": {"vocabulary": model["vocab"], "inputScale": 0.35, "gateLogitClip": 0.75, "familyLogitClip": 1.0, "minimumProjectDf": 3},
        "emitGate": {"intercept": emit_intercept, "denseWeights": emit_coef[:dense_n].tolist(), "lexicalWeights": emit_coef[dense_n:].tolist(), "platt": {"a": 1, "b": 0}},
        "familySoftmax": {"intercepts": family_intercepts.tolist(), "denseWeights": family_dense.tolist(), "lexicalWeights": family_lex.tolist(), "temperature": 1},
        "jointCalibration": {family: {"a": 1, "b": 0} for family in FAMILIES},
        "trainingProvenance": {"datasetSha256": dataset_sha, "featureCodeSha256": "", "cvProtocol": "lopo-sklearn-scipy", "holdoutIncluded": False, "randomSeed": RANDOM_SEED},
    }


def coefficient_audit(model, limit=100):
    dense_n = len(model["dense_names"])
    names = model["dense_names"] + [f"lex:{t}" for t in model["vocab"]]
    items = []
    for i, w in enumerate(model["emit"].coef_[0]):
        items.append({"stage": "emit", "feature": names[i], "weight": float(w)})
    if model["family"] is not None:
        for pos, cls in enumerate(model["family"].classes_):
            for i, w in enumerate(model["family"].coef_[pos]):
                items.append({"stage": f"family:{FAMILIES[int(cls)]}", "feature": names[i], "weight": float(w)})
    return sorted(items, key=lambda x: abs(x["weight"]), reverse=True)[:limit]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="data/sfx-automation-v2/visible-caption-corpus.jsonl")
    parser.add_argument("--out-dir", default="data/sfx-automation-v2/model-v1")
    parser.add_argument("--seed", type=int, default=RANDOM_SEED)
    args = parser.parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)

    corpus_path = Path(args.corpus)
    dataset_sha = hashlib.sha256(corpus_path.read_bytes()).hexdigest()
    rows = load_corpus(corpus_path)
    projects, audit = build_examples(rows)
    examples = [ex for p in projects for ex in p["examples"]]
    positives = [ex for ex in examples if ex["emit"] == 1]
    clean_negatives = [ex for ex in examples if ex["emit"] == 0]
    oof = lopo_predictions(projects)
    policies, cv_report = select_policy(oof, manual_events(projects))
    final = fit_models(examples)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "caption-beat-model.json").write_text(json.dumps(model_json(final, dataset_sha), indent=2) + "\n", encoding="utf-8")
    (out_dir / "caption-family-policy.json").write_text(json.dumps({"schemaVersion": 2, "modelVersion": "caption-beat-linear-v1", "featureVersion": 2, "families": policies}, indent=2) + "\n", encoding="utf-8")
    (out_dir / "caption-feature-manifest.json").write_text(json.dumps({"schemaVersion": 2, "denseFeatureCount": len(final["dense_names"]), "lexicalFeatureCount": len(final["vocab"]), "denseFeatures": final["dense_names"]}, indent=2) + "\n", encoding="utf-8")
    with open(out_dir / "caption-label-audit.jsonl", "w", encoding="utf-8") as f:
        for row in audit:
            f.write(json.dumps(row) + "\n")
    (out_dir / "caption-label-summary.json").write_text(json.dumps({"projectCount": len(projects), "candidateCount": len(examples), "strongPositiveCount": len(positives), "cleanNegativeCount": len(clean_negatives), "labelKinds": Counter(ex["labelKind"] for ex in examples), "positiveFamilies": Counter(f for ex in positives for f in ex["families"])}, indent=2) + "\n", encoding="utf-8")
    with open(out_dir / "caption-oof-predictions.jsonl", "w", encoding="utf-8") as f:
        for row in oof:
            f.write(json.dumps(row) + "\n")
    (out_dir / "caption-cv-report.json").write_text(json.dumps(cv_report, indent=2) + "\n", encoding="utf-8")
    report_lines = ["# Caption Beat Model CV Report", ""]
    for family, item in cv_report["families"].items():
        report_lines.append(f"- {family}: enabled {str(item['selectedPolicy']['enabled']).lower()}, generated {item['generated']}, matched {item['matched']}, precision {item['precision']}, wilson90 {item['wilsonLower90']}, recall {item['recall']}, projects {item['projects']}")
    report_lines.append("")
    (out_dir / "caption-cv-report.md").write_text("\n".join(report_lines), encoding="utf-8")
    (out_dir / "caption-coefficient-audit.json").write_text(json.dumps(coefficient_audit(final), indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outDir": str(out_dir), "projectCount": len(projects), "candidateCount": len(examples), "strongPositiveCount": len(positives), "cleanNegativeCount": len(clean_negatives), "enabledFamilies": [f for f, p in policies.items() if p["enabled"]]}, indent=2))


if __name__ == "__main__":
    main()
