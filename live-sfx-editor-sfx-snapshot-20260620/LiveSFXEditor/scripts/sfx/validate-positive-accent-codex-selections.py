#!/usr/bin/env python3
import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


EDITOR_ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_ID = "footage_06_10_26_sfx"
OPENED_BLIND_CAPTION_ID = "blind_caption_only_06_17_26"
POSITIVE_FAMILIES = {"ding", "success"}


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
    return str(value)


def safe_float(value, default=0.0):
    try:
        if value is None:
            return default
        value = float(value)
        return value if math.isfinite(value) else default
    except Exception:
        return default


def read_jsonl(path):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
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
    return [
        {"time": median(event["time"] for event in beat), "families": sorted({event["family"] for event in beat})}
        for beat in beats
    ]


def manual_positive_counts(corpus_rows, project_ids):
    counts = Counter()
    durations = {}
    requested = set(project_ids)
    for row in corpus_rows:
        project_id = row["project"]["projectId"]
        if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
            raise SystemExit(f"Prohibited project appears in corpus: {project_id}")
        if requested and project_id not in requested:
            continue
        durations[project_id] = safe_float(row["project"].get("durationSec"))
        for beat in cluster_manual_beats(row.get("manualEvents") or []):
            if set(beat["families"]) & POSITIVE_FAMILIES:
                counts[project_id] += 1
    return counts, durations


def load_moment_maps(path):
    by_candidate = {}
    by_moment = {}
    for moment in read_jsonl(path):
        project_id = moment["projectId"]
        if project_id in {HOLDOUT_ID, OPENED_BLIND_CAPTION_ID}:
            raise SystemExit(f"Prohibited project appears in moments: {project_id}")
        by_moment[moment["momentId"]] = moment
        for candidate in moment.get("candidateOptions") or []:
            candidate_id = candidate.get("candidateId")
            if candidate_id:
                by_candidate[candidate_id] = moment
    return by_candidate, by_moment


def iter_packet_files(packets_root):
    root = Path(packets_root)
    if root.is_file():
        yield root
        return
    packets_dir = root / "packets"
    if packets_dir.exists():
        yield from sorted(packets_dir.glob("*.json"))
    else:
        yield from sorted(root.glob("*.json"))


