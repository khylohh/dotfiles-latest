#!/usr/bin/env python3
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import linear_sum_assignment
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.linear_model import LogisticRegression


CLASSES = [
    "none", "pop", "ding", "success", "bonk", "funny",
    "bruh", "record_scratch", "dramatic", "other_sfx",
]
EMITTABLE = {
    "pop", "ding", "success", "bonk", "funny",
    "bruh", "record_scratch", "dramatic",
}
NON_EMITTING = {"none", "other_sfx"}
PROHIBITED_PROJECT_IDS = {"footage_06_10_26_sfx", "blind_caption_only_06_17_26"}
TIMING_ANCHORS = [
    "final_word_end", "cue_end_minus_80ms", "pause_boundary",
    "speaker_turn_start", "internal_pause_word_end", "zoom_onset", "cue_start",
]
PROJECT_EXAMPLE_CACHE = {}


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def median(values):
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return 0.0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2.0


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, default=json_default) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
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


def dataset_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_corpus(path):
    records = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            project_id = record["project"]["projectId"]
            if project_id in PROHIBITED_PROJECT_IDS:
                raise SystemExit(f"Prohibited project appears in V3 corpus: {project_id}")
            records.append(record)
    return records


def training_records(records):
    return [record for record in records if record.get("trainEligible") and record.get("moments")]


def records_by_project(records):
    return {record["project"]["projectId"]: record for record in records}


def cluster_manual_beats(events):
    normalized = []
    for event in events or []:
        if event.get("isAutomation"):
            continue
        family = event.get("routerFamily")
        time = safe_float(event.get("audibleStartSeconds"), None)
        if family in CLASSES and family != "none" and time is not None:
            normalized.append({"family": family, "time": time, "event": event})
    normalized.sort(key=lambda item: item["time"])
    clusters = []
    for event in normalized:
        if not clusters:
            clusters.append([event])
            continue
        if abs(event["time"] - median(item["time"] for item in clusters[-1])) <= 0.300:
            clusters[-1].append(event)
        else:
            clusters.append([event])
    beats = []
    for index, cluster in enumerate(clusters):
        times_by_family = defaultdict(list)
        for item in cluster:
            times_by_family[item["family"]].append(item["time"])
        beats.append({
            "beatId": f"manual_beat_{index + 1}",
            "medianTime": median(item["time"] for item in cluster),
            "families": sorted(times_by_family),
            "timesByFamily": {family: sorted(times) for family, times in times_by_family.items()},
            "events": [item["event"] for item in cluster],
        })
    return beats


def option_boundary(option):
    return safe_float((option.get("parentFeatures") or {}).get("boundaryStrength"))


def closest_option(moment, target_time):
    options = moment.get("timingOptions") or []
    if not options:
        return None
    return min(options, key=lambda option: abs(safe_float(option.get("targetSec")) - target_time))


