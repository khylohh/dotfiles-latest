#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from caption_moment_router_model import load_corpus, training_records, write_json
from phrase_cue_model import build_phrase_cue_model, summarize_model


EDITOR_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = EDITOR_ROOT / "data/sfx-automation-v3/caption-moment-corpus.jsonl"
DEFAULT_OUT = EDITOR_ROOT / "validation/phrase-cues-v1/model-summary.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    records = training_records(load_corpus(args.corpus))
    model = build_phrase_cue_model(records)
    summary = summarize_model(model)
    write_json(args.out, summary)
    print(json.dumps({
        "out": str(Path(args.out).resolve()),
        "enabledFamilies": summary["enabledFamilies"],
        "ruleCounts": summary["ruleCounts"],
    }, indent=2))


if __name__ == "__main__":
    main()
