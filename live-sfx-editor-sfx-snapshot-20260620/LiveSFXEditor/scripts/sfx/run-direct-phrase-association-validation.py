#!/usr/bin/env python3
import argparse
import csv
import json
import math
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from caption_moment_router_model import (
    CLASSES,
    EMITTABLE,
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
from phrase_cue_model import phrase_allowed, tokens_for_text


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_SPLITS = EDITOR_ROOT / "validation/outer-splits-v1.json"
DEFAULT_OUT_ROOT = EDITOR_ROOT / "validation/runs-a14"
MAX_PHRASE_TOKENS = 6


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def compact_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}}


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


def cue_phrases(text):
    tokens = tokens_for_text(text)[:80]
    phrases = {}
    for size in range(1, MAX_PHRASE_TOKENS + 1):
        for index in range(0, max(0, len(tokens) - size + 1)):
            phrase_tokens = tokens[index:index + size]
            if not phrase_allowed(phrase_tokens):
                continue
            phrase = " ".join(phrase_tokens)
            phrases[phrase] = {
                "phrase": phrase,
                "length": size,
                "tokenStart": index,
            }
    return phrases


def canonical_options(moment):
    best_by_anchor = {}
    for option in moment.get("timingOptions") or []:
        anchor = option.get("anchorType") or ""
        if not anchor:
            continue
        current = best_by_anchor.get(anchor)
        key = (
            safe_float((option.get("parentFeatures") or {}).get("boundaryStrength")),
            1.0 if option.get("zoomMarkerIds") else 0.0,
            -abs(safe_float(option.get("targetSec")) - safe_float(moment.get("momentSec"))),
            -(safe_float(option.get("targetSec"))),
        )
        if current is None or key > current[0]:
            best_by_anchor[anchor] = (key, option)
    return [item[1] for item in best_by_anchor.values()]


def project_manual_by_family(record):
    by_family = defaultdict(list)
    for event in record.get("manualEvents") or []:
        family = event.get("routerFamily")
        if family in CLASSES and family != "none" and not event.get("isAutomation"):
            by_family[family].append(safe_float(event.get("audibleStartSeconds")))
    for family in by_family:
        by_family[family].sort()
    return by_family


def nearest_delta(times, target, window_sec):
    if not times:
        return None
    index = bisect_left(times, target)
    candidates = []
    if index < len(times):
        candidates.append(safe_float(times[index]) - target)
    if index > 0:
        candidates.append(safe_float(times[index - 1]) - target)
    if not candidates:
        return None
    best = min(candidates, key=lambda delta: abs(delta))
    return best if abs(best) <= window_sec else None


def median(values):
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return 0.0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2.0


def bounded_offset(values):
    return max(-1.0, min(1.0, median(values)))


def candidate_occurrences(records):
    for moment in attach_record_context(records):
        phrases = cue_phrases(moment.get("text") or "")
        if not phrases:
            continue
        options = canonical_options(moment)
        if not options:
            continue
        for phrase, meta in phrases.items():
            for option in options:
                yield {
                    "projectId": moment.get("projectId", ""),
                    "generalizationGroupId": moment.get("generalizationGroupId", ""),
                    "momentId": moment.get("momentId", ""),
                    "beatGroupId": moment.get("beatGroupId", ""),
                    "momentSec": safe_float(moment.get("momentSec")),
                    "text": moment.get("text", ""),
                    "phrase": phrase,
                    "phraseLength": meta["length"],
                    "tokenStart": meta["tokenStart"],
                    "anchorType": option.get("anchorType") or "",
                    "targetSec": safe_float(option.get("targetSec")),
                    "selectedTimingOptionId": option.get("optionId", ""),
                    "hasZoom": 1 if option.get("zoomMarkerIds") else 0,
                    "boundaryStrength": safe_float((option.get("parentFeatures") or {}).get("boundaryStrength")),
                }


