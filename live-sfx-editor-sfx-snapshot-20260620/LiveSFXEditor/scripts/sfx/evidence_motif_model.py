#!/usr/bin/env python3
import math
import re
from collections import Counter, defaultdict

from caption_moment_router_model import (
    assign_project_moment_labels,
    choose_timing_option,
    fit_timing_ranker,
    safe_float,
)


ENABLED_FAMILIES = ("pop", "ding", "bonk")
FEATURE_CACHE = {}
LABEL_ROW_CACHE = {}
MOTIF_NGRAM_TOKEN_LIMIT = 80
MOTIF_UNIGRAM_LIMIT = 160
DEFAULT_POSITIVE_CANDIDATE_LIMIT = 60
DEFAULT_NEGATIVE_CANDIDATE_LIMIT = 80
DEFAULT_LOOKUP_KEY_LIMIT = 24
DEFAULT_MAX_POSTINGS_PER_KEY = 400
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "because", "but", "by",
    "for", "from", "got", "had", "has", "have", "he", "her", "here",
    "him", "his", "i", "im", "in", "is", "it", "its", "just", "like",
    "me", "my", "of", "on", "or", "our", "she", "so", "that", "the",
    "their", "them", "then", "there", "they", "this", "to", "up", "was",
    "we", "well", "were", "what", "when", "with", "you", "your",
}


def tokens_for_text(text):
    raw = re.findall(r"[a-z0-9']+", str(text or "").lower())
    return [token.strip("'") for token in raw if token.strip("'") and token.strip("'") not in STOPWORDS]


def moment_cache_key(moment):
    moment_id = moment.get("momentId")
    project_id = moment.get("projectId") or moment.get("sourceProjectId")
    if project_id and moment_id:
        return f"{project_id}:{moment_id}"
    return id(moment)


def cached_features(moment):
    key = moment_cache_key(moment)
    if key in FEATURE_CACHE:
        return FEATURE_CACHE[key]
    text = moment_text_blob(moment)
    tokens = tokens_for_text(text)
    token_counter_value = Counter(tokens)
    anchors = sorted({
        option.get("anchorType", "")
        for option in moment.get("timingOptions") or []
        if option.get("anchorType")
    })
    zoom = dense(moment, "moment.has_zoom") > 0 or any(option.get("zoomMarkerIds") for option in moment.get("timingOptions") or [])
    lower = text.lower()
    flags = []
    patterns = {
        "specific_answer": r"\b(answer|correct|exactly|there it is|that's it|that is it|found it|got it)\b",
        "number_value": r"\b\d+(\.\d+)?\b",
        "completed": r"\b(done|finished|completed|solved|fixed|worked|finally)\b",
        "negative_fail": r"\b(wrong|mistake|failed|fail|broken|broke|lost|dead|can't|cannot|couldn't|nope|nah)\b",
        "selection": r"\b(this one|that one|the one|choose|picked|selected)\b",
        "zoom_word": r"\b(look|see|watch|here|this)\b",
    }
    for name, pattern in patterns.items():
        if re.search(pattern, lower):
            flags.append(name)
    motif_tokens = tokens[:MOTIF_NGRAM_TOKEN_LIMIT]
    unigram_keys = []
    seen_unigrams = set()
    for token in tokens:
        if token in seen_unigrams:
            continue
        seen_unigrams.add(token)
        if len(token) >= 4 or token.isdigit():
            unigram_keys.append(f"tok:{token}")
        if len(unigram_keys) >= MOTIF_UNIGRAM_LIMIT:
            break
    keys = set(unigram_keys)
    for phrase in ngrams(motif_tokens):
        keys.add(f"ng:{phrase}")
    for anchor in anchors:
        keys.add(f"anchor:{anchor}")
    keys.add(f"zoom:{1 if zoom else 0}")
    keys.add(f"orphan_zoom:{1 if dense(moment, 'moment.is_orphan_zoom') > 0 else 0}")
    for flag in flags:
        keys.add(f"flag:{flag}")
    candidate_keys = {
        motif_key for motif_key in keys
        if motif_key.startswith(("tok:", "ng:", "flag:")) or motif_key == "orphan_zoom:1"
    }
    phrase_candidate_keys = {
        motif_key for motif_key in candidate_keys
        if motif_key.startswith(("ng:", "flag:")) or motif_key == "orphan_zoom:1"
    }
    if phrase_candidate_keys:
        candidate_keys = phrase_candidate_keys
    value = {
        "text": text,
        "tokens": tokens,
        "counter": token_counter_value,
        "anchors": anchors,
        "hasZoom": zoom,
        "flags": flags,
        "motifKeys": keys,
        "candidateKeys": candidate_keys,
    }
    FEATURE_CACHE[key] = value
    return value