def selection_path_for_packet(packet_path, selections_root):
    base = Path(packet_path).stem
    root = Path(selections_root)
    candidates = [
        root / f"{base}.selection.json",
        root / f"{base}.json",
        root / f"{base}.out.json",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def caption_context(packet, candidate_id):
    candidate = next((row for row in packet.get("candidates", []) if row.get("candidateId") == candidate_id), {})
    cue_ids = set(candidate.get("cueIds") or [])
    lines = []
    for cue in packet.get("cues") or []:
        prefix = ">" if cue.get("cueId") in cue_ids else " "
        lines.append(f"{prefix} [{cue.get('startSec')}] {cue.get('speakerKey')}: {cue.get('text')}")
    return "\n".join(lines)


def validate_selection_object(selection):
    if not isinstance(selection, dict):
        return "selection is not an object"
    forbidden = {"timestamp", "targetSec", "targetFrame", "time", "confidence", "score"}
    overlap = sorted(forbidden & set(selection))
    if overlap:
        return f"forbidden fields present: {', '.join(overlap)}"
    if not isinstance(selection.get("candidateId"), str) or not selection["candidateId"]:
        return "candidateId missing"
    if selection.get("family") not in {"ding", "success"}:
        return "family must be ding or success"
    if not isinstance(selection.get("momentType"), str) or not selection["momentType"]:
        return "momentType missing"
    return ""


def validate_outputs(packet_files, selections_root, by_candidate):
    valid_rows = []
    invalid_rows = []
    missing_outputs = []
    model_errors = 0
    for packet_path in packet_files:
        packet = read_json(packet_path)
        allowed = set(packet.get("allowedCandidateIds") or [])
        output_path = selection_path_for_packet(packet_path, selections_root)
        if not output_path.exists():
            missing_outputs.append({"packetPath": str(packet_path), "expectedOutputPath": str(output_path)})
            model_errors += 1
            continue
        try:
            output = read_json(output_path)
        except Exception as exc:
            invalid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "reason": f"invalid json: {exc}",
            })
            model_errors += 1
            continue
        if output.get("segmentId") != packet.get("segmentId"):
            invalid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "reason": "segmentId mismatch",
                "expectedSegmentId": packet.get("segmentId"),
                "actualSegmentId": output.get("segmentId"),
            })
            model_errors += 1
            continue
        seen = set()
        for selection in output.get("selections") or []:
            error = validate_selection_object(selection)
            candidate_id = selection.get("candidateId") if isinstance(selection, dict) else ""
            if not error and candidate_id not in allowed:
                error = "candidateId not in packet allow-list"
            if not error and candidate_id in seen:
                error = "duplicate candidateId"
            if error:
                invalid_rows.append({
                    "packetPath": str(packet_path),
                    "outputPath": str(output_path),
                    "segmentId": packet.get("segmentId"),
                    "candidateId": candidate_id,
                    "reason": error,
                })
                continue
            seen.add(candidate_id)
            moment = by_candidate.get(candidate_id)
            if not moment:
                invalid_rows.append({
                    "packetPath": str(packet_path),
                    "outputPath": str(output_path),
                    "segmentId": packet.get("segmentId"),
                    "candidateId": candidate_id,
                    "reason": "candidateId not found in moments map",
                })
                continue
            label = moment.get("label") or {}
            manual_families = label.get("manualFamilies") or []
            selected_family = selection["family"]
            matched = label.get("kind") == "positive"
            exact_family = matched and selected_family in manual_families
            valid_rows.append({
                "packetPath": str(packet_path),
                "outputPath": str(output_path),
                "foldId": packet.get("foldId"),
                "projectId": packet.get("projectId"),
                "segmentId": packet.get("segmentId"),
                "candidateId": candidate_id,
                "momentId": moment.get("momentId"),
                "beatGroupId": moment.get("beatGroupId"),
                "targetSec": safe_float(moment.get("targetSec")),
                "family": selected_family,
                "momentType": selection.get("momentType"),
                "labelKind": label.get("kind"),
                "labelFamilies": manual_families,
                "labelSubtype": label.get("subtype"),
                "combinedMatched": matched,
                "exactFamilyMatched": exact_family,
                "captionContext": caption_context(packet, candidate_id),
            })
    return valid_rows, invalid_rows, missing_outputs, model_errors


def load_ranker_scores(path):
    if not path:
        return {}
    scores = {}
    for row in read_jsonl(path):
        moment_id = row.get("momentId")
        if not moment_id:
            continue
        scores[moment_id] = safe_float(row.get("score"), None)
    return scores


def apply_ranker_filter(rows, ranker_scores, min_score):
    if min_score is None:
        return rows, []
    kept = []
    filtered = []
    for row in rows:
        score = ranker_scores.get(row["momentId"])
        row = {**row, "rankerScore": score}
        if score is not None and score >= min_score:
            kept.append(row)
        else:
            filtered.append(row)
    return kept, filtered