def build_direct_phrase_model(records, match_window_sec):
    record_by_project = {record["project"]["projectId"]: record for record in records}
    manual_by_project = {project_id: project_manual_by_family(record) for project_id, record in record_by_project.items()}
    total_by_phrase_anchor = defaultdict(lambda: {"count": 0, "projects": set(), "phraseLength": 0})
    family_anchor_total = Counter()
    family_anchor_positive = Counter()
    family_stats = defaultdict(lambda: defaultdict(lambda: {
        "pos": 0,
        "posProjects": set(),
        "residuals": [],
        "examples": [],
        "nearOtherFamily": 0,
    }))

    for row in candidate_occurrences(records):
        phrase_anchor = (row["phrase"], row["anchorType"])
        project_id = row["projectId"]
        total = total_by_phrase_anchor[phrase_anchor]
        total["count"] += 1
        total["projects"].add(project_id)
        total["phraseLength"] = row["phraseLength"]

        deltas_by_family = {}
        for family in EMITTABLE:
            family_anchor_total[(family, row["anchorType"])] += 1
            delta = nearest_delta(manual_by_project[project_id].get(family, []), row["targetSec"], match_window_sec)
            deltas_by_family[family] = delta
            if delta is None:
                continue
            family_anchor_positive[(family, row["anchorType"])] += 1
            stat = family_stats[family][phrase_anchor]
            stat["pos"] += 1
            stat["posProjects"].add(project_id)
            stat["residuals"].append(delta)
            if len(stat["examples"]) < 4:
                stat["examples"].append({
                    "projectId": project_id,
                    "momentId": row["momentId"],
                    "text": str(row["text"])[:180],
                    "targetSec": row["targetSec"],
                    "deltaSec": delta,
                })

        near_families = sum(1 for delta in deltas_by_family.values() if delta is not None)
        if near_families > 1:
            for family in EMITTABLE:
                if deltas_by_family.get(family) is not None:
                    family_stats[family][phrase_anchor]["nearOtherFamily"] += near_families - 1

    rules_by_phrase_anchor = defaultdict(list)
    rules_by_family = defaultdict(list)
    for family, by_phrase_anchor in family_stats.items():
        for phrase_anchor, stat in by_phrase_anchor.items():
            total = total_by_phrase_anchor[phrase_anchor]
            total_count = total["count"]
            pos = stat["pos"]
            if not total_count or not pos:
                continue
            anchor = phrase_anchor[1]
            background_den = family_anchor_total[(family, anchor)] or 1
            background_rate = family_anchor_positive[(family, anchor)] / background_den
            precision = pos / total_count
            lift = (precision + 0.015) / (background_rate + 0.015)
            pos_projects = len(stat["posProjects"])
            score = (
                2.8 * math.log(max(lift, 0.01))
                + 2.1 * precision
                + 0.50 * math.log1p(pos)
                + 0.30 * pos_projects
                + 0.14 * safe_float(total["phraseLength"])
                - 0.10 * safe_float(stat["nearOtherFamily"])
            )
            rule = {
                "family": family,
                "phrase": phrase_anchor[0],
                "anchorType": anchor,
                "phraseLength": int(total["phraseLength"]),
                "total": total_count,
                "projects": len(total["projects"]),
                "pos": pos,
                "posProjects": pos_projects,
                "precision": precision,
                "backgroundRate": background_rate,
                "lift": lift,
                "offsetSec": bounded_offset(stat["residuals"]),
                "score": score,
                "examples": stat["examples"],
            }
            rules_by_phrase_anchor[phrase_anchor].append(rule)
            rules_by_family[family].append(rule)

    for rules in rules_by_phrase_anchor.values():
        rules.sort(key=lambda rule: (-rule["score"], -rule["pos"], -rule["phraseLength"], rule["family"]))

    return {
        "schemaVersion": 1,
        "modelVersion": "direct-phrase-association-v1",
        "matchWindowSec": match_window_sec,
        "rulesByPhraseAnchor": {f"{phrase}\t{anchor}": rules for (phrase, anchor), rules in rules_by_phrase_anchor.items()},
        "rulesByFamily": dict(rules_by_family),
    }