def assign_project_moment_labels(record):
    beats = cluster_manual_beats(record.get("manualEvents") or [])
    moments = record.get("moments") or []
    labels = {moment["momentId"]: {"kind": "unlabeled"} for moment in moments}
    if not beats:
        for moment in moments:
            labels[moment["momentId"]] = {"kind": "none", "acceptableClasses": ["none"]}
        return labels

    cost = np.full((len(beats), len(moments) + len(beats)), 999.0, dtype=np.float64)
    for beat_index, beat in enumerate(beats):
        for moment_index, moment in enumerate(moments):
            option = closest_option(moment, beat["medianTime"])
            if not option:
                continue
            delta = safe_float(option.get("targetSec")) - beat["medianTime"]
            if abs(delta) <= 0.75:
                cost[beat_index, moment_index] = abs(delta) + 0.02 * (1.0 - option_boundary(option))
        cost[beat_index, len(moments) + beat_index] = 0.66

    row_indexes, column_indexes = linear_sum_assignment(cost)
    for beat_index, column_index in zip(row_indexes, column_indexes):
        if column_index >= len(moments) or cost[beat_index, column_index] >= 900:
            continue
        beat = beats[beat_index]
        moment = moments[column_index]
        acceptable = []
        timing_targets = {}
        for family, manual_times in beat["timesByFamily"].items():
            best = min(
                moment.get("timingOptions") or [],
                key=lambda option: min(abs(safe_float(option.get("targetSec")) - time) for time in manual_times),
                default=None,
            )
            if not best:
                continue
            target_time = min(manual_times, key=lambda time: abs(safe_float(best.get("targetSec")) - time))
            delta = safe_float(best.get("targetSec")) - target_time
            strong_window = 0.35 if family == "pop" else 0.50
            if abs(delta) <= strong_window:
                acceptable.append(family)
                timing_targets[family] = {
                    "manualTime": target_time,
                    "bestOptionId": best["optionId"],
                    "deltaSec": delta,
                }
        labels[moment["momentId"]] = (
            {
                "kind": "positive",
                "acceptableClasses": sorted(set(acceptable)),
                "timingTargets": timing_targets,
            }
            if acceptable else {"kind": "ignore"}
        )

    all_manual_times = [safe_float(event.get("audibleStartSeconds")) for event in record.get("manualEvents") or []]
    for moment in moments:
        label = labels[moment["momentId"]]
        if label["kind"] != "unlabeled":
            continue
        nearest = min(
            (
                abs(safe_float(option.get("targetSec")) - manual_time)
                for option in moment.get("timingOptions") or []
                for manual_time in all_manual_times
            ),
            default=999.0,
        )
        labels[moment["momentId"]] = (
            {"kind": "none", "acceptableClasses": ["none"]}
            if nearest > 1.25
            else {"kind": "ignore"}
        )
    return labels


def moment_text(moment):
    lexical = ((moment.get("features") or {}).get("lexical") or [])
    if lexical:
        return " ".join(lexical)
    return f"{moment.get('captionWindow', '')} {moment.get('text', '')}".strip()


def moment_dense(moment):
    return dict(((moment.get("features") or {}).get("dense") or {}))


def build_project_route_examples(record):
    project_id = record["project"]["projectId"]
    if project_id in PROJECT_EXAMPLE_CACHE:
        return PROJECT_EXAMPLE_CACHE[project_id]
    examples = []
    timing_assignments = []
    labels = assign_project_moment_labels(record)
    group_id = record["project"].get("generalizationGroupId") or record["project"]["projectId"]
    for moment in record.get("moments") or []:
        label = labels[moment["momentId"]]
        if label["kind"] == "ignore":
            continue
        if label["kind"] == "positive":
            classes = [family for family in label.get("acceptableClasses") or [] if family in CLASSES and family != "none"]
        else:
            classes = ["none"]
        if not classes:
            continue
        weight = 1.0 / len(classes)
        for router_class in classes:
            examples.append({
                "projectId": record["project"]["projectId"],
                "generalizationGroupId": group_id,
                "momentId": moment["momentId"],
                "moment": moment,
                "class": router_class,
                "sampleWeight": weight,
            })
            target = (label.get("timingTargets") or {}).get(router_class)
            if target and router_class in EMITTABLE:
                timing_assignments.append({
                    "projectId": record["project"]["projectId"],
                    "moment": moment,
                    "family": router_class,
                    "bestOptionId": target["bestOptionId"],
                    "manualTime": target["manualTime"],
                    "deltaSec": target["deltaSec"],
                })
    PROJECT_EXAMPLE_CACHE[project_id] = (examples, timing_assignments)
    return PROJECT_EXAMPLE_CACHE[project_id]


def build_route_examples(records):
    examples = []
    timing_assignments = []
    for record in records:
        project_examples, project_timing = build_project_route_examples(record)
        examples.extend(project_examples)
        timing_assignments.extend(project_timing)
    return examples, timing_assignments


def dense_names_for(examples):
    return sorted({key for example in examples for key in moment_dense(example["moment"])})


def dense_matrix_for_moments(moments, dense_names, mean=None, scale=None):
    values = np.zeros((len(moments), len(dense_names)), dtype=np.float64)
    for row, moment in enumerate(moments):
        dense = moment_dense(moment)
        for col, name in enumerate(dense_names):
            values[row, col] = safe_float(dense.get(name))
    if mean is None:
        mean = values.mean(axis=0) if len(values) else np.zeros(len(dense_names))
        scale = values.std(axis=0) if len(values) else np.ones(len(dense_names))
        scale = np.where(scale < 1e-6, 1.0, scale)
    return sparse.csr_matrix((values - mean) / scale), mean, scale


