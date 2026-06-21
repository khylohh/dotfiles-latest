#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from caption_moment_router_model import (
    CLASSES,
    EMITTABLE,
    assign_project_moment_labels,
    load_corpus,
    safe_float,
    training_records,
    write_json,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_SPLITS = EDITOR_ROOT / "validation/outer-splits-v1.json"
DEFAULT_OUT_ROOT = EDITOR_ROOT / "validation/editorial-sfx-packets"
PROTOCOL = "editorial-sfx-selector-v1"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def round_float(value, places=3):
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(numeric, places)


def tokenize(text):
    return re.findall(r"[a-z0-9']+", str(text or "").lower())


def token_counter(text):
    return Counter(tokenize(text))


def cosine(left, right):
    if not left or not right:
        return 0.0
    overlap = sum(min(left[key], right[key]) for key in left.keys() & right.keys())
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    return overlap / (left_norm * right_norm) if left_norm and right_norm else 0.0


def option_summary(moment, option, core_start):
    parent = option.get("parentFeatures") or {}
    return {
        "timingOptionId": option.get("optionId", ""),
        "targetSec": round_float(option.get("targetSec")),
        "relativeSec": round_float(safe_float(option.get("targetSec")) - core_start),
        "anchorType": option.get("anchorType", ""),
        "source": option.get("source", ""),
        "cueIds": option.get("cueIds") or [],
        "wordIds": option.get("wordIds") or [],
        "zoomMarkerIds": option.get("zoomMarkerIds") or [],
        "boundaryStrength": round_float(parent.get("boundaryStrength")),
        "wordTimingAvailable": bool(parent.get("wordTimingAvailable")),
    }


def text_blob(moment):
    return f"{moment.get('text', '')}\n{moment.get('captionWindow', '')}".lower()


def has_any(patterns, value):
    return any(re.search(pattern, value) for pattern in patterns)


def family_gate(moment):
    text = text_blob(moment)
    options = moment.get("timingOptions") or []
    allowed = set()
    reasons = []

    has_zoom_onset = any(
        option.get("anchorType") == "zoom_onset" and option.get("zoomMarkerIds")
        for option in options
    )
    if has_zoom_onset:
        allowed.add("pop")
        reasons.append("explicit_zoom_onset")

    if has_any([
        r"\bthere (it|we) (is|are)\b",
        r"\bfound (it|one|the|a)\b",
        r"\bgot (it|one|the|a)\b",
        r"\bexactly\b",
        r"\bcorrect\b",
        r"\bright answer\b",
        r"\bthe answer\b",
        r"\bthat'?s (it|the one|right|correct)\b",
        r"\b\d+(\.\d+)?\b",
        r"\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) one\b",
    ], text):
        allowed.add("ding")
        reasons.append("specific_reveal_or_answer")

    if has_any([
        r"\b(done|finished|completed|complete)\b",
        r"\bwe (did it|made it|won|passed)\b",
        r"\bi (did it|made it|won|passed)\b",
        r"\b(success|successful|solved|fixed|works|worked)\b",
        r"\bfinally\b",
    ], text):
        allowed.add("success")
        reasons.append("completed_result")

    if has_any([
        r"\b(wrong|mistake|failed|fail|failure|broke|broken|lost|dead|died)\b",
        r"\b(can'?t|cannot|couldn'?t|shouldn'?t|wouldn'?t)\b",
        r"\b(no|nope|nah)\b.{0,24}\b(wrong|bad|failed|work)\b",
    ], text):
        allowed.add("bonk")
        reasons.append("mistake_or_fail")

    if has_any([
        r"\b(funny|joke|joking|laugh|laughed|hilarious|ridiculous|absurd)\b",
        r"\bwhat (is|was) that\b",
    ], text):
        allowed.add("funny")
        reasons.append("explicit_comedy")

    if has_any([
        r"\b(bruh|bro what|come on|seriously|are you kidding)\b",
        r"\bwhat the (heck|hell)\b",
    ], text):
        allowed.add("bruh")
        reasons.append("disbelief_or_cringe")

    if has_any([
        r"\b(wait|hold on|actually|plot twist)\b",
        r"\bbut then\b",
        r"\bexcept\b",
        r"\bnot anymore\b",
        r"\bsuddenly\b",
    ], text):
        allowed.add("record_scratch")
        reasons.append("abrupt_reversal")

    if has_any([
        r"\b(scary|terrifying|horror|danger|dangerous|ominous|dramatic)\b",
        r"\b(monster|ghost|demon|death|murder|killer)\b",
        r"\bboom\b",
    ], text):
        allowed.add("dramatic")
        reasons.append("dramatic_reveal")

    if allowed:
        allowed.add("other_sfx")
    return sorted(allowed), reasons


