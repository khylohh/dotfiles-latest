#!/usr/bin/env python3
import argparse
import csv
import importlib.util
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
OPENED_BLIND_CAPTION_ID = "blind_caption_only_06_17_26"
POSITIVE_FAMILIES = {"ding", "success"}


def load_trainer():
    path = EDITOR_ROOT / "scripts/sfx/train-caption-beat-model.py"
    spec = importlib.util.spec_from_file_location("caption_trainer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trainer = load_trainer()


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


def round_value(value, places=6):
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(numeric, places)


def category_family(value):
    family = str(value or "").strip().lower()
    if family.startswith("manual:"):
        family = family.split(":", 1)[1]
    return re.sub(r"[^a-z0-9]+", "_", family).strip("_")


def load_corpus(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            project_id = row["project"]["projectId"]
            if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
                raise SystemExit(f"Refusing oracle analysis because prohibited project appears in corpus: {project_id}")
            rows.append(row)
    return rows


def cluster_manual_beats(events):
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
        families = sorted({event["family"] for event in beat["events"]})
        beat["id"] = f"manual_beat_{index + 1}"
        beat["time"] = float(np.median(times))
        beat["families"] = families
        beat["positiveAccent"] = bool(POSITIVE_FAMILIES & set(families))
    return beats


def best_candidate_for_beat(beat, candidates):
    nearby = []
    for candidate in candidates:
        delta = safe_float(candidate["targetSec"]) - beat["time"]
        if abs(delta) <= 0.750:
            cost = trainer.assignment_cost(candidate, beat)
            nearby.append({
                "candidate": candidate,
                "delta": delta,
                "absDelta": abs(delta),
                "cost": cost,
            })
    nearby.sort(key=lambda item: (item["cost"], item["absDelta"], item["candidate"]["id"]))
    best = nearby[0] if nearby else None
    margin = None
    if best:
        distinct = [
            item["cost"]
            for item in nearby[1:]
            if item["candidate"].get("beatGroupId") != best["candidate"].get("beatGroupId")
        ]
        margin = (distinct[0] - best["cost"]) if distinct else 999.0
    return nearby, best, margin


def beat_family_bucket(families):
    family_set = set(families)
    if "ding" in family_set and "success" in family_set:
        return "ding+success"
    if "ding" in family_set:
        return "ding"
    if "success" in family_set:
        return "success"
    return "other"


def empty_metrics():
    return {
        "manualPositive": 0,
        "anyCandidateWithin075": 0,
        "anyCandidateWithin050": 0,
        "strongCandidate": 0,
        "medianBestAbsDeltaSec": None,
        "medianBestCost": None,
        "bestAnchorTypes": Counter(),
    }


def finalize_metrics(raw):
    out = dict(raw)
    manual = raw["manualPositive"]
    out["coverage075"] = raw["anyCandidateWithin075"] / manual if manual else None
    out["coverage050"] = raw["anyCandidateWithin050"] / manual if manual else None
    out["strongCoverage"] = raw["strongCandidate"] / manual if manual else None
    out["bestAnchorTypes"] = dict(raw["bestAnchorTypes"])
    return out


def analyze(rows, manifest_by_id):
    totals = empty_metrics()
    by_project = defaultdict(empty_metrics)
    by_family = defaultdict(empty_metrics)
    beat_rows = []
    for row in rows:
        if not row.get("trainEligible"):
            continue
        project_id = row["project"]["projectId"]
        generalization_group_id = manifest_by_id.get(project_id, {}).get("generalizationGroupId", project_id)
        candidates = row.get("candidates") or []
        beats = [beat for beat in cluster_manual_beats(row.get("manualEvents") or []) if beat["positiveAccent"]]
        for beat in beats:
            nearby, best, margin = best_candidate_for_beat(beat, candidates)
            family_bucket = beat_family_bucket(beat["families"])
            metrics = [totals, by_project[project_id], by_family[family_bucket]]
            for metric in metrics:
                metric["manualPositive"] += 1
                if best:
                    metric.setdefault("_bestAbsDeltas", []).append(best["absDelta"])
                    metric.setdefault("_bestCosts", []).append(best["cost"])
                    best_anchor = "|".join(best["candidate"].get("anchorTypes") or [])
                    metric["bestAnchorTypes"][best_anchor or "unknown"] += 1
                if nearby:
                    metric["anyCandidateWithin075"] += 1
                if any(item["absDelta"] <= 0.500 for item in nearby):
                    metric["anyCandidateWithin050"] += 1
                if best and best["absDelta"] <= 0.500 and best["cost"] <= 0.550 and (margin is None or margin >= 0.100):
                    metric["strongCandidate"] += 1
            beat_rows.append({
                "projectId": project_id,
                "generalizationGroupId": generalization_group_id,
                "beatId": beat["id"],
                "manualTime": round_value(beat["time"]),
                "manualFamilies": beat["families"],
                "familyBucket": family_bucket,
                "candidateCountWithin075": len(nearby),
                "hasCandidateWithin075": bool(nearby),
                "hasCandidateWithin050": any(item["absDelta"] <= 0.500 for item in nearby),
                "hasStrongCandidate": bool(best and best["absDelta"] <= 0.500 and best["cost"] <= 0.550 and (margin is None or margin >= 0.100)),
                "bestCandidateId": best["candidate"]["id"] if best else "",
                "bestBeatGroupId": best["candidate"].get("beatGroupId", "") if best else "",
                "bestTargetSec": round_value(best["candidate"]["targetSec"]) if best else None,
                "bestAbsDeltaSec": round_value(best["absDelta"]) if best else None,
                "bestDeltaSec": round_value(best["delta"]) if best else None,
                "bestAssignmentCost": round_value(best["cost"]) if best else None,
                "bestAssignmentMargin": round_value(margin) if margin is not None else None,
                "bestAnchorTypes": best["candidate"].get("anchorTypes", []) if best else [],
                "bestText": best["candidate"].get("text", "") if best else "",
            })
    for metric in [totals, *by_project.values(), *by_family.values()]:
        deltas = metric.pop("_bestAbsDeltas", [])
        costs = metric.pop("_bestCosts", [])
        metric["medianBestAbsDeltaSec"] = float(np.median(deltas)) if deltas else None
        metric["medianBestCost"] = float(np.median(costs)) if costs else None
    return totals, by_project, by_family, beat_rows


def write_project_csv(path, by_project, manifest_by_id):
    fieldnames = [
        "projectId", "generalizationGroupId", "manualPositive",
        "anyCandidateWithin075", "coverage075",
        "anyCandidateWithin050", "coverage050",
        "strongCandidate", "strongCoverage",
        "medianBestAbsDeltaSec", "medianBestCost",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for project_id in sorted(by_project):
            row = finalize_metrics(by_project[project_id])
            writer.writerow({
                "projectId": project_id,
                "generalizationGroupId": manifest_by_id.get(project_id, {}).get("generalizationGroupId", project_id),
                **{key: row.get(key) for key in fieldnames if key not in {"projectId", "generalizationGroupId"}},
            })


def write_family_csv(path, by_family):
    fieldnames = [
        "familyBucket", "manualPositive",
        "anyCandidateWithin075", "coverage075",
        "anyCandidateWithin050", "coverage050",
        "strongCandidate", "strongCoverage",
        "medianBestAbsDeltaSec", "medianBestCost",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for family in sorted(by_family):
            row = finalize_metrics(by_family[family])
            writer.writerow({"familyBucket": family, **{key: row.get(key) for key in fieldnames if key != "familyBucket"}})


def report_markdown(report):
    total = report["overall"]
    lines = [
        "# Positive Accent Candidate Oracle",
        "",
        "This measures whether the candidate generator gives a future selector a chance to hit human ding/success placements.",
        "",
        f"- Human ding/success beats: {total['manualPositive']}",
        f"- Any caption candidate within 0.75s: {total['anyCandidateWithin075']}/{total['manualPositive']} ({total['coverage075']:.3f})",
        f"- Any caption candidate within 0.50s: {total['anyCandidateWithin050']}/{total['manualPositive']} ({total['coverage050']:.3f})",
        f"- Strong candidate by current assignment heuristic: {total['strongCandidate']}/{total['manualPositive']} ({total['strongCoverage']:.3f})",
        f"- Median best absolute timing error: {total['medianBestAbsDeltaSec']}",
        "",
        "## Verdict",
        "",
    ]
    if total["coverage075"] is not None and total["coverage075"] >= 0.75:
        lines.append("Candidate generation is probably not the main blocker. Selection/editorial judgment is the blocker.")
    elif total["coverage075"] is not None and total["coverage075"] < 0.60:
        lines.append("Candidate generation is a major blocker. Fix anchors before building a stronger selector.")
    else:
        lines.append("Candidate generation is mixed. Inspect per-project gaps before freezing anchors.")
    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--project-manifest", default=str(EDITOR_ROOT / "validation/project-manifest-v1.json"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    rows = load_corpus(args.corpus)
    manifest = read_json(args.project_manifest)
    manifest_by_id = {project["projectId"]: project for project in manifest["projects"]}
    run_id = args.run_id or datetime.now(timezone.utc).strftime("positive-accent-oracle-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    totals, by_project, by_family, beat_rows = analyze(rows, manifest_by_id)
    report = {
        "protocol": "positive-accent-candidate-oracle-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "lockedFinalHoldout": HOLDOUT_ID,
        "openedBlindVideoExcluded": True,
        "overall": finalize_metrics(totals),
        "byFamily": {family: finalize_metrics(metric) for family, metric in sorted(by_family.items())},
    }
    write_json(run_dir / "positive-accent-candidate-oracle.json", report)
    (run_dir / "positive-accent-candidate-oracle.md").write_text(report_markdown(report), encoding="utf-8")
    write_project_csv(run_dir / "positive-accent-candidate-oracle-by-project.csv", by_project, manifest_by_id)
    write_family_csv(run_dir / "positive-accent-candidate-oracle-by-family.csv", by_family)
    write_jsonl(run_dir / "positive-accent-candidate-oracle-beats.jsonl", beat_rows)
    print(json.dumps({
        "runDir": str(run_dir),
        "manualPositive": report["overall"]["manualPositive"],
        "coverage075": report["overall"]["coverage075"],
        "coverage050": report["overall"]["coverage050"],
        "strongCoverage": report["overall"]["strongCoverage"],
        "verdict": "selection_blocker" if report["overall"]["coverage075"] >= 0.75 else "candidate_blocker_or_mixed",
    }, indent=2))


if __name__ == "__main__":
    main()