def fit_router(examples, c_value):
    if not examples:
        raise ValueError("No route examples supplied")
    vectorizer = CountVectorizer(
        lowercase=False,
        tokenizer=str.split,
        token_pattern=None,
        binary=True,
        min_df=1,
        max_features=3000,
    )
    texts = [moment_text(example["moment"]) for example in examples]
    x_text = vectorizer.fit_transform(texts) * 0.35
    dense_names = dense_names_for(examples)
    x_dense, mean, scale = dense_matrix_for_moments([example["moment"] for example in examples], dense_names)
    x = sparse.hstack([x_text, x_dense], format="csr")
    y = np.array([example["class"] for example in examples])
    weights = np.array([safe_float(example.get("sampleWeight"), 1.0) for example in examples])
    clf = LogisticRegression(
        C=c_value,
        solver="lbfgs",
        max_iter=50,
        tol=0.01,
        random_state=20260621,
    )
    clf.fit(x, y, sample_weight=weights)
    return {
        "vectorizer": vectorizer,
        "denseNames": dense_names,
        "mean": mean,
        "scale": scale,
        "clf": clf,
        "c": c_value,
    }


def router_matrix(model, moments):
    x_text = model["vectorizer"].transform([moment_text(moment) for moment in moments]) * 0.35
    x_dense, _mean, _scale = dense_matrix_for_moments(moments, model["denseNames"], model["mean"], model["scale"])
    return sparse.hstack([x_text, x_dense], format="csr")


def option_feature_values(moment, option, family):
    parent = option.get("parentFeatures") or {}
    target = safe_float(option.get("targetSec"))
    cue_start = safe_float(parent.get("cueStartSec"))
    cue_end = safe_float(parent.get("cueEndSec"))
    zoom_start = safe_float(parent.get("nearestZoomStartSec"), None)
    anchor = option.get("anchorType") or ""
    values = {
        "timing.boundary_strength": option_boundary(option),
        "timing.word_timing_available": 1.0 if parent.get("wordTimingAvailable") else 0.0,
        "timing.has_zoom": 1.0 if option.get("zoomMarkerIds") else 0.0,
        "timing.delta_to_cue_start": target - cue_start,
        "timing.delta_to_cue_end": target - cue_end,
        "timing.delta_to_nearest_zoom": target - zoom_start if zoom_start is not None else 0.0,
        "moment.option_count": safe_float(((moment.get("features") or {}).get("dense") or {}).get("moment.option_count")),
        "moment.has_zoom": safe_float(((moment.get("features") or {}).get("dense") or {}).get("moment.has_zoom")),
        f"family:{family}": 1.0,
    }
    for item in TIMING_ANCHORS:
        values[f"timing.anchor.{item}"] = 1.0 if anchor == item else 0.0
        values[f"family_anchor:{family}:{item}"] = 1.0 if anchor == item else 0.0
    return values


def fit_timing_ranker(assignments, c_value=0.10):
    pair_rows = []
    residuals = defaultdict(list)
    for assignment in assignments:
        moment = assignment["moment"]
        family = assignment["family"]
        options = moment.get("timingOptions") or []
        best = next((option for option in options if option.get("optionId") == assignment["bestOptionId"]), None)
        if not best:
            continue
        residuals[f"{family}:{best.get('anchorType') or ''}"].append(safe_float(assignment["manualTime"]) - safe_float(best.get("targetSec")))
        best_features = option_feature_values(moment, best, family)
        for other in options:
            if other.get("optionId") == best.get("optionId"):
                continue
            other_features = option_feature_values(moment, other, family)
            names = set(best_features) | set(other_features)
            pair_rows.append({name: safe_float(best_features.get(name)) - safe_float(other_features.get(name)) for name in names})
    feature_names = sorted({name for row in pair_rows for name in row})
    if not pair_rows or not feature_names:
        weights = np.zeros(len(feature_names), dtype=np.float64)
    else:
        x = np.array([[row.get(name, 0.0) for name in feature_names] for row in pair_rows], dtype=np.float64)
        y = np.ones(len(pair_rows), dtype=np.int64)
        # Add reversed comparisons so the ranker learns direction without a synthetic intercept.
        x = np.vstack([x, -x])
        y = np.concatenate([y, np.zeros(len(pair_rows), dtype=np.int64)])
        clf = LogisticRegression(C=c_value, solver="lbfgs", max_iter=1000, fit_intercept=False)
        clf.fit(x, y)
        weights = clf.coef_[0]
    offsets = {}
    for key, values in residuals.items():
        offsets[key] = max(-0.25, min(0.25, median(values)))
    return {
        "featureNames": feature_names,
        "weights": weights,
        "offsetByFamilyAnchor": offsets,
    }