def dense_hints(moment):
    dense = ((moment.get("features") or {}).get("dense") or {})
    interesting = [
        "moment.option_count",
        "moment.span_sec",
        "moment.has_zoom",
        "moment.max_boundary_strength",
        "moment.mean_boundary_strength",
        "moment.word_timing_available",
        "moment.is_orphan_zoom",
    ]
    hints = {}
    for key in interesting:
        if key in dense:
            hints[key] = round_float(dense.get(key))
    for key, value in dense.items():
        if key.startswith("moment.has_anchor.") or key.startswith("moment.anchor_count."):
            hints[key] = round_float(value)
    return hints


def candidate_summary(moment, core_start):
    allowed_families, gate_reasons = family_gate(moment)
    if not allowed_families:
        return None
    options = [
        option_summary(moment, option, core_start)
        for option in moment.get("timingOptions") or []
    ]
    options.sort(key=lambda item: (
        safe_float(item.get("targetSec")),
        str(item.get("anchorType") or ""),
        str(item.get("timingOptionId") or ""),
    ))
    return {
        "momentId": moment.get("momentId", ""),
        "beatGroupId": moment.get("beatGroupId", ""),
        "kind": moment.get("kind", ""),
        "momentSec": round_float(moment.get("momentSec")),
        "relativeSec": round_float(safe_float(moment.get("momentSec")) - core_start),
        "cueIds": moment.get("cueIds") or [],
        "text": str(moment.get("text") or "")[:400],
        "captionWindow": str(moment.get("captionWindow") or "")[:1400],
        "allowedFamilies": allowed_families,
        "gateReasons": gate_reasons,
        "denseHints": dense_hints(moment),
        "timingOptions": options,
    }


def segment_text(candidates):
    parts = []
    for candidate in candidates:
        parts.append(candidate.get("text") or "")
        parts.append(candidate.get("captionWindow") or "")
    return "\n".join(parts)


def split_segment(start_sec, end_sec, moments, max_moments):
    if len(moments) <= max_moments:
        return [(start_sec, end_sec, moments)]
    sorted_moments = sorted(moments, key=lambda item: (safe_float(item.get("momentSec")), item.get("momentId", "")))
    best_gap = -1.0
    split_at = (start_sec + end_sec) / 2.0
    for left, right in zip(sorted_moments, sorted_moments[1:]):
        gap = safe_float(right.get("momentSec")) - safe_float(left.get("momentSec"))
        if gap > best_gap:
            best_gap = gap
            split_at = (safe_float(left.get("momentSec")) + safe_float(right.get("momentSec"))) / 2.0
    if split_at <= start_sec + 0.1 or split_at >= end_sec - 0.1:
        return [(start_sec, end_sec, sorted_moments[:max_moments])]
    left = [moment for moment in sorted_moments if safe_float(moment.get("momentSec")) < split_at]
    right = [moment for moment in sorted_moments if safe_float(moment.get("momentSec")) >= split_at]
    return [
        *split_segment(start_sec, split_at, left, max_moments),
        *split_segment(split_at, end_sec, right, max_moments),
    ]


def nearest_timing_target(moment, label, family):
    target = (label.get("timingTargets") or {}).get(family) or {}
    option_id = target.get("bestOptionId") or ""
    for option in moment.get("timingOptions") or []:
        if option.get("optionId") == option_id:
            return {
                "timingOptionId": option_id,
                "anchorType": option.get("anchorType", ""),
                "targetSec": round_float(option.get("targetSec")),
            }
    return {"timingOptionId": option_id, "anchorType": "", "targetSec": round_float(target.get("manualTime"))}


