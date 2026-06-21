#!/usr/bin/env python3
import math
import re
from collections import Counter, defaultdict

from caption_moment_router_model import (
    EMITTABLE,
    assign_project_moment_labels,
    choose_timing_option,
    fit_timing_ranker,
    safe_float,
)


ENABLED_FAMILIES = tuple(sorted(EMITTABLE))
MAX_PHRASE_TOKENS = 6
MAX_TEXT_TOKENS = 80
LABEL_CACHE = {}
PHRASE_CACHE = {}
SINGLETON_ALLOW = {
    "correct", "done", "fixed", "found", "great", "perfect", "right",
    "wrong", "nope", "nah", "wait", "wow", "oops", "bruh", "fail",
    "yes", "cool", "nice", "beautiful", "smooth", "finally",
}
WEAK_SINGLETONS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
    "from", "had", "has", "have", "he", "her", "here", "him", "his",
    "i", "im", "in", "is", "it", "its", "just", "like", "me", "my",
    "of", "on", "or", "our", "she", "so", "that", "the", "their",
    "them", "then", "there", "they", "this", "to", "up", "was", "we",
    "were", "what", "when", "with", "you", "your", "yeah", "okay",
    "gonna",
}


def tokens_for_text(text):
    return [token.strip("'") for token in re.findall(r"[a-z0-9']+", str(text or "").lower()) if token.strip("'")]


def phrase_allowed(tokens):
    if not tokens:
        return False
    if len(tokens) == 1:
        token = tokens[0]
        return token in SINGLETON_ALLOW or (len(token) >= 4 and token not in WEAK_SINGLETONS) or token.isdigit()
    if all(token in WEAK_SINGLETONS for token in tokens):
        return False
    return any(token not in WEAK_SINGLETONS or token in SINGLETON_ALLOW or token.isdigit() for token in tokens)


def phrases_for_text(text, source):
    tokens = tokens_for_text(text)[:MAX_TEXT_TOKENS]
    phrases = {}
    for size in range(1, MAX_PHRASE_TOKENS + 1):
        for index in range(0, max(0, len(tokens) - size + 1)):
            phrase_tokens = tokens[index:index + size]
            if not phrase_allowed(phrase_tokens):
                continue
            phrase = " ".join(phrase_tokens)
            phrases[f"{source}:{phrase}"] = {
                "source": source,
                "phrase": phrase,
                "length": size,
            }
    return phrases


def moment_phrase_keys(moment):
    cache_key = id(moment)
    if cache_key in PHRASE_CACHE:
        return PHRASE_CACHE[cache_key]
    keys = {}
    keys.update(phrases_for_text(moment.get("text") or "", "cue"))
    caption_window = moment.get("captionWindow") or ""
    if caption_window and caption_window != moment.get("text"):
        for key, value in phrases_for_text(caption_window, "window").items():
            keys.setdefault(key, value)
    PHRASE_CACHE[cache_key] = keys
    return keys


def selected_anchor(moment, target):
    if not target or not target.get("bestOptionId"):
        return "", 0.0
    option_id = target["bestOptionId"]
    for option in moment.get("timingOptions") or []:
        if option.get("optionId") == option_id:
            return option.get("anchorType") or "", safe_float(target.get("manualTime")) - safe_float(option.get("targetSec"))
    return "", safe_float(target.get("deltaSec"))


def median(values):
    nums = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not nums:
        return 0.0
    mid = len(nums) // 2
    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2.0


def bounded_offset(values):
    return max(-0.25, min(0.25, median(values)))