def rule_passes(rule, policy):
    if rule["family"] not in policy["allowedFamilies"]:
        return False
    return (
        rule["pos"] >= policy["minPos"]
        and rule["posProjects"] >= policy["minProjects"]
        and rule["precision"] >= policy["minPrecision"]
        and rule["lift"] >= policy["minLift"]
        and rule["score"] >= policy["minScore"]
        and rule["phraseLength"] >= policy["minPhraseLength"]
    )


def rule_globally_viable(rule):
    return (
        rule["family"] in EMITTABLE
        and rule["pos"] >= 2
        and rule["posProjects"] >= 1
        and rule["precision"] >= 0.42
        and rule["lift"] >= 0.95
        and rule["score"] >= 0.65
        and rule["phraseLength"] >= 1
    )


def candidate_passes_policy(row, policy):
    evidence = row.get("evidence") or {}
    rule = {
        "family": row["family"],
        "pos": evidence.get("pos", 0),
        "posProjects": evidence.get("posProjects", 0),
        "precision": evidence.get("precision", 0.0),
        "lift": evidence.get("lift", 0.0),
        "score": evidence.get("ruleScore", evidence.get("score", 0.0)),
        "phraseLength": evidence.get("phraseLength", 1),
    }
    return rule_passes(rule, policy)


def filter_candidates_for_policy(candidates, policy):
    return [row for row in candidates if candidate_passes_policy(row, policy)]


def generate_candidates(model, records, fold_id, policy=None):
    rows = []
    rules_by_key = model.get("rulesByPhraseAnchor") or {}
    for row in candidate_occurrences(records):
        key = f"{row['phrase']}\t{row['anchorType']}"
        for rule in rules_by_key.get(key, []):
            if policy is None:
                if not rule_globally_viable(rule):
                    continue
            elif not rule_passes(rule, policy):
                continue
            score = (
                rule["score"]
                + 0.15 * row["boundaryStrength"]
                + (0.35 if row["hasZoom"] and rule["family"] == "pop" else 0.0)
                + (0.12 if row["anchorType"] == "final_word_end" else 0.0)
            )
            rows.append({
                "foldId": fold_id,
                "projectId": row["projectId"],
                "generalizationGroupId": row["generalizationGroupId"],
                "momentId": row["momentId"],
                "beatGroupId": row["beatGroupId"],
                "momentSec": row["momentSec"],
                "text": row["text"],
                "family": rule["family"],
                "targetSec": max(0.0, row["targetSec"] + safe_float(rule["offsetSec"])),
                "selectedTimingOptionId": row["selectedTimingOptionId"],
                "selectedAnchorType": row["anchorType"],
                "evidence": {
                    "score": score,
                    "ruleScore": rule["score"],
                    "phrase": rule["phrase"],
                    "phraseLength": rule["phraseLength"],
                    "pos": rule["pos"],
                    "posProjects": rule["posProjects"],
                    "total": rule["total"],
                    "precision": rule["precision"],
                    "backgroundRate": rule["backgroundRate"],
                    "lift": rule["lift"],
                    "offsetSec": rule["offsetSec"],
                    "boundaryStrength": row["boundaryStrength"],
                    "hasZoom": row["hasZoom"],
                    "examples": rule.get("examples", [])[:2],
                },
            })
    return rows


def project_duration(records):
    return sum(safe_float((record.get("project") or {}).get("durationSec")) for record in records)