def build_example_pool(records):
    pool = []
    for record in records:
        project_id = record["project"]["projectId"]
        labels = assign_project_moment_labels(record)
        for moment in record.get("moments") or []:
            label = labels.get(moment.get("momentId")) or {}
            classes = []
            if label.get("kind") == "positive":
                classes = [item for item in label.get("acceptableClasses") or [] if item in CLASSES and item != "none"]
            elif label.get("kind") == "none":
                classes = ["none"]
            if not classes:
                continue
            text = f"{moment.get('text', '')}\n{moment.get('captionWindow', '')}"
            tokens = token_counter(text)
            for family in classes:
                pool.append({
                    "projectId": project_id,
                    "family": family,
                    "tokens": tokens,
                    "example": {
                        "projectId": project_id,
                        "family": family,
                        "momentText": str(moment.get("text") or "")[:320],
                        "captionWindow": str(moment.get("captionWindow") or "")[:900],
                        "timing": nearest_timing_target(moment, label, family) if family in EMITTABLE else None,
                    },
                })
    return pool


def retrieve_examples(pool, query_text, examples_per_class):
    if examples_per_class <= 0:
        return []
    query = token_counter(query_text)
    output = []
    for family in CLASSES:
        if family == "none" or family == "other_sfx" or family in EMITTABLE:
            scored = [
                (cosine(query, item["tokens"]), item["projectId"], item["example"])
                for item in pool
                if item["family"] == family
            ]
            scored.sort(key=lambda item: (-item[0], item[1], item[2].get("momentText", "")))
            for score, _project_id, example in scored[:examples_per_class]:
                output.append({**example, "similarity": round_float(score, 4)})
    return output


def selected_folds(splits, requested_folds, requested_projects):
    folds = splits.get("folds") or []
    if requested_folds:
        folds = [fold for fold in folds if fold.get("foldId") in requested_folds]
    if requested_projects:
        filtered = []
        for fold in folds:
            test_ids = [project_id for project_id in fold.get("testProjectIds") or [] if project_id in requested_projects]
            if test_ids:
                filtered.append({**fold, "testProjectIds": test_ids})
        folds = filtered
    return folds


def make_packet(fold, record, start_sec, end_sec, split_index, split_moments, example_pool, options):
    project_id = record["project"]["projectId"]
    candidates = [candidate_summary(moment, start_sec) for moment in split_moments]
    candidates = [candidate for candidate in candidates if candidate]
    if not candidates:
        return None
    text = segment_text(candidates)
    packet_hash = sha256(
        "\0".join([
            fold.get("foldId", ""),
            project_id,
            f"{start_sec:.6f}",
            f"{end_sec:.6f}",
            ",".join(candidate["momentId"] for candidate in candidates),
        ])
    )[:20]
    segment_id = f"{project_id}:{fold.get('foldId', '')}:editorial_{int(round(start_sec * 1000)):09d}_{split_index:02d}"
    timing_ids = sorted({
        option["timingOptionId"]
        for candidate in candidates
        for option in candidate.get("timingOptions") or []
        if option.get("timingOptionId")
    })
    return {
        "schemaVersion": 1,
        "protocol": PROTOCOL,
        "packetId": packet_hash,
        "foldId": fold.get("foldId", ""),
        "generalizationGroupId": fold.get("generalizationGroupId", ""),
        "projectId": project_id,
        "segmentId": segment_id,
        "coreStartSec": round_float(start_sec),
        "coreEndSec": round_float(end_sec),
        "allowedFamilies": sorted(EMITTABLE | {"other_sfx"}),
        "allowedMomentIds": [candidate["momentId"] for candidate in candidates],
        "allowedTimingOptionIds": timing_ids,
        "soundGuide": {
            "pop": "short zoom/timing accent; use mainly when zoom marker timing makes the accent obvious",
            "ding": "specific reveal, positive detail, answer, count, clear selection, or satisfying small payoff",
            "success": "completed task, solved problem, achieved result, win, or finished outcome",
            "bonk": "mistake, fail, wrong answer, awkward hit, clumsy outcome, or comic negative beat",
            "funny": "actual punchline or absurd comedy beat",
            "bruh": "cringe, disbelief, deflation, or 'come on' reaction",
            "record_scratch": "abrupt reversal, interruption, wait-what pivot, or sudden contradiction",
            "dramatic": "dramatic reveal, boom, ominous escalation, suspense hit, or major emphasis",
            "other_sfx": "a human likely used a sound here, but not one of the supported automation-safe families",
        },
        "candidates": candidates,
        "trainingExamples": retrieve_examples(example_pool, text, options["examples_per_class"]),
        "currentHumanLabelsIncluded": False,
    }


