#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from caption_moment_router_model import load_corpus, training_records, write_json
from evidence_motif_model import build_evidence_model, default_policy, summarize_model


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--out", default=str(EDITOR_ROOT / "validation/evidence-motifs-v1/model-summary.json"))
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    model = build_evidence_model(records)
    summary = {
        "schemaVersion": 1,
        "protocol": "evidence-motifs-v1-summary",
        "policy": default_policy(),
        "trainingProjectIds": sorted(record["project"]["projectId"] for record in records),
        "modelSummary": summarize_model(model),
    }
    write_json(args.out, summary)
    print(json.dumps({
        "out": str(Path(args.out).resolve()),
        **summary["modelSummary"],
    }, indent=2))


if __name__ == "__main__":
    main()