def timing_score(timing_model, moment, option, family):
    feature_names = timing_model.get("featureNames") or []
    raw_weights = timing_model.get("weights")
    if raw_weights is None or len(raw_weights) == 0:
        raw_weights = np.zeros(len(feature_names))
    weights = np.array(raw_weights, dtype=np.float64)
    values = option_feature_values(moment, option, family)
    vector = np.array([safe_float(values.get(name)) for name in feature_names], dtype=np.float64)
    return float(np.dot(vector, weights)) if len(vector) and len(weights) else fallback_timing_score(option)


def fallback_timing_score(option):
    anchor = option.get("anchorType") or ""
    priority = {
        "final_word_end": 7,
        "cue_end_minus_80ms": 6,
        "pause_boundary": 5,
        "speaker_turn_start": 4,
        "internal_pause_word_end": 3,
        "zoom_onset": 2,
        "cue_start": 1,
    }
    return float(priority.get(anchor, 0)) + option_boundary(option)


def choose_timing_option(timing_model, moment, family):
    options = moment.get("timingOptions") or []
    if not options:
        return None
    scored = []
    for option in options:
        score = timing_score(timing_model, moment, option, family)
        scored.append((score, -abs(safe_float(option.get("targetSec")) - safe_float(moment.get("momentSec"))), option.get("optionId") or "", option))
    scored.sort(reverse=True)
    selected = scored[0][3]
    offset = safe_float((timing_model.get("offsetByFamilyAnchor") or {}).get(f"{family}:{selected.get('anchorType') or ''}"))
    return {
        "option": selected,
        "timingScore": scored[0][0],
        "targetSec": max(0.0, safe_float(selected.get("targetSec")) + offset),
    }


def predict_router(model, moments, fold_id=""):
    if not moments:
        return []
    x = router_matrix(model, moments)
    probs = model["clf"].predict_proba(x)
    clf_classes = list(model["clf"].classes_)
    output = []
    for moment, row in zip(moments, probs):
        probabilities = {router_class: 0.0 for router_class in CLASSES}
        for index, router_class in enumerate(clf_classes):
            probabilities[router_class] = float(row[index])
        ranked = sorted(probabilities.items(), key=lambda item: (-item[1], CLASSES.index(item[0])))
        top_class, top_probability = ranked[0]
        timing = choose_timing_option(model.get("timingRanker") or {}, moment, top_class) if top_class in EMITTABLE else None
        output.append({
            "foldId": fold_id,
            "projectId": moment.get("projectId", ""),
            "generalizationGroupId": moment.get("generalizationGroupId", ""),
            "momentId": moment["momentId"],
            "beatGroupId": moment.get("beatGroupId", ""),
            "momentSec": safe_float(moment.get("momentSec")),
            "topClass": top_class,
            "topProbability": top_probability,
            "classProbabilities": probabilities,
            "selectedTimingOptionId": timing["option"]["optionId"] if timing else "",
            "selectedAnchorType": timing["option"].get("anchorType") if timing else "",
            "timingScore": timing["timingScore"] if timing else None,
            "targetSec": timing["targetSec"] if timing else None,
        })
    return output


def attach_record_context(records):
    out = []
    for record in records:
        project_id = record["project"]["projectId"]
        group_id = record["project"].get("generalizationGroupId") or project_id
        for moment in record.get("moments") or []:
            out.append({**moment, "projectId": project_id, "generalizationGroupId": group_id})
    return out