def build_packets(records_by_project, folds, options):
    packets = []
    for fold in folds:
        train = [records_by_project[project_id] for project_id in fold.get("trainProjectIds") or [] if project_id in records_by_project]
        example_pool = build_example_pool(train)
        for project_id in fold.get("testProjectIds") or []:
            record = records_by_project.get(project_id)
            if not record:
                continue
            duration = safe_float(record["project"].get("durationSec"))
            moments = sorted(record.get("moments") or [], key=lambda item: (safe_float(item.get("momentSec")), item.get("momentId", "")))
            if not moments:
                continue
            segment_index = 0
            core = options["core_seconds"]
            start = 0.0
            while start < duration + 0.001:
                end = min(duration, start + core)
                core_moments = [moment for moment in moments if safe_float(moment.get("momentSec")) >= start and safe_float(moment.get("momentSec")) < end]
                if core_moments:
                    for split_start, split_end, split_moments in split_segment(start, end, core_moments, options["max_moments"]):
                        segment_index += 1
                        packet = make_packet(fold, record, split_start, split_end, segment_index, split_moments, example_pool, options)
                        if packet:
                            packets.append(packet)
                start += core
    return packets


def parse_set(value):
    if not value:
        return set()
    return {item.strip() for item in str(value).split(",") if item.strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--outer-splits", default=str(DEFAULT_SPLITS))
    parser.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--fold", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--core-seconds", type=float, default=30.0)
    parser.add_argument("--max-moments", type=int, default=28)
    parser.add_argument("--examples-per-class", type=int, default=2)
    parser.add_argument("--limit-packets", type=int, default=0)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    records_by_project = {record["project"]["projectId"]: record for record in records}
    splits = read_json(args.outer_splits)
    folds = selected_folds(splits, parse_set(args.fold), parse_set(args.project))
    if not folds:
        raise SystemExit("No matching folds/projects to packetize")

    run_id = args.run_id or datetime.now(timezone.utc).strftime("editorial-sfx-packets-%Y%m%dT%H%M%SZ")
    run_root = Path(args.out_root) / run_id
    packets_dir = run_root / "packets"
    if args.clean and run_root.exists():
        import shutil
        shutil.rmtree(run_root)
    packets_dir.mkdir(parents=True, exist_ok=True)

    options = {
        "core_seconds": args.core_seconds,
        "max_moments": max(1, args.max_moments),
        "examples_per_class": max(0, args.examples_per_class),
    }
    packets = build_packets(records_by_project, folds, options)
    if args.limit_packets > 0:
        packets = packets[:args.limit_packets]

    manifest_packets = []
    for packet in packets:
        file_name = f"{packet['foldId']}__{packet['projectId']}__{packet['packetId']}.json"
        path = packets_dir / file_name
        write_json(path, packet)
        manifest_packets.append({
            "packetId": packet["packetId"],
            "path": str(path),
            "fileName": file_name,
            "foldId": packet["foldId"],
            "projectId": packet["projectId"],
            "segmentId": packet["segmentId"],
            "coreStartSec": packet["coreStartSec"],
            "coreEndSec": packet["coreEndSec"],
            "candidateCount": len(packet["candidates"]),
        })

    manifest = {
        "schemaVersion": 1,
        "protocol": f"{PROTOCOL}-manifest",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "runRoot": str(run_root),
        "packetsDir": str(packets_dir),
        "corpus": str(Path(args.corpus).resolve()),
        "outerSplits": str(Path(args.outer_splits).resolve()),
        "metricBoundary": "packet candidates are outer test projects; training examples use only each fold's trainProjectIds",
        "currentHumanLabelsIncluded": False,
        "options": options,
        "limited": args.limit_packets > 0,
        "packetCount": len(manifest_packets),
        "packets": manifest_packets,
    }
    write_json(run_root / "editorial-sfx-packet-manifest.json", manifest)
    print(json.dumps({
        "runRoot": str(run_root),
        "packetsDir": str(packets_dir),
        "packetCount": len(manifest_packets),
        "limited": manifest["limited"],
        "samplePacket": manifest_packets[0]["path"] if manifest_packets else None,
    }, indent=2))


if __name__ == "__main__":
    main()
