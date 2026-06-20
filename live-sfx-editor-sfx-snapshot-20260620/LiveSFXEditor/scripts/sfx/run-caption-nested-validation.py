#!/usr/bin/env python3
import argparse
import csv
import hashlib
import importlib.util
import json
import math
import platform
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sklearn


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
FAMILIES = ["ding", "success", "bonk", "funny", "bruh", "record_scratch"]


def load_trainer():
    path = EDITOR_ROOT / "scripts/sfx/train-caption-beat-model.py"
    spec = importlib.util.spec_from_file_location("caption_trainer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trainer = load_trainer()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


def sha256_json(value):
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))


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


def normalize_text(value):
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in str(value or "")).split())


def tokens(value):
    return normalize_text(value).split()


def bigrams(items):
    return set(zip(items, items[1:]))


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def load_corpus(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row["project"]["projectId"] == HOLDOUT_ID:
                raise SystemExit(f"Refusing validation because locked final holdout appears in corpus: {HOLDOUT_ID}")
            rows.append(row)
    return rows


def assert_holdout_absent_from_splits(splits):
    for fold in splits.get("folds", []):
        ids = [*fold.get("trainProjectIds", []), *fold.get("testProjectIds", [])]
        if HOLDOUT_ID in ids:
            raise SystemExit(f"Refusing validation because locked final holdout appears in outer split IDs: {HOLDOUT_ID}")


def build_project_stores(rows):
    inputs = {}
    labels = {}
    manual = {}
    audits = []
    for row in rows:
        project_id = row["project"]["projectId"]
        if not row.get("trainEligible"):
            continue
        project_labels, audit, _beats = trainer.assign_project_labels(row)
        audits.extend(audit)
        inputs[project_id] = {
            "projectId": project_id,
            "durationSec": row["project"]["durationSec"],
            "fps": row["project"].get("fps") or 30,
            "candidates": [],
        }
        labels[project_id] = {}
        for candidate in row["candidates"]:
            label = project_labels[candidate["id"]]
            input_example = {
                "projectId": project_id,
                "durationSec": row["project"]["durationSec"],
                "candidateId": candidate["id"],
                "targetSec": safe_float(candidate["targetSec"]),
                "targetFrame": int(candidate.get("targetFrame") or 0),
                "beatGroupId": candidate.get("beatGroupId") or candidate["id"],
                "cueIds": candidate.get("cueIds") or [],
                "wordIds": candidate.get("wordIds") or [],
                "zoomMarkerIds": candidate.get("zoomMarkerIds") or [],
                "anchorTypes": candidate.get("anchorTypes") or [],
                "text": candidate.get("text") or "",
                "dense": candidate["denseFeatures"],
                "lexical": candidate["lexicalTokens"],
            }
            inputs[project_id]["candidates"].append(input_example)
            labels[project_id][candidate["id"]] = {
                "emit": label["emit"],
                "families": label["families"],
                "labelKind": label["labelKind"],
                "delta": label.get("delta"),
            }
        manual[project_id] = [
            {
                "projectId": project_id,
                "id": event["id"],
                "family": event["family"],
                "time": safe_float(event["audibleStartSeconds"]),
            }
            for event in row["manualEvents"]
            if event.get("family") in FAMILIES and not event.get("isAutomation")
        ]
    return inputs, labels, manual, audits


def examples_for(project_inputs, project_labels, project_ids, include_labels):
    examples = []
    for project_id in sorted(project_ids):
        for item in project_inputs[project_id]["candidates"]:
            ex = dict(item)
            if include_labels:
                label = project_labels[project_id][item["candidateId"]]
                ex.update(label)
            examples.append(ex)
    return examples


def manual_for(manual_by_project, project_ids):
    return [event for project_id in sorted(project_ids) for event in manual_by_project[project_id]]


def fit_model(project_inputs, project_labels, project_ids, config):
    examples = examples_for(project_inputs, project_labels, project_ids, include_labels=True)
    return trainer.fit_models(
        examples,
        emit_c=safe_float(config["emitC"]),
        family_c=safe_float(config["familyC"]),
    )


def predict_model(model, project_inputs, project_ids, fold_id="", choice_hash=""):
    examples = examples_for(project_inputs, {}, project_ids, include_labels=False)
    emit_p, family_p, joint = trainer.predict(model, examples)
    output = []
    for index, ex in enumerate(examples):
        top_index = int(np.argmax(joint[index]))
        sorted_joint = np.sort(joint[index])
        margin = float(sorted_joint[-1] - sorted_joint[-2]) if len(sorted_joint) > 1 else float(sorted_joint[-1])
        row = {
            "foldId": fold_id,
            "choiceHash": choice_hash,
            "projectId": ex["projectId"],
            "candidateId": ex["candidateId"],
            "targetSec": ex["targetSec"],
            "targetFrame": ex.get("targetFrame", 0),
            "beatGroupId": ex["beatGroupId"],
            "cueIds": ex.get("cueIds") or [],
            "anchorTypes": ex.get("anchorTypes") or [],
            "text": ex.get("text") or "",
            "sourceKind": "caption",
            "emitP": float(emit_p[index]),
            "familyP": {FAMILIES[i]: float(family_p[index, i]) for i in range(len(FAMILIES))},
            "jointP": {FAMILIES[i]: float(joint[index, i]) for i in range(len(FAMILIES))},
            "topFamily": FAMILIES[top_index],
            "scoreMargin": margin,
        }
        output.append(row)
    return output


def wilson_lower(matches, total, z=1.28155):
    if total <= 0:
        return None
    p = matches / total
    denom = 1 + z * z / total
    centre = p + z * z / (2 * total)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return (centre - spread) / denom


def max_count_for(policy, duration_sec):
    return max(0, math.ceil(max(0.1, duration_sec / 60.0) * safe_float(policy.get("maxPerMinute"))))


def prediction_passes_policy(pred, family, policy):
    family_p = safe_float(pred["familyP"].get(family))
    joint_p = safe_float(pred["jointP"].get(family))
    second = max([safe_float(value) for key, value in pred["jointP"].items() if key != family] or [0.0])
    margin = joint_p - second
    if pred["topFamily"] != family:
        return False, "wrong_family"
    if safe_float(pred["emitP"]) < safe_float(policy.get("gateThreshold")):
        return False, "emit_gate_failure"
    if family_p < safe_float(policy.get("conditionalThreshold")):
        return False, "wrong_family"
    if joint_p < safe_float(policy.get("jointThreshold")):
        return False, "joint_threshold_failure"
    if margin < safe_float(policy.get("marginProbability")):
        return False, "margin_failure"
    return True, ""


def decode_predictions(predictions, policies, duration_by_project):
    candidates = []
    for pred in predictions:
        family = pred["topFamily"]
        policy = policies.get(family) or {}
        if policy.get("enabled") is False:
            continue
        passes, _reason = prediction_passes_policy(pred, family, policy)
        if not passes:
            continue
        candidates.append({
            **pred,
            "family": family,
            "confidence": safe_float(pred["jointP"].get(family)),
            "scoreMargin": safe_float(pred["scoreMargin"]),
            "priority": safe_float(policy.get("priority")),
            "policy": policy,
        })
    candidates.sort(key=lambda item: (
        -item["confidence"],
        -item["priority"],
        item["targetSec"],
        item["candidateId"],
    ))
    selected = []
    per_project_family_counts = Counter()
    for item in candidates:
        project_id = item["projectId"]
        family = item["family"]
        policy = item["policy"]
        count_key = (project_id, family)
        if per_project_family_counts[count_key] >= max_count_for(policy, duration_by_project[project_id]):
            continue
        if any(
            existing["projectId"] == project_id
            and existing["family"] == family
            and abs(existing["targetSec"] - item["targetSec"]) < safe_float(policy.get("cooldownSeconds"))
            for existing in selected
        ):
            continue
        if any(
            existing["projectId"] == project_id
            and existing["sourceKind"] == item["sourceKind"]
            and abs(existing["targetSec"] - item["targetSec"]) < safe_float(policy.get("globalCooldownSeconds"))
            for existing in selected
        ):
            continue
        if any(
            existing["projectId"] == project_id
            and existing["beatGroupId"] == item["beatGroupId"]
            and abs(existing["targetSec"] - item["targetSec"]) < safe_float(policy.get("beatNmsSeconds", 0.45))
            for existing in selected
        ):
            continue
        emission = {
            "foldId": item.get("foldId", ""),
            "choiceHash": item.get("choiceHash", ""),
            "projectId": project_id,
            "candidateId": item["candidateId"],
            "family": family,
            "targetSec": item["targetSec"],
            "targetFrame": item.get("targetFrame", 0),
            "beatGroupId": item["beatGroupId"],
            "text": item.get("text", ""),
            "anchorTypes": item.get("anchorTypes") or [],
            "emitP": item["emitP"],
            "familyP": item["familyP"],
            "jointP": item["jointP"],
            "scoreMargin": item["scoreMargin"],
            "policy": {key: value for key, value in policy.items() if key != "diagnostics"},
            "sourceKind": item["sourceKind"],
        }
        selected.append(emission)
        per_project_family_counts[count_key] += 1
    return sorted(selected, key=lambda item: (item["projectId"], item["targetSec"], item["candidateId"]))


def match_emissions(emissions, manual_events, family, tolerance=0.75):
    emissions_family = [item for item in emissions if item["family"] == family]
    manual_family = [item for item in manual_events if item["family"] == family]
    possible = []
    for gi, generated in enumerate(emissions_family):
        for mi, manual in enumerate(manual_family):
            if generated["projectId"] != manual["projectId"]:
                continue
            delta = generated["targetSec"] - manual["time"]
            if abs(delta) <= tolerance:
                possible.append((abs(delta), gi, mi))
    possible.sort()
    used_g, used_m = set(), set()
    pairs = []
    for _delta, gi, mi in possible:
        if gi in used_g or mi in used_m:
            continue
        used_g.add(gi)
        used_m.add(mi)
        pairs.append((emissions_family[gi], manual_family[mi]))
    return pairs, emissions_family, manual_family


def family_metric(emissions, manual_events, family, tolerance=0.75):
    pairs, family_emissions, family_manual = match_emissions(emissions, manual_events, family, tolerance)
    matched = len(pairs)
    generated = len(family_emissions)
    manual_count = len(family_manual)
    projects = len(set(item["projectId"] for item in family_emissions))
    return {
        "matched": matched,
        "generated": generated,
        "manual": manual_count,
        "precision": matched / generated if generated else None,
        "wilsonLower90": wilson_lower(matched, generated),
        "recall": matched / manual_count if manual_count else None,
        "projects": projects,
    }


def passes_floor(metric, floor):
    return (
        metric["generated"] >= floor["minPredictions"]
        and metric["projects"] >= floor["minProjects"]
        and metric["precision"] is not None
        and metric["precision"] >= floor["precision"]
        and metric["wilsonLower90"] is not None
        and metric["wilsonLower90"] >= floor["wilsonLower90"]
    )


def select_policies(predictions, manual_events, search_space, duration_by_project):
    policies = {}
    report = {"families": {}}
    for family in FAMILIES:
        base = dict(search_space["familyDefaults"][family])
        scores = [safe_float(pred["jointP"].get(family)) for pred in predictions if pred["topFamily"] == family]
        quantiles = []
        if scores:
            quantiles = [float(np.quantile(scores, q)) for q in search_space["policySelection"]["quantiles"]]
        thresholds = sorted(set([0.0, *quantiles]))
        candidates = []
        for threshold in thresholds:
            policy = {**base, "jointThreshold": threshold, "enabled": True}
            trial_policies = {name: {**search_space["familyDefaults"][name], "enabled": False, "jointThreshold": 1.0} for name in FAMILIES}
            trial_policies[family] = policy
            emissions = decode_predictions(predictions, trial_policies, duration_by_project)
            metric = family_metric(emissions, manual_events, family)
            floor = search_space["precisionFloors"][family]
            candidate = {
                **metric,
                "passes": passes_floor(metric, floor),
                "policy": policy,
            }
            candidates.append(candidate)
        passing = [candidate for candidate in candidates if candidate["passes"]]
        if passing:
            selected = sorted(passing, key=lambda item: (
                -(item["recall"] or 0),
                -(item["wilsonLower90"] or 0),
                -(item["precision"] or 0),
                item["generated"],
                -safe_float(item["policy"]["jointThreshold"]),
                json.dumps(item["policy"], sort_keys=True),
            ))[0]
            policy = {**selected["policy"], "enabled": True, "innerQualified": True}
        elif candidates:
            selected = sorted(candidates, key=lambda item: (
                -(item["precision"] if item["precision"] is not None else -1),
                -(item["wilsonLower90"] or -1),
                -(item["recall"] or -1),
                item["generated"],
                -safe_float(item["policy"]["jointThreshold"]),
                json.dumps(item["policy"], sort_keys=True),
            ))[0]
            policy = {**selected["policy"], "enabled": False, "innerQualified": False}
        else:
            selected = {"matched": 0, "generated": 0, "manual": 0, "precision": None, "wilsonLower90": None, "recall": None, "projects": 0, "passes": False, "policy": base}
            policy = {**base, "jointThreshold": 1.0, "enabled": False, "innerQualified": False}
        policies[family] = policy
        report["families"][family] = {key: value for key, value in selected.items() if key != "policy"}
        report["families"][family]["selectedPolicy"] = policy
    return policies, report


def config_choice_score(policy_report):
    families = policy_report["families"].values()
    enabled = sum(1 for item in families if item["selectedPolicy"].get("innerQualified"))
    recall = sum(item["recall"] or 0 for item in families)
    wilson = sum(item["wilsonLower90"] or 0 for item in families)
    precision = sum(item["precision"] or 0 for item in families)
    generated = sum(item["generated"] or 0 for item in families)
    return (enabled, recall, wilson, precision, -generated)


def inner_folds(train_project_ids, manifest):
    group_to_ids = defaultdict(list)
    manifest_by_id = {item["projectId"]: item for item in manifest["projects"]}
    for project_id in train_project_ids:
        group_to_ids[manifest_by_id[project_id]["generalizationGroupId"]].append(project_id)
    folds = []
    for index, group_id in enumerate(sorted(group_to_ids)):
        test_ids = sorted(group_to_ids[group_id])
        train_ids = sorted(project_id for project_id in train_project_ids if project_id not in test_ids)
        if train_ids:
            folds.append({"foldId": f"inner_{index + 1:02d}", "groupId": group_id, "trainProjectIds": train_ids, "testProjectIds": test_ids})
    return folds


def nearest_prediction(predictions, project_id, time):
    same_project = [pred for pred in predictions if pred["projectId"] == project_id]
    if not same_project:
        return None
    return min(same_project, key=lambda pred: abs(pred["targetSec"] - time))


def false_positive_rows(emissions, manual_events):
    rows = []
    for family in FAMILIES:
        pairs, family_emissions, _manual = match_emissions(emissions, manual_events, family)
        matched_ids = {emission["candidateId"] for emission, _manual_event in pairs}
        for emission in family_emissions:
            if emission["candidateId"] in matched_ids:
                continue
            nearest = min(
                [event for event in manual_events if event["projectId"] == emission["projectId"]],
                key=lambda event: abs(event["time"] - emission["targetSec"]),
                default=None,
            )
            rows.append({
                "kind": "false_positive",
                "projectId": emission["projectId"],
                "family": family,
                "candidateId": emission["candidateId"],
                "targetSec": emission["targetSec"],
                "text": emission.get("text", ""),
                "anchorTypes": emission.get("anchorTypes", []),
                "emitP": emission["emitP"],
                "jointP": emission["jointP"],
                "scoreMargin": emission["scoreMargin"],
                "nearestManual": nearest,
            })
    return rows


def false_negative_rows(emissions, manual_events, predictions, policies):
    rows = []
    for family in FAMILIES:
        pairs, _family_emissions, family_manual = match_emissions(emissions, manual_events, family)
        matched_ids = {manual["id"] for _emission, manual in pairs}
        for manual in family_manual:
            if manual["id"] in matched_ids:
                continue
            nearest = nearest_prediction(predictions, manual["projectId"], manual["time"])
            if not nearest:
                reason = "no_observable_candidate"
            else:
                policy = policies.get(family) or {}
                passes, reason = prediction_passes_policy(nearest, family, policy)
                if passes:
                    reason = "priority_conflict"
                if policy.get("enabled") is False and not policy.get("innerQualified"):
                    reason = "joint_threshold_failure"
            rows.append({
                "kind": "false_negative",
                "projectId": manual["projectId"],
                "family": family,
                "manualId": manual["id"],
                "manualTime": manual["time"],
                "reason": reason,
                "nearestPrediction": nearest,
            })
    return rows


def phrase_leakage(predictions, train_inputs):
    training_phrases = defaultdict(set)
    training_tokens = []
    for project in train_inputs.values():
        for candidate in project["candidates"]:
            phrase = normalize_text(candidate.get("text", ""))
            if phrase:
                training_phrases[phrase].add(project["projectId"])
                training_tokens.append((project["projectId"], phrase, set(tokens(phrase)), bigrams(tokens(phrase))))
    bucket_counts = Counter()
    family_bucket_counts = defaultdict(Counter)
    examples = []
    for pred in predictions:
        phrase = normalize_text(pred.get("text", ""))
        token_set = set(tokens(phrase))
        bigram_set = bigrams(tokens(phrase))
        exact_projects = training_phrases.get(phrase, set())
        best = {"projectId": "", "phrase": "", "tokenOverlap": 0.0, "bigramOverlap": 0.0}
        for project_id, train_phrase, train_tokens, train_bigrams in training_tokens:
            token_overlap = len(token_set & train_tokens) / max(1, len(token_set | train_tokens))
            bigram_overlap = len(bigram_set & train_bigrams) / max(1, len(bigram_set | train_bigrams))
            if (token_overlap, bigram_overlap) > (best["tokenOverlap"], best["bigramOverlap"]):
                best = {"projectId": project_id, "phrase": train_phrase, "tokenOverlap": token_overlap, "bigramOverlap": bigram_overlap}
        if exact_projects:
            bucket = "exact_duplicate"
        elif best["bigramOverlap"] >= 0.60 or best["tokenOverlap"] >= 0.80:
            bucket = "high_overlap"
        elif best["tokenOverlap"] >= 0.35:
            bucket = "partial_overlap"
        else:
            bucket = "novel"
        bucket_counts[bucket] += 1
        family_bucket_counts[pred["topFamily"]][bucket] += 1
        if len(examples) < 200:
            examples.append({
                "projectId": pred["projectId"],
                "candidateId": pred["candidateId"],
                "topFamily": pred["topFamily"],
                "phrase": phrase,
                "bucket": bucket,
                "exactTrainingProjectCount": len(exact_projects),
                "nearestTraining": best,
            })
    return {
        "candidateBucketCounts": dict(bucket_counts),
        "familyBucketCounts": {family: dict(counts) for family, counts in family_bucket_counts.items()},
        "sampledCandidates": examples,
    }


def write_jsonl(path, rows):
    with Path(path).open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, default=json_default) + "\n")