def select_rows(candidates, records, policy):
    max_attempts = max(1, int(math.ceil(project_duration(records) / 60.0 * policy["maxPerMinute"])))
    family_caps = {
        family: max(1, int(math.ceil(project_duration(records) / 60.0 * rate)))
        for family, rate in policy.get("familyMaxPerMinute", {}).items()
    }
    selected = []
    family_counts = Counter()
    phrase_times = defaultdict(list)
    family_times = defaultdict(list)
    global_times = defaultdict(list)
    sorted_rows = sorted(
        candidates,
        key=lambda row: (
            -safe_float((row.get("evidence") or {}).get("score")),
            row["projectId"],
            safe_float(row["targetSec"]),
            row["momentId"],
        ),
    )
    for row in sorted_rows:
        if len(selected) >= max_attempts:
            break
        family = row["family"]
        if family_counts[family] >= family_caps.get(family, max_attempts):
            continue
        project_id = row["projectId"]
        target = safe_float(row["targetSec"])
        phrase = (row.get("evidence") or {}).get("phrase", "")
        if any(abs(target - time) < policy["globalNmsSeconds"] for time in global_times[project_id]):
            continue
        if any(abs(target - time) < policy["familyNmsSeconds"] for time in family_times[(project_id, family)]):
            continue
        if phrase and any(abs(target - time) < policy["phraseCooldownSeconds"] for time in phrase_times[(project_id, family, phrase)]):
            continue
        selected.append(row)
        family_counts[family] += 1
        global_times[project_id].append(target)
        family_times[(project_id, family)].append(target)
        if phrase:
            phrase_times[(project_id, family, phrase)].append(target)
    return sorted(selected, key=lambda row: (row["projectId"], safe_float(row["targetSec"]), row["family"]))


def policies():
    family_sets = {
        "positive": ["pop", "ding", "success"],
        "core": ["pop", "ding", "success", "bonk", "funny"],
        "all_caption": ["pop", "ding", "success", "bonk", "funny", "bruh", "record_scratch", "dramatic"],
    }
    base = {
        "globalNmsSeconds": 0.50,
        "familyNmsSeconds": 1.50,
        "phraseCooldownSeconds": 9.0,
        "familyMaxPerMinute": {
            "pop": 3.2,
            "ding": 3.2,
            "success": 1.5,
            "bonk": 1.5,
            "funny": 1.2,
            "bruh": 0.4,
            "record_scratch": 0.4,
            "dramatic": 1.6,
        },
    }
    out = []
    for set_name, families in family_sets.items():
        for name, max_per_minute, min_pos, min_projects, min_precision, min_lift, min_score in [
            ("tight", 2.0, 4, 2, 0.56, 1.25, 2.20),
            ("balanced", 4.0, 3, 2, 0.50, 1.12, 1.55),
            ("wide", 6.0, 2, 1, 0.46, 1.02, 1.00),
            ("aggressive", 8.0, 2, 1, 0.42, 0.95, 0.65),
        ]:
            out.append({
                **base,
                "policyName": f"{set_name}_{name}",
                "allowedFamilies": families,
                "maxPerMinute": max_per_minute,
                "minPos": min_pos,
                "minProjects": min_projects,
                "minPrecision": min_precision,
                "minLift": min_lift,
                "minScore": min_score,
                "minPhraseLength": 1 if name in {"wide", "aggressive"} else 2,
            })
    return out


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


def choose_policy_on_training(records, match_window_sec):
    inner_artifacts = []
    for fold in inner_folds(records):
        if not fold["train"] or not fold["test"]:
            continue
        model = build_direct_phrase_model(fold["train"], match_window_sec)
        inner_artifacts.append({
            "foldId": fold["foldId"],
            "test": fold["test"],
            "candidates": generate_candidates(model, fold["test"], fold["foldId"]),
        })

    policy_reports = []
    for policy in policies():
        emissions = []
        manual_records = []
        for artifact in inner_artifacts:
            candidates = filter_candidates_for_policy(artifact["candidates"], policy)
            emissions.extend(select_rows(candidates, artifact["test"], policy))
            manual_records.extend(artifact["test"])
        metrics = product_metrics(emissions, human_events_for_records(manual_records), match_window_sec)
        key = (
            metrics["netSavedEdits"],
            metrics["matched"],
            -metrics["falseAdditions"],
            -metrics["generatedAttempts"],
        )
        policy_reports.append({
            "policy": policy,
            "metrics": compact_metrics(metrics),
            "choiceKey": key,
        })
    policy_reports.sort(key=lambda item: item["choiceKey"], reverse=True)
    return policy_reports[0], policy_reports


def write_project_csv(path, rows):
    fieldnames = ["foldId", "projectId", "humanTotal", "matched", "generatedAttempts", "falseAdditions", "netSavedEdits"]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fieldnames})