def score_rows(rows, manual_counts, durations):
    manual_total = sum(manual_counts.values())
    generated = len(rows)
    matched = sum(1 for row in rows if row["combinedMatched"])
    exact = sum(1 for row in rows if row["exactFamilyMatched"])
    wrong = generated - matched
    duration_minutes = sum(durations.get(project_id, 0) for project_id in manual_counts) / 60.0
    by_project = defaultdict(list)
    for row in rows:
        by_project[row["projectId"]].append(row)
    project_rows = []
    coverages = []
    positive_net = 0
    for project_id, manual in sorted(manual_counts.items()):
        project_selected = by_project.get(project_id, [])
        project_generated = len(project_selected)
        project_matched = sum(1 for row in project_selected if row["combinedMatched"])
        project_exact = sum(1 for row in project_selected if row["exactFamilyMatched"])
        project_wrong = project_generated - project_matched
        net = project_matched - project_wrong
        coverage = project_matched / manual if manual else None
        if coverage is not None:
            coverages.append(coverage)
        if net > 0:
            positive_net += 1
        project_rows.append({
            "projectId": project_id,
            "manualPositive": manual,
            "generated": project_generated,
            "combinedMatched": project_matched,
            "exactFamilyMatched": project_exact,
            "combinedCoverage": coverage,
            "exactFamilyCoverage": project_exact / manual if manual else None,
            "precision": project_matched / project_generated if project_generated else None,
            "falseAdditions": project_wrong,
            "netSavedEdits": net,
        })
    return {
        "manualPositive": manual_total,
        "generated": generated,
        "combinedMatched": matched,
        "exactFamilyMatched": exact,
        "combinedCoverage": matched / manual_total if manual_total else None,
        "exactFamilyCoverage": exact / manual_total if manual_total else None,
        "precision": matched / generated if generated else None,
        "falseAdditions": wrong,
        "falseAdditionsPerMinute": wrong / duration_minutes if duration_minutes else None,
        "netSavedEdits": matched - wrong,
        "medianProjectCoverage": float(np.median(coverages)) if coverages else None,
        "positiveNetProjectFraction": positive_net / len(project_rows) if project_rows else None,
        "projectRows": project_rows,
    }


def gate_passed(metrics, partial):
    if partial:
        return False
    return (
        (metrics.get("combinedCoverage") or 0) >= 0.20
        and (metrics.get("precision") or 0) >= 0.70
        and (metrics.get("falseAdditionsPerMinute") or float("inf")) <= 0.50
        and (metrics.get("netSavedEdits") or 0) > 0
        and (metrics.get("medianProjectCoverage") or 0) >= 0.15
        and (metrics.get("positiveNetProjectFraction") or 0) >= 0.75
    )