def moment_text_blob(moment):
    lexical = ((moment.get("features") or {}).get("lexical") or [])
    if lexical:
        lexical_text = " ".join(str(item) for item in lexical)
    else:
        lexical_text = ""
    return " ".join([
        str(moment.get("text") or ""),
        str(moment.get("captionWindow") or ""),
        lexical_text,
    ]).strip()


def moment_tokens(moment):
    return cached_features(moment)["tokens"]


def ngrams(tokens, low=2, high=4):
    output = []
    for size in range(low, high + 1):
        for index in range(0, max(0, len(tokens) - size + 1)):
            output.append("_".join(tokens[index:index + size]))
    return output


def dense(moment, key, default=0.0):
    return safe_float(((moment.get("features") or {}).get("dense") or {}).get(key), default)


def anchor_types(moment):
    return cached_features(moment)["anchors"]


def has_zoom(moment):
    return cached_features(moment)["hasZoom"]


def regex_flags(moment):
    return cached_features(moment)["flags"]


def motif_keys(moment):
    return cached_features(moment)["motifKeys"]


def candidate_keys(moment):
    return cached_features(moment)["candidateKeys"]


def text_counter(moment):
    return cached_features(moment)["counter"]


def cosine(left, right):
    if not left or not right:
        return 0.0
    overlap = sum(min(left[key], right[key]) for key in left.keys() & right.keys())
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    return overlap / (left_norm * right_norm) if left_norm and right_norm else 0.0


def structural_similarity(left, right):
    score = 0.0
    if has_zoom(left) == has_zoom(right):
        score += 0.10
    left_anchors = set(anchor_types(left))
    right_anchors = set(anchor_types(right))
    if left_anchors and right_anchors:
        score += 0.10 * (len(left_anchors & right_anchors) / len(left_anchors | right_anchors))
    left_flags = set(regex_flags(left))
    right_flags = set(regex_flags(right))
    if left_flags or right_flags:
        score += 0.12 * (len(left_flags & right_flags) / max(1, len(left_flags | right_flags)))
    return score


def example_similarity(left_moment, right_moment, right_counter):
    return cosine(text_counter(left_moment), right_counter) + structural_similarity(left_moment, right_moment)


def label_rows_for_record(record):
    project_id = record["project"]["projectId"]
    if project_id in LABEL_ROW_CACHE:
        return LABEL_ROW_CACHE[project_id]
    labels = assign_project_moment_labels(record)
    rows = []
    for moment in record.get("moments") or []:
        label = labels.get(moment.get("momentId")) or {}
        if label.get("kind") == "positive":
            classes = [family for family in label.get("acceptableClasses") or [] if family != "none"]
            for family in classes:
                rows.append({
                    "projectId": project_id,
                    "family": family,
                    "labelKind": "positive",
                    "moment": moment,
                    "timingTarget": (label.get("timingTargets") or {}).get(family),
                })
        elif label.get("kind") == "none":
            rows.append({
                "projectId": record["project"]["projectId"],
                "family": "none",
                "labelKind": "none",
                "moment": moment,
                "timingTarget": None,
            })
    LABEL_ROW_CACHE[project_id] = rows
    return rows


def build_evidence_model(records, enabled_families=ENABLED_FAMILIES):
    enabled = tuple(enabled_families)
    examples = []
    key_stats = {
        family: defaultdict(lambda: {
            "pos": 0,
            "neg": 0,
            "posProjects": set(),
            "negProjects": set(),
        })
        for family in enabled
    }
    timing_assignments = []
    for record in records:
        for row in label_rows_for_record(record):
            family = row["family"]
            moment = row["moment"]
            project_id = row["projectId"]
            counter = text_counter(moment)
            if family in enabled:
                example_id = len(examples)
                examples.append({
                    "exampleId": example_id,
                    "projectId": project_id,
                    "family": family,
                    "moment": moment,
                    "counter": counter,
                    "candidateKeys": candidate_keys(moment),
                    "timingTarget": row.get("timingTarget"),
                })
                target = row.get("timingTarget") or {}
                if target.get("bestOptionId"):
                    timing_assignments.append({
                        "projectId": project_id,
                        "moment": moment,
                        "family": family,
                        "bestOptionId": target["bestOptionId"],
                        "manualTime": target.get("manualTime"),
                        "deltaSec": target.get("deltaSec"),
                    })
            for candidate_family in enabled:
                is_positive_for_family = family == candidate_family
                for key in motif_keys(moment):
                    stat = key_stats[candidate_family][key]
                    if is_positive_for_family:
                        stat["pos"] += 1
                        stat["posProjects"].add(project_id)
                    elif row["labelKind"] == "none" or family != candidate_family:
                        stat["neg"] += 1
                        stat["negProjects"].add(project_id)
    timing_ranker = fit_timing_ranker(timing_assignments, 0.10)
    examples_by_family = {family: [] for family in enabled}
    examples_by_id = {}
    for example in examples:
        examples_by_family[example["family"]].append(example)
        examples_by_id[example["exampleId"]] = example
    negative_examples_by_family = {
        family: [example for example in examples if example["family"] != family]
        for family in enabled
    }
    positive_index_by_family = {family: defaultdict(list) for family in enabled}
    negative_index_by_family = {family: defaultdict(list) for family in enabled}
    for example in examples:
        for key in example["candidateKeys"]:
            positive_index_by_family[example["family"]][key].append(example["exampleId"])
            for family in enabled:
                if family != example["family"]:
                    negative_index_by_family[family][key].append(example["exampleId"])
    return {
        "enabledFamilies": enabled,
        "examples": examples,
        "examplesByFamily": examples_by_family,
        "examplesById": examples_by_id,
        "negativeExamplesByFamily": negative_examples_by_family,
        "positiveIndexByFamily": positive_index_by_family,
        "negativeIndexByFamily": negative_index_by_family,
        "keyStats": key_stats,
        "timingRanker": timing_ranker,
    }


