#!/usr/bin/env python3
import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from caption_moment_router_model import dataset_sha256, load_corpus, training_records


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_OUT = EDITOR_ROOT / "data/sfx-automation-v3/zoom-pop-model-v1.json"


def load_zoom_pop_validation_module():
    script_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(script_dir))
    path = script_dir / "run-zoom-pop-validation.py"
    spec = importlib.util.spec_from_file_location("run_zoom_pop_validation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--match-window-sec", type=float, default=5.0)
    args = parser.parse_args()

    zoom_pop = load_zoom_pop_validation_module()
    records = training_records(load_corpus(args.corpus))
    rows = zoom_pop.zoom_pop_rows(records, args.match_window_sec)
    model = zoom_pop.train_model(rows)
    vectorizer = model["vectorizer"]
    clf = model["clf"]
    names = list(vectorizer.feature_names_)
    weights = {
        name: float(clf.coef_[0][index])
        for index, name in enumerate(names)
        if abs(float(clf.coef_[0][index])) > 1e-12
    }
    payload = {
        "schemaVersion": 1,
        "modelVersion": "zoom-pop-selector-v1",
        "featureVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "matchWindowSec": args.match_window_sec,
        "datasetSha256": dataset_sha256(args.corpus),
        "trainingProjectIds": sorted(record["project"]["projectId"] for record in records),
        "positiveCandidateCount": int(sum(row["label"] for row in rows)),
        "candidateCount": len(rows),
        "classifier": {
            "type": "logistic_regression",
            "intercept": float(clf.intercept_[0]),
            "weights": weights,
        },
        "runtimePolicy": {
            "family": "pop",
            "threshold": 0.80,
            "cooldownSeconds": 5.0,
            "globalCooldownSeconds": 0.65,
            "maxPerMinute": 2.4,
            "maxZoomAccentRatio": 0.45,
            "priority": 35,
        },
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(out_path),
        "candidateCount": payload["candidateCount"],
        "positiveCandidateCount": payload["positiveCandidateCount"],
        "trainingProjectCount": len(payload["trainingProjectIds"]),
        "weightCount": len(weights),
    }, indent=2))


if __name__ == "__main__":
    main()