def build_phrase_cue_model(records, enabled_families=ENABLED_FAMILIES):
    enabled = tuple(enabled_families)
    total_stats = defaultdict(lambda: {
        "count": 0,
        "projects": set(),
        "meta": None,
    })
    positive_stats = {
        family: defaultdict(lambda: {
            "pos": 0,
            "posProjects": set(),
            "anchorCounts": Counter(),
            "anchorResiduals": defaultdict(list),
            "examples": [],
            "meta": None,
        })
        for family in enabled
    }
    timing_assignments = []
    for record in records:
        project_id = record["project"]["projectId"]
        if project_id not in LABEL_CACHE:
            LABEL_CACHE[project_id] = assign_project_moment_labels(record)
        labels = LABEL_CACHE[project_id]
        for moment in record.get("moments") or []:
            label = labels.get(moment.get("momentId")) or {}
            if label.get("kind") not in {"positive", "none"}:
                continue
            phrases = moment_phrase_keys(moment)
            if not phrases:
                continue
            positive_families = [
                family for family in label.get("acceptableClasses") or []
                if family in enabled
            ] if label.get("kind") == "positive" else []
            for key, meta in phrases.items():
                total = total_stats[key]
                total["count"] += 1
                total["projects"].add(project_id)
                total["meta"] = meta
            for family in positive_families:
                target = (label.get("timingTargets") or {}).get(family)
                if target and target.get("bestOptionId"):
                    timing_assignments.append({
                        "projectId": project_id,
                        "moment": moment,
                        "family": family,
                        "bestOptionId": target["bestOptionId"],
                        "manualTime": target.get("manualTime"),
                        "deltaSec": target.get("deltaSec"),
                    })
                anchor, residual = selected_anchor(moment, target)
                for key, meta in phrases.items():
                    stat = positive_stats[family][key]
                    stat["meta"] = meta
                    stat["pos"] += 1
                    stat["posProjects"].add(project_id)
                    if anchor:
                        stat["anchorCounts"][anchor] += 1
                        stat["anchorResiduals"][anchor].append(residual)
                    if len(stat["examples"]) < 5:
                        stat["examples"].append({
                            "projectId": project_id,
                            "momentId": moment.get("momentId"),
                            "text": str(moment.get("text") or "")[:180],
                            "anchor": anchor,
                        })
    rules_by_key = defaultdict(list)
    rules_by_family = defaultdict(list)
    for family, by_key in positive_stats.items():
        for key, stat in by_key.items():
            pos = stat["pos"]
            total = total_stats[key]
            neg = max(0, total["count"] - pos)
            if pos <= 0:
                continue
            meta = stat["meta"] or total["meta"] or {"source": "", "phrase": key, "length": 1}
            precision = pos / (pos + neg) if pos + neg else 0.0
            pos_projects = len(stat["posProjects"])
            neg_projects = len(total["projects"] - stat["posProjects"])
            phrase_len = safe_float(meta.get("length"), 1.0)
            source_bonus = 0.35 if meta.get("source") == "cue" else 0.0
            rarity_bonus = math.log1p(pos) - 0.35 * math.log1p(neg)
            quality = (
                2.4 * precision
                + 0.32 * pos_projects
                + 0.22 * phrase_len
                + source_bonus
                + rarity_bonus
            )
            anchors = []
            for anchor, count in stat["anchorCounts"].most_common():
                anchors.append({
                    "anchorType": anchor,
                    "count": count,
                    "offsetSec": bounded_offset(stat["anchorResiduals"][anchor]),
                })
            rule = {
                "key": key,
                "family": family,
                "source": meta.get("source"),
                "phrase": meta.get("phrase"),
                "length": int(phrase_len),
                "pos": pos,
                "neg": neg,
                "posProjects": pos_projects,
                "negProjects": neg_projects,
                "precision": precision,
                "quality": quality,
                "anchors": anchors,
                "examples": stat["examples"],
            }
            rules_by_key[key].append(rule)
            rules_by_family[family].append(rule)
    return {
        "enabledFamilies": enabled,
        "rulesByKey": dict(rules_by_key),
        "rulesByFamily": dict(rules_by_family),
        "timingRanker": fit_timing_ranker(timing_assignments, 0.10),
    }


def policy_presets():
    strict = {
        "policyName": "strict",
        "min_pos": 3,
        "min_projects": 2,
        "min_precision": 0.40,
        "min_quality": 3.60,
        "min_length": 2,
        "cue_only": True,
        "phrase_cooldown_seconds": 6.0,
        "global_nms_seconds": 0.30,
    }
    balanced = {
        **strict,
        "policyName": "balanced",
        "min_pos": 2,
        "min_precision": 0.28,
        "min_quality": 3.00,
        "phrase_cooldown_seconds": 4.0,
        "cue_only": True,
    }
    contextual = {
        **balanced,
        "policyName": "contextual",
        "min_precision": 0.34,
        "min_quality": 3.40,
        "cue_only": False,
    }
    loose_probe = {
        **balanced,
        "policyName": "loose_probe",
        "min_projects": 1,
        "min_precision": 0.22,
        "min_quality": 2.60,
        "min_length": 2,
        "cue_only": True,
    }
    return [strict, balanced, contextual, loose_probe]


