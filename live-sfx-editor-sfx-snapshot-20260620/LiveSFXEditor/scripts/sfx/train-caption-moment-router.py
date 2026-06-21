#!/usr/bin/env python3
import argparse
from pathlib import Path

from caption_moment_router_model import (
    build_route_examples,
    dataset_sha256,
    fit_router,
    fit_timing_ranker,
    load_corpus,
    model_to_json,
    training_records,
    write_json,
)


EDITOR_ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"))
    parser.add_argument("--model-out", default=str(EDITOR_ROOT / "data/sfx-automation-v3/model-v1/caption-moment-router.json"))
    parser.add_argument("--policy-out", default=str(EDITOR_ROOT / "data/sfx-automation-v3/model-v1/caption-moment-policy.json"))
    parser.add_argument("--c", type=float, default=0.10)
    parser.add_argument("--emit-threshold", type=float, default=0.50)
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    examples, timing_assignments = build_route_examples(records)
    model = fit_router(examples, args.c)
    model["timingRanker"] = fit_timing_ranker(timing_assignments, args.c)
    model_json = model_to_json(model, dataset_sha256(args.corpus), records)
    policy = {
        "schemaVersion": 3,
        "modelVersion": "caption-moment-router-linear-v1",
        "emitThreshold": args.emit_threshold,
        "globalNmsSeconds": 0.3,
        "nonEmittingClasses": ["none", "other_sfx"],
        "selectionObjective": "inner_oof_net_saved_edits",
    }
    write_json(args.model_out, model_json)
    write_json(args.policy_out, policy)
    print({
        "modelOut": str(Path(args.model_out).resolve()),
        "policyOut": str(Path(args.policy_out).resolve()),
        "trainingProjects": len(records),
        "routeExamples": len(examples),
        "timingAssignments": len(timing_assignments),
        "emitThreshold": args.emit_threshold,
    })


if __name__ == "__main__":
    main()