def decode_predictions(predictions, policy):
    threshold = safe_float(policy.get("emitThreshold"))
    nms = safe_float(policy.get("globalNmsSeconds"), 0.30)
    candidates = [
        row for row in predictions
        if row.get("topClass") in EMITTABLE
        and safe_float(row.get("topProbability")) >= threshold
        and row.get("targetSec") is not None
    ]
    candidates.sort(key=lambda row: (-safe_float(row.get("topProbability")), safe_float(row.get("targetSec")), row.get("momentId", "")))
    selected = []
    for row in candidates:
        if any(existing["projectId"] == row["projectId"] and abs(safe_float(existing["targetSec"]) - safe_float(row["targetSec"])) < nms for existing in selected):
            continue
        selected.append({
            "projectId": row["projectId"],
            "generalizationGroupId": row.get("generalizationGroupId", ""),
            "momentId": row["momentId"],
            "family": row["topClass"],
            "targetSec": safe_float(row["targetSec"]),
            "topProbability": safe_float(row["topProbability"]),
            "selectedTimingOptionId": row.get("selectedTimingOptionId", ""),
            "selectedAnchorType": row.get("selectedAnchorType", ""),
            "timingScore": row.get("timingScore"),
        })
    return sorted(selected, key=lambda row: (row["projectId"], row["targetSec"], row["momentId"]))


def match_tolerance(family):
    return 0.35 if family == "pop" else 0.75


def human_events_for_records(records):
    events = []
    for record in records:
        project_id = record["project"]["projectId"]
        group_id = record["project"].get("generalizationGroupId") or project_id
        for event in record.get("manualEvents") or []:
            family = event.get("routerFamily")
            if family in CLASSES and family != "none" and not event.get("isAutomation"):
                events.append({
                    "projectId": project_id,
                    "generalizationGroupId": group_id,
                    "eventId": event.get("id", ""),
                    "family": family,
                    "time": safe_float(event.get("audibleStartSeconds")),
                })
    return events


def event_match_window(family, match_window_sec=None):
    if match_window_sec is not None:
        return safe_float(match_window_sec)
    return match_tolerance(family)


def match_generated_to_human(generated, manual, match_window_sec=None):
    possible = []
    for gen_index, generated_event in enumerate(generated):
        for human_index, human_event in enumerate(manual):
            if generated_event["projectId"] != human_event["projectId"]:
                continue
            if generated_event["family"] != human_event["family"]:
                continue
            if human_event["family"] not in EMITTABLE:
                continue
            delta = safe_float(generated_event["targetSec"]) - safe_float(human_event["time"])
            if abs(delta) <= event_match_window(human_event["family"], match_window_sec):
                possible.append((abs(delta), gen_index, human_index, delta))
    possible.sort()
    used_generated = set()
    used_human = set()
    matches = []
    for _abs_delta, gen_index, human_index, delta in possible:
        if gen_index in used_generated or human_index in used_human:
            continue
        used_generated.add(gen_index)
        used_human.add(human_index)
        matches.append({
            "generated": generated[gen_index],
            "human": manual[human_index],
            "deltaSec": delta,
        })
    false_additions = [row for index, row in enumerate(generated) if index not in used_generated]
    false_negatives = [row for index, row in enumerate(manual) if index not in used_human]
    return matches, false_additions, false_negatives


def product_metrics(generated, manual, match_window_sec=None):
    matches, false_additions, false_negatives = match_generated_to_human(generated, manual, match_window_sec)
    by_family = {}
    for family in CLASSES:
        if family == "none":
            continue
        fam_manual = [event for event in manual if event["family"] == family]
        fam_generated = [event for event in generated if event["family"] == family]
        fam_matches = [item for item in matches if item["human"]["family"] == family]
        fam_false = [event for event in false_additions if event["family"] == family]
        by_family[family] = {
            "humanTotal": len(fam_manual),
            "matched": len(fam_matches),
            "generatedAttempts": len(fam_generated),
            "falseAdditions": len(fam_false),
            "netSavedEdits": len(fam_matches) - len(fam_false),
        }
    by_project = []
    for project_id in sorted({event["projectId"] for event in manual} | {event["projectId"] for event in generated}):
        project_manual = [event for event in manual if event["projectId"] == project_id]
        project_generated = [event for event in generated if event["projectId"] == project_id]
        project_matches = [item for item in matches if item["human"]["projectId"] == project_id]
        project_false = [event for event in false_additions if event["projectId"] == project_id]
        by_project.append({
            "projectId": project_id,
            "humanTotal": len(project_manual),
            "matched": len(project_matches),
            "generatedAttempts": len(project_generated),
            "falseAdditions": len(project_false),
            "netSavedEdits": len(project_matches) - len(project_false),
        })
    matched = len(matches)
    generated_count = len(generated)
    human_total = len(manual)
    false_count = len(false_additions)
    return {
        "humanTotal": human_total,
        "matchWindowSec": match_window_sec,
        "matched": matched,
        "coverage": matched / human_total if human_total else None,
        "generatedAttempts": generated_count,
        "falseAdditions": false_count,
        "netSavedEdits": matched - false_count,
        "precision": matched / generated_count if generated_count else None,
        "positiveNetProjectFraction": (
            sum(1 for row in by_project if row["netSavedEdits"] > 0) / len(by_project)
            if by_project else None
        ),
        "byFamily": by_family,
        "byProject": by_project,
        "matches": matches,
        "falseAdditionsRows": false_additions,
        "falseNegativesRows": false_negatives,
    }


