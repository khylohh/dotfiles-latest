#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from caption_moment_router_model import (
    EMITTABLE,
    load_corpus,
    product_metrics,
    safe_float,
    training_records,
    human_events_for_records,
    write_json,
    write_jsonl,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def decision_path_for_packet(packet_path, decisions_root):
    root = Path(decisions_root)
    base = Path(packet_path).stem
    candidates = [
        root / f"{base}.decision.json",
        root / f"{base}.json",
        root / f"{base}.selection.json",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def load_manifest(root):
    path = Path(root) / "editorial-sfx-packet-manifest.json"
    if not path.exists():
        raise SystemExit(f"Missing packet manifest: {path}")
    return read_json(path)


def forbidden_fields(decision):
    forbidden = {"timestamp", "time", "targetSec", "targetFrame", "confidence", "score", "probability"}
    return sorted(forbidden & set(decision))


def packet_index(packet):
    moments = {}
    timing_by_moment = {}
    allowed_by_moment = {}
    for candidate in packet.get("candidates") or []:
        moment_id = candidate.get("momentId")
        if not moment_id:
            continue
        moments[moment_id] = candidate
        allowed_by_moment[moment_id] = set(candidate.get("allowedFamilies") or [])
        timing_by_moment[moment_id] = {
            option.get("timingOptionId"): option
            for option in candidate.get("timingOptions") or []
            if option.get("timingOptionId")
        }
    return moments, timing_by_moment, allowed_by_moment


def validate_and_decode(packet_path, decisions_root):
    packet = read_json(packet_path)
    decision_path = decision_path_for_packet(packet_path, decisions_root)
    invalid = []
    blockers = []
    generated = []
    if not decision_path.exists():
        return generated, blockers, [{
            "packetPath": str(packet_path),
            "reason": "missing decision output",
            "expectedDecisionPath": str(decision_path),
        }]
    try:
        output = read_json(decision_path)
    except Exception as exc:
        return generated, blockers, [{
            "packetPath": str(packet_path),
            "decisionPath": str(decision_path),
            "reason": f"invalid json: {exc}",
        }]
    if output.get("segmentId") != packet.get("segmentId"):
        invalid.append({
            "packetPath": str(packet_path),
            "decisionPath": str(decision_path),
            "reason": "segmentId mismatch",
            "expectedSegmentId": packet.get("segmentId"),
            "actualSegmentId": output.get("segmentId"),
        })
        return generated, blockers, invalid
    moments, timing_by_moment, allowed_by_moment = packet_index(packet)
    seen = set()
    for decision in output.get("decisions") or []:
        if not isinstance(decision, dict):
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "reason": "decision is not object"})
            continue
        bad_fields = forbidden_fields(decision)
        moment_id = decision.get("momentId", "")
        family = decision.get("family", "")
        timing_option_id = decision.get("timingOptionId", "")
        if bad_fields:
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "reason": f"forbidden fields: {', '.join(bad_fields)}"})
            continue
        if moment_id not in moments:
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "reason": "momentId not in packet allow-list"})
            continue
        if moment_id in seen:
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "reason": "duplicate moment decision"})
            continue
        seen.add(moment_id)
        if family not in allowed_by_moment.get(moment_id, set()):
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "family": family, "reason": "family not allowed for this candidate"})
            continue
        if family == "other_sfx":
            blockers.append({
                "projectId": packet.get("projectId"),
                "segmentId": packet.get("segmentId"),
                "momentId": moment_id,
                "family": family,
                "reasonCode": decision.get("reasonCode", ""),
            })
            continue
        if family not in EMITTABLE:
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "family": family, "reason": "family is not emittable or other_sfx"})
            continue
        option = timing_by_moment.get(moment_id, {}).get(timing_option_id)
        if not option:
            invalid.append({"packetPath": str(packet_path), "decisionPath": str(decision_path), "momentId": moment_id, "timingOptionId": timing_option_id, "reason": "timingOptionId not valid for moment"})
            continue
        generated.append({
            "projectId": packet.get("projectId"),
            "generalizationGroupId": packet.get("generalizationGroupId", ""),
            "segmentId": packet.get("segmentId"),
            "momentId": moment_id,
            "family": family,
            "targetSec": safe_float(option.get("targetSec")),
            "selectedTimingOptionId": timing_option_id,
            "selectedAnchorType": option.get("anchorType", ""),
            "reasonCode": decision.get("reasonCode", ""),
        })
    return generated, blockers, invalid