def write_project_csv(path, rows):
    fields = [
        "projectId", "manualPositive", "generated", "combinedMatched", "exactFamilyMatched",
        "combinedCoverage", "exactFamilyCoverage", "precision", "falseAdditions", "netSavedEdits",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_false_audit_csv(path, rows):
    fields = ["projectId", "segmentId", "candidateId", "family", "momentType", "labelKind", "labelFamilies", "targetSec", "captionContext"]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            if row["combinedMatched"]:
                continue
            writer.writerow({field: row.get(field) for field in fields})


def markdown_report(report):
    m = report["metrics"]
    partial_line = "This is a partial diagnostic run, not a product score." if report["partialEvaluation"] else "This is a full packet run for the evaluated projects."
    ranker = report.get("rankerFilter") or {}
    ranker_line = (
        f"- Ranker filter: enabled, score >= {ranker.get('scoreMin')}, filtered selections: {ranker.get('filteredSelectionCount')}"
        if ranker.get("enabled")
        else "- Ranker filter: disabled"
    )
    return "\n".join([
        "# Positive Accent Codex Selector Validation",
        "",
        partial_line,
        "",
        ranker_line,
        f"- Product score: {m['combinedMatched']}/{m['manualPositive']} human ding/success placements found",
        f"- Exact family score: {m['exactFamilyMatched']}/{m['manualPositive']}",
        f"- Generated attempts: {m['generated']}",
        f"- Precision: {m['precision']}",
        f"- False additions: {m['falseAdditions']}",
        f"- False additions per minute: {m['falseAdditionsPerMinute']}",
        f"- Net saved edits: {m['netSavedEdits']}",
        f"- Median project coverage: {m['medianProjectCoverage']}",
        f"- Positive net project fraction: {m['positiveNetProjectFraction']}",
        f"- Product materialization gate passed: {report['productMaterializationGatePassed']}",
        "",
    ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets-root", required=True)
    parser.add_argument("--selections-root", required=True)
    parser.add_argument("--moments", default=str(EDITOR_ROOT / "data/sfx-automation-v2/positive-accent-moments.jsonl"))
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v2/visible-caption-corpus.jsonl"))
    parser.add_argument("--out-root", default=str(EDITOR_ROOT / "validation/runs"))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--ranker-predictions", default="")
    parser.add_argument("--ranker-score-min", type=float, default=None)
    args = parser.parse_args()

    packet_files = list(iter_packet_files(args.packets_root))
    if not packet_files:
        raise SystemExit(f"No packet files found under {args.packets_root}")
    manifest_path = Path(args.packets_root) / "selector-packet-manifest.json"
    packet_manifest = read_json(manifest_path) if manifest_path.exists() else {}
    by_candidate, _by_moment = load_moment_maps(args.moments)
    valid_rows, invalid_rows, missing_outputs, model_errors = validate_outputs(packet_files, args.selections_root, by_candidate)
    ranker_scores = load_ranker_scores(args.ranker_predictions)
    valid_rows, ranker_filtered_rows = apply_ranker_filter(valid_rows, ranker_scores, args.ranker_score_min)
    project_ids = sorted({read_json(path).get("projectId") for path in packet_files})
    corpus_rows = read_jsonl(args.corpus)
    manual_counts, durations = manual_positive_counts(corpus_rows, project_ids)
    metrics = score_rows(valid_rows, manual_counts, durations)
    partial = bool(packet_manifest.get("limited")) or bool(missing_outputs)
    passed = gate_passed(metrics, partial)

    run_id = args.run_id or datetime.now(timezone.utc).strftime("positive-accent-codex-selector-%Y%m%dT%H%M%SZ")
    run_dir = Path(args.out_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "protocol": "positive-accent-codex-selector-validation-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "packetsRoot": str(args.packets_root),
        "selectionsRoot": str(args.selections_root),
        "packetCount": len(packet_files),
        "selectionOutputCount": len(packet_files) - len(missing_outputs),
        "partialEvaluation": partial,
        "lockedFinalHoldout": HOLDOUT_ID,
        "openedBlindVideoExcluded": True,
        "metrics": {key: value for key, value in metrics.items() if key != "projectRows"},
        "modelErrors": model_errors,
        "invalidSelectionCount": len(invalid_rows),
        "missingOutputCount": len(missing_outputs),
        "rankerFilter": {
            "enabled": args.ranker_score_min is not None,
            "predictionsPath": args.ranker_predictions or None,
            "scoreMin": args.ranker_score_min,
            "filteredSelectionCount": len(ranker_filtered_rows),
        },
        "productMaterializationGatePassed": passed,
        "gate": {
            "combinedCoverageMin": 0.20,
            "precisionMin": 0.70,
            "falseAdditionsPerMinuteMax": 0.50,
            "netSavedEditsMinExclusive": 0,
            "medianProjectCoverageMin": 0.15,
            "positiveNetProjectFractionMin": 0.75,
        },
    }
    write_json(run_dir / "positive-accent-codex-selector-validation-report.json", report)
    (run_dir / "positive-accent-codex-selector-validation-report.md").write_text(markdown_report(report), encoding="utf-8")
    write_jsonl(run_dir / "positive-accent-codex-selector-valid-selections.jsonl", valid_rows)
    write_jsonl(run_dir / "positive-accent-codex-selector-ranker-filtered-selections.jsonl", ranker_filtered_rows)
    write_jsonl(run_dir / "positive-accent-codex-selector-invalid-selections.jsonl", invalid_rows)
    write_json(run_dir / "positive-accent-codex-selector-missing-outputs.json", missing_outputs)
    write_project_csv(run_dir / "per-project-positive-accent-codex-selector-metrics.csv", metrics["projectRows"])
    write_false_audit_csv(run_dir / "false-addition-audit.csv", valid_rows)
    print(json.dumps({
        "runDir": str(run_dir),
        "productScore": f"{metrics['combinedMatched']}/{metrics['manualPositive']}",
        "generated": metrics["generated"],
        "precision": metrics["precision"],
        "falseAdditions": metrics["falseAdditions"],
        "netSavedEdits": metrics["netSavedEdits"],
        "medianProjectCoverage": metrics["medianProjectCoverage"],
        "partialEvaluation": partial,
        "productMaterializationGatePassed": passed,
    }, indent=2))


if __name__ == "__main__":
    main()