def indexed_candidates(model, index_name, family, keys, limit):
    index = (model.get(index_name) or {}).get(family) or {}
    examples_by_id = model.get("examplesById") or {}
    counts = Counter()
    postings = [
        (key, index.get(key, []))
        for key in keys
        if index.get(key, []) and len(index.get(key, [])) <= DEFAULT_MAX_POSTINGS_PER_KEY
    ]
    if not postings:
        postings = [
            (key, index.get(key, []))
            for key in keys
            if index.get(key, [])
        ]
    for _key, example_ids in sorted(postings, key=lambda item: (len(item[1]), item[0]))[:DEFAULT_LOOKUP_KEY_LIMIT]:
        for example_id in example_ids:
            counts[example_id] += 1
    selected_ids = sorted(counts, key=lambda example_id: (-counts[example_id], example_id))[:limit]
    return [examples_by_id[example_id] for example_id in selected_ids if example_id in examples_by_id]


def evidence_for_family(model, moment, family, policy):
    lookup_keys = candidate_keys(moment)
    positive_limit = policy.get("positive_candidate_limit", DEFAULT_POSITIVE_CANDIDATE_LIMIT)
    negative_limit = policy.get("negative_candidate_limit", DEFAULT_NEGATIVE_CANDIDATE_LIMIT)
    examples = indexed_candidates(model, "positiveIndexByFamily", family, lookup_keys, positive_limit)
    scored = sorted(
        (
            (example_similarity(moment, example["moment"], example["counter"]), example)
            for example in examples
        ),
        key=lambda item: (-item[0], item[1]["projectId"], item[1]["moment"].get("momentId", "")),
    )
    top = scored[:policy["top_k"]]
    best_positive = top[0][0] if top else 0.0
    support = [item for item in top if item[0] >= policy["neighbor_min_similarity"]]
    support_projects = {item[1]["projectId"] for item in support}

    negative_examples = indexed_candidates(model, "negativeIndexByFamily", family, lookup_keys, negative_limit)
    best_negative = max(
        (example_similarity(moment, example["moment"], example["counter"]) for example in negative_examples),
        default=0.0,
    )

    discriminative = discriminative_motifs(model, moment, family, policy)
    return {
        "family": family,
        "bestPositive": best_positive,
        "bestNegative": best_negative,
        "margin": best_positive - best_negative,
        "supportCount": len(support),
        "supportProjects": len(support_projects),
        "discriminative": discriminative[:8],
        "topExamples": [
            {
                "similarity": round(score, 4),
                "projectId": example["projectId"],
                "momentId": example["moment"].get("momentId"),
                "text": str(example["moment"].get("text") or "")[:160],
            }
            for score, example in top[:3]
        ],
    }


def discriminative_motifs(model, moment, family, policy):
    discriminative = []
    for key in motif_keys(moment):
        stat = model["keyStats"][family].get(key)
        if not stat:
            continue
        pos_projects = len(stat["posProjects"])
        neg_projects = len(stat["negProjects"])
        if (
            stat["pos"] >= policy["motif_min_pos"]
            and pos_projects >= policy["motif_min_projects"]
            and stat["pos"] >= stat["neg"] * policy["motif_ratio"] + policy["motif_margin"]
        ):
            discriminative.append({
                "key": key,
                "pos": stat["pos"],
                "neg": stat["neg"],
                "posProjects": pos_projects,
                "negProjects": neg_projects,
            })
    discriminative.sort(key=lambda item: (-(item["pos"] - item["neg"]), item["key"]))
    return discriminative[:8]