def apply_nms(rows, seconds):
    if seconds <= 0:
        return rows, []
    selected = []
    suppressed = []
    for row in sorted(rows, key=lambda item: (item["projectId"], safe_float(item["targetSec"]), item["momentId"], item["family"])):
        if any(
            existing["projectId"] == row["projectId"]
            and abs(safe_float(existing["targetSec"]) - safe_float(row["targetSec"])) < seconds
            for existing in selected
        ):
            suppressed.append(row)
        else:
            selected.append(row)
    return selected, suppressed


def compact_metrics(metrics):
    return {key: value for key, value in metrics.items() if key not in {"matches", "falseAdditionsRows", "falseNegativesRows"}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets-root", required=True)
    parser.add_argument("--decisions-root", required=True)
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--out", required=True)
    parser.add_argument("--nms-seconds", type=float, default=0.30)
    args = parser.parse_args()

    manifest = load_manifest(args.packets_root)
    packet_paths = [Path(row["path"]) for row in manifest.get("packets") or []]
    all_generated = []
    blockers = []
    invalid = []
    for packet_path in packet_paths:
        generated, packet_blockers, packet_invalid = validate_and_decode(packet_path, args.decisions_root)
        all_generated.extend(generated)
        blockers.extend(packet_blockers)
        invalid.extend(packet_invalid)

    generated, suppressed = apply_nms(all_generated, args.nms_seconds)
    project_ids = sorted({packet.get("projectId") for packet in manifest.get("packets") or [] if packet.get("projectId")})
    records_by_project = {record["project"]["projectId"]: record for record in training_records(load_corpus(args.corpus))}
    test_records = [records_by_project[project_id] for project_id in project_ids if project_id in records_by_project]
    manual = human_events_for_records(test_records)
    metrics = product_metrics(generated, manual)
    report = {
        "schemaVersion": 1,
        "protocol": "editorial-sfx-selector-v1-product-score",
        "evaluationKind": "outer_grouped_packet_decisions",
        "metricBoundary": manifest.get("metricBoundary", ""),
        "packetsRoot": str(Path(args.packets_root).resolve()),
        "decisionsRoot": str(Path(args.decisions_root).resolve()),
        "projectIds": project_ids,
        "summary": compact_metrics(metrics),
        "blockerCount": len(blockers),
        "invalidDecisionCount": len(invalid),
        "nmsSuppressedCount": len(suppressed),
        "promotion": {
            "passes": metrics["netSavedEdits"] > 0 and not invalid,
            "requiredCondition": "net saved edits > 0 with zero invalid decisions",
        },
        "matches": metrics["matches"],
        "falseAdditions": metrics["falseAdditionsRows"],
        "falseNegatives": metrics["falseNegativesRows"],
    }
    out_path = Path(args.out)
    write_json(out_path, report)
    write_jsonl(out_path.with_name("editorial-sfx-generated.jsonl"), generated)
    write_jsonl(out_path.with_name("editorial-sfx-blockers.jsonl"), blockers)
    write_jsonl(out_path.with_name("editorial-sfx-invalid.jsonl"), invalid)
    write_jsonl(out_path.with_name("editorial-sfx-nms-suppressed.jsonl"), suppressed)
    print(json.dumps({
        "out": str(out_path),
        "matched": metrics["matched"],
        "humanTotal": metrics["humanTotal"],
        "generatedAttempts": metrics["generatedAttempts"],
        "falseAdditions": metrics["falseAdditions"],
        "netSavedEdits": metrics["netSavedEdits"],
        "blockerCount": len(blockers),
        "invalidDecisionCount": len(invalid),
        "passes": report["promotion"]["passes"],
    }, indent=2))


if __name__ == "__main__":
    main()