def git_value(args, default=""):
    try:
        return subprocess.check_output(["git", *args], cwd=EDITOR_ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return default


def run_manifest(run_id, args, files):
    status = git_value(["status", "--short"])
    versions = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "numpy": np.__version__,
        "sklearn": sklearn.__version__,
        "node": git_value(["--version"], default=""),
    }
    try:
        node_version = subprocess.check_output(["node", "--version"], text=True).strip()
        versions["node"] = node_version
    except Exception:
        versions["node"] = ""
    return {
        "runId": run_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "gitCommit": git_value(["rev-parse", "HEAD"]),
        "gitDirty": bool(status),
        "gitStatusShort": status.splitlines(),
        "datasetHash": sha256_file(args.corpus),
        "projectManifestHash": sha256_file(args.project_manifest),
        "splitHash": sha256_file(args.outer_splits),
        "protocolHash": sha256_file(args.protocol),
        "policySearchSpaceHash": sha256_file(args.policy_search_space),
        "versions": versions,
        "fileHashes": {name: sha256_file(path) for name, path in files.items()},
        "lockedFinalHoldout": HOLDOUT_ID,
    }


def write_per_project_csv(path, rows):
    fieldnames = [
        "foldId", "generalizationGroupId", "projectId", "recordingDate", "scriptBatchId",
        "family", "manual", "generated", "matched", "precision", "wilsonLower90", "recall",
        "innerJointThreshold", "innerQualified",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_ding_phrase_audit(path, emissions, fp_rows, train_inputs_by_fold):
    fieldnames = ["projectId", "candidateId", "outcome", "targetSec", "phrase", "exactTrainingProjectCount", "nearestTrainingPhrase", "nearestTrainingProject"]
    fp_ids = {row["candidateId"] for row in fp_rows if row["family"] == "ding"}
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for emission in emissions:
            if emission["family"] != "ding":
                continue
            train_inputs = train_inputs_by_fold.get(emission["foldId"], {})
            leakage = phrase_leakage([emission], train_inputs)
            sample = leakage["sampledCandidates"][0] if leakage["sampledCandidates"] else {}
            writer.writerow({
                "projectId": emission["projectId"],
                "candidateId": emission["candidateId"],
                "outcome": "FP" if emission["candidateId"] in fp_ids else "TP",
                "targetSec": emission["targetSec"],
                "phrase": normalize_text(emission.get("text", "")),
                "exactTrainingProjectCount": sample.get("exactTrainingProjectCount", 0),
                "nearestTrainingPhrase": sample.get("nearestTraining", {}).get("phrase", ""),
                "nearestTrainingProject": sample.get("nearestTraining", {}).get("projectId", ""),
            })


def aggregate_report(emissions, manual_events, per_project_rows, search_space):
    families = {}
    for family in FAMILIES:
        metric = family_metric(emissions, manual_events, family)
        metric["passesFloor"] = passes_floor(metric, search_space["precisionFloors"][family])
        families[family] = metric
    return {
        "protocol": "nested-grouped-caption-cv-v1",
        "families": families,
        "projectRows": per_project_rows,
        "captionFamiliesEnabled": [family for family, metric in families.items() if metric["passesFloor"]],
    }


def write_report_md(path, report):
    lines = ["# Nested Caption Validation V1", ""]
    lines.append("Only outer-fold emissions are counted. Inner folds choose model policy; outer projects do not tune thresholds.")
    lines.append("")
    for family, metric in report["families"].items():
        lines.append(
            f"- {family}: pass {str(metric['passesFloor']).lower()}, generated {metric['generated']}, "
            f"matched {metric['matched']}, precision {metric['precision']}, wilson90 {metric['wilsonLower90']}, "
            f"recall {metric['recall']}, projects {metric['projects']}"
        )
    lines.append("")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def current_vs_nested(current_report_path, nested_report, oracle_report):
    current = read_json(current_report_path)
    rows = {}
    for family in FAMILIES:
        existing = current.get("families", {}).get(family, {})
        nested = nested_report["families"].get(family, {})
        oracle = oracle_report["families"].get(family, {})
        rows[family] = [
            {"row": "existing_reported_metric_untrusted", **{key: existing.get(key) for key in ["generated", "matched", "manual", "precision", "wilsonLower90", "recall", "projects"]}},
            {"row": "existing_fixed_policy_no_retune", "generated": 0, "matched": 0, "manual": nested.get("manual"), "precision": None, "wilsonLower90": None, "recall": 0, "projects": 0},
            {"row": "official_nested_outer_metric", **nested},
            {"row": "contaminated_outer_oracle_policy", **oracle},
        ]
    return rows


def write_nested_vs_current_md(path, rows):
    lines = ["# Nested vs Current", "", "Only `official_nested_outer_metric` is a development metric.", ""]
    for family, items in rows.items():
        lines.append(f"## {family}")
        for item in items:
            lines.append(f"- {item['row']}: generated {item.get('generated')}, matched {item.get('matched')}, precision {item.get('precision')}, recall {item.get('recall')}")
        lines.append("")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--protocol", default=str(EDITOR_ROOT / "validation/protocol-v1.json"))
    parser.add_argument("--project-manifest", default=str(EDITOR_ROOT / "validation/project-manifest-v1.json"))
    parser.add_argument("--outer-splits", default=str(EDITOR_ROOT / "validation/outer-splits-v1.json"))
    parser.add_argument("--policy-search-space", default=str(EDITOR_ROOT / "validation/policy-search-space-v1.json"))
    parser.add_argument("--current-report", default=str(EDITOR_ROOT / "data/sfx-automation-v2/model-v1/caption-cv-report.json"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    protocol = read_json(args.protocol)
    manifest = read_json(args.project_manifest)
    splits = read_json(args.outer_splits)
    search_space = read_json(args.policy_search_space)
    assert protocol["lockedFinalHoldout"] == HOLDOUT_ID
    assert_holdout_absent_from_splits(splits)

    rows = load_corpus(args.corpus)
    project_inputs, project_labels, manual_by_project, label_audit = build_project_stores(rows)
    duration_by_project = {project_id: project["durationSec"] for project_id, project in project_inputs.items()}
    manifest_by_id = {item["projectId"]: item for item in manifest["projects"]}

    run_id = args.run_id or datetime.now(timezone.utc).strftime("nested-caption-v1-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    model_cache = {}
    all_outer_predictions = []
    all_outer_emissions = []
    all_outer_manual = []
    per_project_rows = []
    false_positives = []
    false_negatives = []
    choice_audit = []
    leakage_by_fold = {}
    train_inputs_by_fold = {}

    configs = search_space["modelConfigGrid"]
    for outer in splits["folds"]:
        outer_train_ids = outer["trainProjectIds"]
        outer_test_ids = outer["testProjectIds"]
        best_choice = None
        for config in configs:
            inner_oof = []
            for inner in inner_folds(outer_train_ids, manifest):
                cache_key = (tuple(inner["trainProjectIds"]), config["id"])
                if cache_key not in model_cache:
                    model_cache[cache_key] = fit_model(project_inputs, project_labels, inner["trainProjectIds"], config)
                predictions = predict_model(model_cache[cache_key], project_inputs, inner["testProjectIds"], fold_id=inner["foldId"])
                inner_oof.extend(predictions)
            inner_manual = manual_for(manual_by_project, outer_train_ids)
            policies, policy_report = select_policies(inner_oof, inner_manual, search_space, duration_by_project)
            choice = {
                "modelConfig": config,
                "policyBundle": policies,
                "innerReport": policy_report,
            }
            choice["choiceHash"] = sha256_json(choice)
            score = config_choice_score(policy_report)
            if best_choice is None or (score, -safe_float(config.get("emitC")), -safe_float(config.get("familyC")), config["id"]) > best_choice["sortKey"]:
                best_choice = {**choice, "sortKey": (score, -safe_float(config.get("emitC")), -safe_float(config.get("familyC")), config["id"])}

        outer_cache_key = (tuple(outer_train_ids), best_choice["modelConfig"]["id"])
        if outer_cache_key not in model_cache:
            model_cache[outer_cache_key] = fit_model(project_inputs, project_labels, outer_train_ids, best_choice["modelConfig"])
        raw_predictions = predict_model(
            model_cache[outer_cache_key],
            project_inputs,
            outer_test_ids,
            fold_id=outer["foldId"],
            choice_hash=best_choice["choiceHash"],
        )
        raw_hash = sha256_json(raw_predictions)
        emissions = decode_predictions(raw_predictions, best_choice["policyBundle"], duration_by_project)
        outer_manual = manual_for(manual_by_project, outer_test_ids)
        all_outer_predictions.extend(raw_predictions)
        all_outer_emissions.extend(emissions)
        all_outer_manual.extend(outer_manual)
        train_inputs = {project_id: project_inputs[project_id] for project_id in outer_train_ids}
        train_inputs_by_fold[outer["foldId"]] = train_inputs
        leakage_by_fold[outer["foldId"]] = phrase_leakage(raw_predictions, train_inputs)
        false_positives.extend(false_positive_rows(emissions, outer_manual))
        false_negatives.extend(false_negative_rows(emissions, outer_manual, raw_predictions, best_choice["policyBundle"]))
        choice_audit.append({
            "foldId": outer["foldId"],
            "generalizationGroupId": outer["generalizationGroupId"],
            "trainProjectIds": outer_train_ids,
            "testProjectIds": outer_test_ids,
            "choiceHash": best_choice["choiceHash"],
            "rawPredictionSha256": raw_hash,
            "modelConfig": best_choice["modelConfig"],
            "policyBundle": best_choice["policyBundle"],
            "innerReport": best_choice["innerReport"],
        })
        for project_id in outer_test_ids:
            project_manual = [event for event in outer_manual if event["projectId"] == project_id]
            project_emissions = [event for event in emissions if event["projectId"] == project_id]
            meta = manifest_by_id[project_id]
            for family in FAMILIES:
                metric = family_metric(project_emissions, project_manual, family)
                policy = best_choice["policyBundle"][family]
                per_project_rows.append({
                    "foldId": outer["foldId"],
                    "generalizationGroupId": outer["generalizationGroupId"],
                    "projectId": project_id,
                    "recordingDate": meta.get("recordingDate", ""),
                    "scriptBatchId": meta.get("scriptBatchId", ""),
                    "family": family,
                    "manual": metric["manual"],
                    "generated": metric["generated"],
                    "matched": metric["matched"],
                    "precision": metric["precision"],
                    "wilsonLower90": metric["wilsonLower90"],
                    "recall": metric["recall"],
                    "innerJointThreshold": policy.get("jointThreshold"),
                    "innerQualified": policy.get("innerQualified"),
                })

    nested_report = aggregate_report(all_outer_emissions, all_outer_manual, per_project_rows, search_space)
    oracle_policies, oracle_policy_report = select_policies(all_outer_predictions, all_outer_manual, search_space, duration_by_project)
    oracle_emissions = decode_predictions(all_outer_predictions, oracle_policies, duration_by_project)
    oracle_report = aggregate_report(oracle_emissions, all_outer_manual, [], search_space)
    comparison = current_vs_nested(args.current_report, nested_report, oracle_report)

    write_json(run_dir / "run-manifest.json", run_manifest(run_id, args, {
        "candidateBuilder": EDITOR_ROOT / "scripts/sfx-automation/caption/build-caption-beat-candidates.mjs",
        "featureExtractor": EDITOR_ROOT / "scripts/sfx-automation/caption/extract-caption-beat-features.mjs",
        "labelAndModelCode": EDITOR_ROOT / "scripts/sfx/train-caption-beat-model.py",
        "nestedValidationCode": Path(__file__).resolve(),
        "runtimeScorer": EDITOR_ROOT / "scripts/sfx-automation/scoring/caption-model-scorer.mjs",
        "decoder": EDITOR_ROOT / "scripts/sfx-automation/decoding/decode-timeline.mjs",
    }))
    write_json(run_dir / "outer-folds.json", splits)
    write_jsonl(run_dir / "nested-outer-predictions.jsonl", all_outer_predictions)
    write_jsonl(run_dir / "nested-outer-emissions.jsonl", all_outer_emissions)
    write_json(run_dir / "nested-cv-report.json", nested_report)
    write_report_md(run_dir / "nested-cv-report.md", nested_report)
    write_per_project_csv(run_dir / "per-project-family-metrics.csv", per_project_rows)
    write_jsonl(run_dir / "false-positives.jsonl", false_positives)
    write_jsonl(run_dir / "false-negatives.jsonl", false_negatives)
    write_ding_phrase_audit(run_dir / "ding-phrase-audit.csv", all_outer_emissions, false_positives, train_inputs_by_fold)
    write_json(run_dir / "phrase-token-leakage.json", leakage_by_fold)
    write_json(run_dir / "nested-vs-current.json", comparison)
    write_nested_vs_current_md(run_dir / "nested-vs-current.md", comparison)
    write_json(run_dir / "choice-influence-audit.json", {
        "rule": "Outer test predictions and labels are not supplied to the selector; choice is based on inner OOF only.",
        "foldChoices": choice_audit,
        "oraclePolicyReportForContaminationAuditOnly": oracle_policy_report,
    })
    write_json(run_dir / "promotion-decision.json", {
        "captionFamiliesEnabled": nested_report["captionFamiliesEnabled"],
        "promoted": bool(nested_report["captionFamiliesEnabled"]),
        "reason": "Caption family promotion requires outer-only nested metrics to clear predeclared family floors.",
        "families": nested_report["families"],
        "lockedFinalHoldoutRunAllowed": bool(nested_report["captionFamiliesEnabled"]),
    })
    write_jsonl(run_dir / "label-audit.jsonl", label_audit)
    print(json.dumps({
        "runDir": str(run_dir),
        "outerPredictionCount": len(all_outer_predictions),
        "outerEmissionCount": len(all_outer_emissions),
        "enabledFamilies": nested_report["captionFamiliesEnabled"],
    }, indent=2))


if __name__ == "__main__":
    main()