def should_score_family(model, moment, family, policy):
    if family == "pop":
        return has_zoom(moment)
    if family == "ding":
        return bool(discriminative_motifs(model, moment, family, policy))
    if family == "bonk":
        flags = set(regex_flags(moment))
        return bool({"negative_fail", "specific_answer"} & flags)
    return False


def family_specific_pass(family, moment, evidence, policy):
    if family == "pop":
        if not has_zoom(moment):
            return False
        # Pop is allowed to be less lexical, but still needs either cross-project
        # support or a discriminative zoom/pattern key.
        return (
            evidence["bestPositive"] >= policy["pop_min_similarity"]
            and evidence["margin"] >= policy["pop_min_margin"]
            and evidence["supportProjects"] >= policy["pop_min_projects"]
        ) or bool(evidence["discriminative"] and evidence["supportProjects"] >= 1)
    if family == "ding":
        return (
            evidence["bestPositive"] >= policy["min_similarity"]
            and evidence["margin"] >= policy["min_margin"]
            and evidence["supportCount"] >= policy["min_support"]
            and evidence["supportProjects"] >= policy["min_projects"]
            and bool(evidence["discriminative"])
        )
    if family == "bonk":
        flags = set(regex_flags(moment))
        if not ({"negative_fail", "specific_answer"} & flags):
            return False
        return (
            evidence["bestPositive"] >= policy["min_similarity"]
            and evidence["margin"] >= policy["min_margin"]
            and evidence["supportProjects"] >= policy["min_projects"]
        )
    return False


def score_moment(model, moment, policy):
    family_evidence = []
    for family in model["enabledFamilies"]:
        if not should_score_family(model, moment, family, policy):
            continue
        evidence = evidence_for_family(model, moment, family, policy)
        if family_specific_pass(family, moment, evidence, policy):
            family_evidence.append(evidence)
    if not family_evidence:
        return None
    family_evidence.sort(key=lambda item: (
        item["margin"],
        item["supportProjects"],
        item["bestPositive"],
        -("pop", "ding", "bonk").index(item["family"]) if item["family"] in ("pop", "ding", "bonk") else -99,
    ), reverse=True)
    winner = family_evidence[0]
    timing = choose_timing_option(model["timingRanker"], moment, winner["family"])
    if not timing:
        return None
    return {
        "family": winner["family"],
        "targetSec": timing["targetSec"],
        "selectedTimingOptionId": timing["option"].get("optionId", ""),
        "selectedAnchorType": timing["option"].get("anchorType", ""),
        "timingScore": timing.get("timingScore"),
        "evidence": winner,
    }


def policy_presets():
    strict = {
        "policyName": "strict",
        "top_k": 8,
        "neighbor_min_similarity": 0.48,
        "min_similarity": 0.58,
        "min_margin": 0.14,
        "min_support": 2,
        "min_projects": 2,
        "motif_min_pos": 2,
        "motif_min_projects": 2,
        "motif_ratio": 2.5,
        "motif_margin": 1,
        "pop_min_similarity": 0.46,
        "pop_min_margin": 0.10,
        "pop_min_projects": 2,
        "positive_candidate_limit": DEFAULT_POSITIVE_CANDIDATE_LIMIT,
        "negative_candidate_limit": DEFAULT_NEGATIVE_CANDIDATE_LIMIT,
        "global_nms_seconds": 0.30,
    }
    medium = {
        **strict,
        "policyName": "medium",
        "neighbor_min_similarity": 0.43,
        "min_similarity": 0.52,
        "min_margin": 0.08,
        "min_support": 1,
        "min_projects": 1,
        "motif_min_pos": 2,
        "motif_min_projects": 1,
        "motif_ratio": 1.4,
        "motif_margin": 0,
        "pop_min_similarity": 0.40,
        "pop_min_margin": 0.04,
        "pop_min_projects": 1,
    }
    loose_evidence = {
        **medium,
        "policyName": "loose_evidence",
        "neighbor_min_similarity": 0.38,
        "min_similarity": 0.47,
        "min_margin": 0.02,
        "motif_ratio": 1.1,
        "pop_min_similarity": 0.36,
        "pop_min_margin": 0.0,
    }
    return [strict, medium, loose_evidence]


def default_policy():
    return policy_presets()[0]


def summarize_model(model):
    summary = {
        "enabledFamilies": list(model["enabledFamilies"]),
        "positiveExampleCounts": {},
        "strongMotifCounts": {},
    }
    for family in model["enabledFamilies"]:
        summary["positiveExampleCounts"][family] = sum(1 for row in model["examples"] if row["family"] == family)
        strong = 0
        for stat in model["keyStats"][family].values():
            if stat["pos"] >= 2 and len(stat["posProjects"]) >= 2 and stat["pos"] > stat["neg"]:
                strong += 1
        summary["strongMotifCounts"][family] = strong
    return summary