def model_to_json(model, dataset_hash="", training_records_list=None):
    vectorizer = model["vectorizer"]
    vocab = [None] * len(vectorizer.vocabulary_)
    for token, index in vectorizer.vocabulary_.items():
        vocab[index] = token
    clf = model["clf"]
    dense_count = len(model["denseNames"])
    lexical_count = len(vocab)
    intercepts = []
    dense_weights = []
    lexical_weights = []
    if hasattr(clf, "estimators_"):
        estimator_by_class = {str(router_class): estimator for router_class, estimator in zip(clf.classes_, clf.estimators_)}
        for router_class in CLASSES:
            estimator = estimator_by_class.get(router_class)
            if estimator is None:
                intercepts.append(-50.0)
                lexical_weights.append([0.0] * lexical_count)
                dense_weights.append([0.0] * dense_count)
                continue
            weights = estimator.coef_[0]
            intercepts.append(float(estimator.intercept_[0]))
            lexical_weights.append([float(value) for value in weights[:lexical_count]])
            dense_weights.append([float(value) for value in weights[lexical_count:]])
    else:
        class_to_row = {str(router_class): index for index, router_class in enumerate(clf.classes_)}
        for router_class in CLASSES:
            row_index = class_to_row.get(router_class)
            if row_index is None:
                intercepts.append(-50.0)
                lexical_weights.append([0.0] * lexical_count)
                dense_weights.append([0.0] * dense_count)
                continue
            weights = clf.coef_[row_index]
            intercepts.append(float(clf.intercept_[row_index]))
            lexical_weights.append([float(value) for value in weights[:lexical_count]])
            dense_weights.append([float(value) for value in weights[lexical_count:]])
    training_records_list = training_records_list or []
    return {
        "schemaVersion": 3,
        "modelVersion": "caption-moment-router-linear-v1",
        "featureVersion": 3,
        "classes": CLASSES,
        "emittableClasses": sorted(EMITTABLE),
        "dense": {
            "names": model["denseNames"],
            "mean": [float(value) for value in model["mean"]],
            "scale": [float(value) for value in model["scale"]],
        },
        "lexical": {
            "vocabulary": vocab,
            "inputScale": 0.35,
        },
        "routerSoftmax": {
            "intercepts": intercepts,
            "denseWeights": dense_weights,
            "lexicalWeights": lexical_weights,
        },
        "timingRanker": {
            "featureNames": model.get("timingRanker", {}).get("featureNames", []),
            "weights": [float(value) for value in model.get("timingRanker", {}).get("weights", [])],
            "offsetByFamilyAnchor": model.get("timingRanker", {}).get("offsetByFamilyAnchor", {}),
        },
        "trainingProvenance": {
            "datasetSha256": dataset_hash,
            "trainingProjectIds": sorted(record["project"]["projectId"] for record in training_records_list),
            "generalizationGroupIds": sorted({record["project"].get("generalizationGroupId") or record["project"]["projectId"] for record in training_records_list}),
            "holdoutIncluded": any(record["project"]["projectId"] in PROHIBITED_PROJECT_IDS for record in training_records_list),
        },
    }