def summarize_model(model, top_n=12):
    return {
        "modelVersion": model["modelVersion"],
        "matchWindowSec": model["matchWindowSec"],
        "ruleCounts": {
            family: len(model.get("rulesByFamily", {}).get(family, []))
            for family in sorted(EMITTABLE)
        },
        "topRules": {
            family: [
                {
                    "phrase": rule["phrase"],
                    "anchorType": rule["anchorType"],
                    "pos": rule["pos"],
                    "total": rule["total"],
                    "posProjects": rule["posProjects"],
                    "precision": round(rule["precision"], 4),
                    "backgroundRate": round(rule["backgroundRate"], 4),
                    "lift": round(rule["lift"], 4),
                    "score": round(rule["score"], 4),
                    "offsetSec": round(rule["offsetSec"], 4),
                }
                for rule in sorted(model.get("rulesByFamily", {}).get(family, []), key=lambda item: (-item["score"], -item["pos"]))[:top_n]
            ]
            for family in sorted(EMITTABLE)
        },
    }


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

    run_id = args.run_id or datetime.now(timezone.utc).strftime("direct-phrase-association-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_emissions = []
    matches = []
    false_additions = []
    false_negatives = []
    per_project_rows = []
    fold_reports = []
    model_summaries = []

    for fold in splits:
        train = [by_project[project_id] for project_id in fold.get("trainProjectIds") or [] if project_id in by_project]
        test = [by_project[project_id] for project_id in fold.get("testProjectIds") or [] if project_id in by_project]
        if not test:
            continue
        policy_choice, policy_reports = choose_policy_on_training(train, args.match_window_sec)
        policy = policy_choice["policy"]
        model = build_direct_phrase_model(train, args.match_window_sec)
        candidates = generate_candidates(model, test, fold.get("foldId", ""))
        policy_candidates = filter_candidates_for_policy(candidates, policy)
        emissions = select_rows(policy_candidates, test, policy)
        manual = human_events_for_records(test)
        metrics = product_metrics(emissions, manual, args.match_window_sec)
        all_emissions.extend(emissions)
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
            "candidateCount": len(candidates),
            "policyCandidateCount": len(policy_candidates),
            "selectedPolicy": policy_choice,
            "policyReports": policy_reports,
            "outerMetrics": compact_metrics(metrics),
            "modelSummary": model_summary,
        })
        print(json.dumps({
            "foldId": fold.get("foldId", ""),
            "testProjectIds": [record["project"]["projectId"] for record in test],
            "policyName": policy["policyName"],
            "matched": metrics["matched"],
            "humanTotal": metrics["humanTotal"],
            "generatedAttempts": metrics["generatedAttempts"],
            "falseAdditions": metrics["falseAdditions"],
            "netSavedEdits": metrics["netSavedEdits"],
        }), flush=True)

    selected_project_ids = sorted({project_id for fold in splits for project_id in fold.get("testProjectIds", []) if project_id in by_project})
    manual = human_events_for_records([by_project[project_id] for project_id in selected_project_ids])
    aggregate = product_metrics(all_emissions, manual, args.match_window_sec)
    report = {
        "schemaVersion": 1,
        "protocol": "direct-phrase-association-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "metricBoundary": "outer-fold-only; direct phrase rules and policy selected from trainProjectIds only",
        "matchWindowSec": args.match_window_sec,
        "summary": compact_metrics(aggregate),
        "promotion": {
            "passes": aggregate["netSavedEdits"] > 0,
            "requiredCondition": "outer/test net saved edits > 0",
        },
        "foldReports": fold_reports,
        "modelSummaries": model_summaries,
    }
    write_json(run_dir / "direct-phrase-association-score.json", report)
    write_jsonl(run_dir / "direct-phrase-association-emissions.jsonl", all_emissions)
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
        "generatedAttempts": aggregate["generatedAttempts"],
        "falseAdditions": aggregate["falseAdditions"],
        "netSavedEdits": aggregate["netSavedEdits"],
        "passes": report["promotion"]["passes"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