def default_policy():
    return policy_presets()[0]


def rule_passes(rule, policy):
    if policy.get("cue_only") and rule.get("source") != "cue":
        return False
    if rule.get("length", 1) < policy.get("min_length", 1):
        return False
    return (
        rule["pos"] >= policy["min_pos"]
        and rule["posProjects"] >= policy["min_projects"]
        and rule["precision"] >= policy["min_precision"]
        and rule["quality"] >= policy["min_quality"]
    )


def choose_phrase_timing(model, moment, rule):
    options = moment.get("timingOptions") or []
    for anchor in rule.get("anchors") or []:
        matching = [option for option in options if option.get("anchorType") == anchor["anchorType"]]
        if matching:
            matching.sort(key=lambda option: (
                -safe_float((option.get("parentFeatures") or {}).get("boundaryStrength")),
                abs(safe_float(option.get("targetSec")) - safe_float(moment.get("momentSec"))),
                option.get("optionId") or "",
            ))
            selected = matching[0]
            return {
                "option": selected,
                "targetSec": max(0.0, safe_float(selected.get("targetSec")) + safe_float(anchor.get("offsetSec"))),
                "timingScore": safe_float(anchor.get("count")),
                "timingSource": "phrase_anchor",
            }
    fallback = choose_timing_option(model["timingRanker"], moment, rule["family"])
    if not fallback:
        return None
    return {
        **fallback,
        "timingSource": "family_timing_ranker",
    }


def score_moment(model, moment, policy):
    phrases = moment_phrase_keys(moment)
    candidates = []
    for key in phrases:
        for rule in model.get("rulesByKey", {}).get(key, []):
            if not rule_passes(rule, policy):
                continue
            score = rule["quality"] + 0.18 * rule["length"] + 0.12 * math.log1p(rule["pos"])
            candidates.append((score, rule))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (
        -item[0],
        -item[1]["length"],
        -item[1]["posProjects"],
        item[1]["family"],
        item[1]["phrase"],
    ))
    score, rule = candidates[0]
    timing = choose_phrase_timing(model, moment, rule)
    if not timing:
        return None
    return {
        "family": rule["family"],
        "targetSec": timing["targetSec"],
        "selectedTimingOptionId": timing["option"].get("optionId", ""),
        "selectedAnchorType": timing["option"].get("anchorType", ""),
        "timingScore": timing.get("timingScore"),
        "evidence": {
            "score": score,
            "phrase": rule["phrase"],
            "source": rule["source"],
            "pos": rule["pos"],
            "neg": rule["neg"],
            "posProjects": rule["posProjects"],
            "precision": rule["precision"],
            "quality": rule["quality"],
            "timingSource": timing.get("timingSource"),
            "topAnchors": rule.get("anchors")[:3],
            "examples": rule.get("examples")[:3],
        },
    }


def summarize_model(model, top_n=12):
    return {
        "enabledFamilies": list(model["enabledFamilies"]),
        "ruleCounts": {
            family: len(model.get("rulesByFamily", {}).get(family, []))
            for family in model["enabledFamilies"]
        },
        "topRules": {
            family: [
                {
                    "phrase": rule["phrase"],
                    "source": rule["source"],
                    "pos": rule["pos"],
                    "neg": rule["neg"],
                    "posProjects": rule["posProjects"],
                    "precision": round(rule["precision"], 4),
                    "quality": round(rule["quality"], 4),
                    "anchors": rule["anchors"][:3],
                }
                for rule in sorted(
                    model.get("rulesByFamily", {}).get(family, []),
                    key=lambda item: (-item["quality"], -item["pos"], item["phrase"]),
                )[:top_n]
            ]
            for family in model["enabledFamilies"]
        },
    }
