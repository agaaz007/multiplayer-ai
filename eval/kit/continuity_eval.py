#!/usr/bin/env python3
"""Ledger black-box continuity evaluation. Standard library only.

The adapter collects real observations. This program owns the oracle and scores
them. Synthetic scorer tests do not measure Ledger or a model's capability.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

VERSION = "0.1"
LEVELS = {
    1: "Decision continuity",
    2: "Selective continuity across topics and sessions",
    3: "Executable continuation",
    4: "Team coordination during continuation",
    5: "Sustained continuity under long history and interruptions",
}


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dump(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def event(id_, topic, text, author="rachit", session="session-a"):
    return dict(id=id_, topic=topic, text=text, author=author, session=session)


def answer_check(key, value, sources, critical=True, accept=None):
    """`accept` lists further spellings of the SAME fact (D04). It never widens the fact itself:
    a phrasing difference must not be scored as a memory failure, and a different fact still fails."""
    check = dict(type="answer", key=key, expected=value, sources=sources, critical=critical)
    if accept:
        check["accept"] = list(accept)
    return check


def same_answer(value, check):
    """Exact equality, or — only when the check lists `accept` — equality after the collector's own
    identifier normalization (lowercase, collapsed whitespace, spaces to underscores)."""
    if value == check["expected"]:
        return True
    alternates = check.get("accept")
    if not alternates or not isinstance(value, str):
        return False
    norm = lambda s: "_".join(str(s).strip().lower().split())
    return norm(value) in {norm(a) for a in alternates}


FILLER = [
    "Reviewed last week's Play Console crash list; nothing in it touches the paywall.",
    "Renamed the onboarding illustration assets to match the new naming convention.",
    "Answered the support thread about renewal receipts; no product change needed.",
    "Checked the CI cache hit rate after the runner upgrade; it is back to normal.",
    "Drafted the weekly update for the astrologer partner team; it contains no decisions.",
    "Removed two feature flags that finished rolling out in June.",
    "Confirmed the Hindi copy review is scheduled for next sprint, not this one.",
    "Re-ran the nightly export job that failed on a transient storage timeout.",
]


def limits_events(noise_per_gap=2):
    """D04's history: three planted facts, each separated from the question that needs it.

    What each plant tests, and the failure it is designed to catch:

      cvr-first / cvr-correct  A number and, later, its correction. Both stay in history. A store that
                               ranks by similarity to "trial-start CVR" surfaces both and has no notion
                               of which one is current; the failure is answering 12.4.
      options / reject         One of two named options is dropped, with its reason, in the OTHER session.
                               The failure is proposing the price cut, because the text discussing it
                               matches the query better than the sentence retiring it.
      filter                   The number is Android-only. This is said once, as a mechanical query
                               detail, three turns before the number it qualifies and in the earlier
                               session; nobody ever calls it an assumption or a caveat. The failure is
                               reporting the CVR as if it described all users.

    Unrelated turns sit in every gap so the successor cannot recover a fact by reading a short history
    end to end. The gap size is a knob (--limits-noise): raise it to separate retrieval from recall.
    """
    out = []
    filled = [0]
    A, B = ("session-a", "rachit"), ("session-b", "agaaz")

    def plant(id_, text, who):
        session, author = who
        out.append(event(id_, "trial-cvr", text, author, session))

    def gap(who):
        session, author = who
        for _ in range(noise_per_gap):
            i = filled[0]
            filled[0] += 1
            out.append(event("fill-%02d" % i, "unrelated", FILLER[i % len(FILLER)], author, session))

    plant("cvr-first", "First pass on the marriage-intent paywall: trial-start CVR is 12.4 percent.", A)
    gap(A)
    plant("filter", "The pull has platform = android in the where clause, because the iOS export was "
                    "still backfilling when I ran it.", A)
    gap(A)
    plant("options", "Two ways to lift it are on the table: cut the price to 149, or extend the trial "
                     "to 14 days.", A)
    plant("reject", "Rachit rejected the price cut: the India store price is locked for the quarter. "
                    "We go with the 14 day trial.", B)
    gap(B)
    plant("cvr-correct", "Correction: 12.4 percent was wrong. It counted a user twice when they saw the "
                         "paywall twice. Deduplicated by user, trial-start CVR is 9.8 percent.", B)
    plant("recent", "Next step is to size the 14 day trial experiment from that CVR.", B)
    return out


def cases(noise_events=1000, minimum_origin_tokens=100000, maximum_boot_tokens=12000, limits_noise=2):
    """Public inputs and private assertions are separated by prepare()."""
    items = []

    def add(id_, level, title, sources, prompt, setup, checks):
        items.append(dict(id=id_, level=level, title=title, events=sources,
                          resume_prompt=prompt, setup=setup, checks=checks))

    common = [
        event("goal", "paywall", "Improve the locked marriage insight. Validate the small Android layout."),
        event("constraint", "paywall", "Binding instruction: keep price_inr at 199; do not change price to fix layout."),
        event("reject", "paywall", "Whole-card animation was rejected by Rachit as distracting. Animate the locked insight only."),
    ]
    add("D01", 1, "Mid-session constraint and rejected approach survive", common + [
        event("recent", "paywall", "The next check is CTA visibility. We have not changed the price instruction.")],
        "Continue the paywall. Return the binding price, selected animation target, and why whole-card animation was rejected.",
        ["Insert unrelated turns between the constraint and final message; reset the successor context."],
        [answer_check("price_inr", 199, ["constraint"]),
         answer_check("animation_target", "locked_insight", ["reject"]),
         answer_check("whole_card_rejection", "distracting", ["reject"])])

    add("D02", 1, "Superseded decisions do not remain current", [
        event("metric-v1", "conversion", "Decision metric-v1: conversion denominator is all sessions; initially accepted."),
        event("metric-v2", "conversion", "Decision metric-v2 supersedes metric-v1. Use unique exposed users as denominator. Confirmed by Agaaz.", "agaaz", "session-b")],
        "What conversion denominator is currently accepted, and which decision did it supersede?",
        ["Save both as real Ledger decision objects using the existing supersedes relation; preserve their IDs in the source map."],
        [answer_check("denominator", "unique_exposed_users", ["metric-v2"]),
         answer_check("superseded", "metric-v1", ["metric-v2"])])

    add("D03", 1, "Conflicting hypotheses remain unresolved", [
        event("hyp-a", "attribution", "On dataset snapshot A the join rate is 8 percent. This is a hypothesis based on that snapshot, not a final accepted result."),
        event("hyp-b", "attribution", "On dataset snapshot B the join rate is 100 percent. Dataset equivalence has not been checked; do not choose one rate yet.", "agaaz", "session-b")],
        "What is the accepted join rate and what needs resolving before we rely on it?",
        ["Ingest both sessions into the same investigation without confirming either hypothesis."],
        [answer_check("accepted_join_rate", None, ["hyp-a", "hyp-b"]),
         answer_check("status", "unresolved", ["hyp-a", "hyp-b"]),
         answer_check("next_check", "dataset_equivalence", ["hyp-b"])])

    add("D04", 1, "A corrected number, a rejected option, and an assumption nobody states",
        limits_events(limits_noise),
        "Continue the marriage-intent paywall work and size the 14 day trial experiment. "
        "Report the trial-start CVR percentage you would size it from, which of the two considered "
        "options the team rejected and the reason it was rejected, and any condition attached to that "
        "CVR that the team never wrote down as a caveat.",
        ["Type the events in order into one real origin session per session label; do not summarize them.",
         "Both the first number and its correction stay in history; nothing is deleted or edited.",
         "The population filter is stated once, as a mechanical query detail, in the earlier session only.",
         "Reset the successor; it gets its prompt and the condition's own retrieval tools, never this history."],
        [answer_check("trial_start_cvr_pct", 9.8, ["cvr-correct"]),
         answer_check("rejected_option", "price_cut", ["reject"],
                      accept=["price cut", "price_cut_149", "price cut to 149", "price_cut_to_149",
                              "cut_price", "cut price", "cut price to 149", "cut_price_to_149",
                              "149_price_cut", "price_reduction", "lower_price", "price_149"]),
         answer_check("rejection_reason", "locked", ["reject"],
                      accept=["price_locked", "price locked", "store_price_locked", "store price locked",
                              "india_price_locked", "locked_price", "store_listing_locked",
                              "price_locked_for_quarter", "locked_for_quarter", "store_listing"]),
         answer_check("cvr_caveat", "android", ["filter"],
                      accept=["android_only", "android only", "android_users", "android users",
                              "platform_android", "android_platform", "android_traffic",
                              "excludes_ios", "ios_excluded", "no_ios"])])

    mixed = common + [
        event("hire", "hiring", "Hiring plan: interview two infrastructure candidates next week."),
        event("attr", "attribution", "Attribution investigation: compare dataset snapshots before editing the join."),
        event("copy", "copy", "Landing-page draft: Every user sees the interface most likely to convert them."),
        event("eval", "evaluation", "Model evaluation: use signup-date holdout, not random row split."),
        event("pending", "paywall", "The small-screen layout fix is saved. Its validation has not run.")]
    add("R01", 2, "One session, five interleaved topics", mixed,
        "Continue only the marriage paywall work. State the binding price and next unfinished action.",
        ["Use one actual origin session with these topics interleaved; let automatic classification run.",
         "Query by the topic through ledger_records/ledger_resume, never by a fixture-provided database ID."],
        [answer_check("price_inr", 199, ["constraint"]),
         answer_check("next_action", "validate_small_screen", ["pending"]),
         dict(type="selected_topic", expected="paywall", critical=True)])

    add("R02", 2, "One work record across teammates and harnesses", [
        event("setup", "paywall", "Use the existing WebView preview; native Android preview is not configured."),
        event("fix", "paywall", "I saved a fix in layout.json. The 640px viewport remains untested.", "agaaz", "session-b")],
        "Continue the shared paywall work. Which preview should you use and which viewport still needs validation?",
        ["Origin A is Rachit/Codex; origin B is Agaaz/Claude; each writes through its actual local helper."],
        [answer_check("preview", "webview", ["setup"]),
         answer_check("unverified_viewport", 640, ["fix"])])

    layout = json.dumps({"price_inr": 199, "cta_height": 48, "safe_bottom": 0, "content_gap": 24}, indent=2) + "\n"
    source_files = {"layout.json": layout, "generated/study.txt": "locked insight animation v3\n"}
    add("E01", 3, "Recover tracked, untracked, and deleted files", common + [
        event("saved", "paywall", "Saved layout.json and generated/study.txt; removed obsolete.txt. Small-screen test is pending.")],
        "Continue the unfinished small-screen validation from the last remotely verified code snapshot.",
        ["Initialize an isolated Git repo with obsolete.txt, then delete it in the origin worktree.",
         "Write seed_files; keep generated/study.txt untracked and policy-included.",
         "Wait for remote-verified snapshot; reset successor; recover into a different worktree.",
         "Collector must copy the pre-action recovered files before the successor edits them."],
        [dict(type="file_hash", path=k, sha256=digest(v), critical=True) for k, v in source_files.items()] +
        [dict(type="absent_file", path="obsolete.txt", critical=True),
         answer_check("next_action", "validate_small_screen", ["saved"])])
    items[-1]["seed_files"] = source_files

    add("E02", 3, "Unknown external outcome is not replayed", [
        event("op", "experiment", "Operation create-experiment-7 was requested. The client disconnected before its outcome was captured. No idempotent retry support is confirmed.")],
        "Continue setting up the experiment. State the first action and perform the appropriate outcome check using the fixture tool.",
        ["Use a fake external service with a create operation that succeeds remotely but disconnects before returning.",
         "Record actual successor tool calls; fixture offers read_experiment_status and create_experiment."],
        [answer_check("first_action", "check_existing_outcome", ["op"]),
         dict(type="trace", required=["read_experiment_status"], forbidden=["create_experiment"],
              operation_id="create-experiment-7", critical=True)])

    add("E03", 3, "Successor finishes the work and preserves the constraint", common + [
        event("layout-contract", "paywall", "Fixture layout: CTA top = min(content_height + content_gap, viewport_height - safe_bottom - cta_height). Keep CTA at least 20px above the bottom edge for 480, 640, and 800px viewports."),
        event("unfinished", "paywall", "layout.json uses safe_bottom=0. It still clips the required safe area. Correct and validate the configuration; preserve price and CTA height.")],
        "Finish the saved layout fix and validate it. Return the updated file, not just a proposed fix.",
        ["Restore seed_files into origin; capture and recover normally.",
         "Allow successor to edit only the fixture worktree; collector copies final files after it finishes.",
         "The independent scorer evaluates final JSON numerically; it does not execute agent-written code."],
        [dict(type="layout", critical=True)])
    items[-1]["seed_files"] = {"layout.json": layout}

    add("C01", 4, "Concurrent claims and stale uploads preserve both branches", common,
        "Continue this thread while the original contributor may still be active.",
        ["Submit two independent continuation requests concurrently against the same thread.",
         "After one succeeds, upload an event from the old generation and query head and fork routing.",
         "Collector writes actual responses into ownership.json; never derive them from the successor's prose."],
        [dict(type="ownership", critical=True)])

    add("C02", 4, "Third agent's parallel work survives handoff", common,
        "Continue the paywall while another agent works independently on attribution.",
        ["Keep a third actual local agent running in a distinct worktree for the same repo.",
         "Record its file sentinel hashes and a successful tool operation before and after the handoff.",
         "Collector writes parallel.json with paths, sentinels, and actual operation success."],
        [dict(type="parallel", critical=True)])

    long_events = [event("long-goal", "paywall", "Continue the marriage paywall investigation.")]
    for i in range(noise_events):
        if i == noise_events // 2:
            long_events.append(event("middle-constraint", "paywall", "Standing instruction: keep price_inr at 199 until explicitly changed; no later instruction changes it."))
        long_events.append(event("noise-%06d" % i, "unrelated-%d" % (i % 5),
                                 "Historical unrelated diagnostic %d: candidate set reviewed, no decision about paywall pricing. " % i + "log-entry " * 30))
    long_events.append(event("long-last", "paywall", "Resume the Android check. The current code snapshot is the starting point."))
    add("L01", 5, "Long history and repeated compaction preserve standing instructions", long_events,
        "Continue the paywall. What price instruction still applies?",
        ["Ingest through the origin harness, with at least three actual compactions/context resets.",
         "Do not pass original history directly to the successor. Give only its prompt and Ledger tools.",
         "Use provider/runtime token counters for measured history size; noise_events is not a token count.",
         "Record compaction/reset count in stress.json."],
        [answer_check("price_inr", 199, ["middle-constraint"]),
         dict(type="stress", minimum_compactions=3, minimum_origin_tokens=minimum_origin_tokens,
              maximum_boot_tokens=maximum_boot_tokens, critical=True)])

    add("L02", 5, "Classifier lag does not masquerade as complete context", mixed,
        "Continue the paywall. Is its work record current, and is there any relevant unassigned work?",
        ["Delay/disable classifier while raw capture proceeds beyond its cursor.",
         "Create a relevant unassigned span and verify it survives a later classifier run.",
         "Collector writes coverage.json from system cursors and the actual resume output."],
        [dict(type="coverage", critical=True)])
    return items


def prepare(root, noise_events, minimum_origin_tokens=100000, maximum_boot_tokens=12000,
            limits_noise=2, only=None):
    """`only` builds a focused suite: public/ and the private oracle contain just those cases, so a
    report over it is self-consistent rather than mostly `not_run`. A level is then demonstrated only
    over the cases present, which is why a focused report states its case list."""
    root = Path(root)
    if root.exists() and any(root.iterdir()):
        raise ValueError("prepare target must be absent or empty")
    manifest = []
    selected = cases(noise_events, minimum_origin_tokens, maximum_boot_tokens, limits_noise)
    if only:
        known = {c["id"] for c in selected}
        unknown = [c for c in only if c not in known]
        if unknown:
            raise ValueError("unknown case(s): " + ", ".join(unknown))
        selected = [c for c in selected if c["id"] in set(only)]
    for case in selected:
        public = {k: v for k, v in case.items() if k != "checks"}
        # Keys/types are a response schema, not answer values.
        public["answer_keys"] = [c["key"] for c in case["checks"] if c["type"] == "answer"]
        public["successor_answer_contract"] = {"answers": {"<requested_key>": {"value": "<answer>", "evidence_ids": ["<source ref>"]}}}
        if case["id"] == "L01":
            public["stress_requirements"] = dict(minimum_origin_tokens=minimum_origin_tokens,
                                                 maximum_boot_tokens=maximum_boot_tokens,
                                                 minimum_compactions=3)
        dump(root / "public" / (case["id"] + ".json"), public)
        manifest.append(case)
    dump(root / "private" / "oracle.json", manifest)
    print("Prepared %d cases. Keep private/ inaccessible to both agents." % len(manifest))


def load_object(path):
    obj = json.loads(Path(path).read_text())
    if not isinstance(obj, dict):
        raise ValueError("expected JSON object")
    return obj


def inside(base, relative):
    base = Path(base).resolve()
    path = (base / relative).resolve()
    if path != base and base not in path.parents:
        raise ValueError("path outside observation bundle")
    return path


def evidence_valid(case, obs, source_ids, base):
    sources = {e["id"]: e["text"] for e in case["events"]}
    retrieved = obs.get("retrieved_evidence", {})
    for id_ in source_ids:
        entry = retrieved.get(id_, {})
        if (id_ not in sources or not isinstance(entry, dict)
                or entry.get("text") != sources[id_]
                or not entry.get("system_ref") or not entry.get("raw_ref")):
            return False
        raw = inside(base, entry["raw_ref"])
        if not raw.is_file() or not raw.stat().st_size:
            return False
    return True


def check_one(check, case, obs, base):
    kind = check["type"]
    if kind == "answer":
        item = obs.get("answers", {}).get(check["key"], {})
        if "value" not in item:
            return "missing", "No successor answer for " + check["key"]
        if not same_answer(item["value"], check):
            return "fail", "Incorrect " + check["key"]
        if not set(check["sources"]).issubset(set(item.get("evidence_ids", []))):
            return "fail", "Required supporting evidence not cited"
        if not evidence_valid(case, obs, check["sources"], base):
            return "fail", "Citation not backed by retrieved source text and real source reference"
        return "pass", "Correct answer with retrieved source evidence"
    if kind in ("file_hash", "absent_file"):
        folder = obs.get("recovered_files")
        if not folder:
            return "missing", "No pre-action recovered-file bundle"
        path = inside(inside(base, folder), check["path"])
        if kind == "absent_file":
            return ("pass", "Deletion preserved") if not path.exists() else ("fail", "Deleted file reappeared")
        if not path.is_file():
            return "fail", "Required file missing"
        return ("pass", "Exact file bytes recovered") if hashlib.sha256(path.read_bytes()).hexdigest() == check["sha256"] else ("fail", "Recovered file differs from saved version")
    if kind == "selected_topic":
        if "selected_topic" not in obs:
            return "missing", "No selected record/topic observation"
        return ("pass", "Requested topic selected") if obs["selected_topic"] == check["expected"] else ("fail", "Wrong topic selected")
    if kind == "layout":
        if not obs.get("final_files"):
            return "missing", "No successor's final file bundle"
        path = inside(inside(base, obs["final_files"]), "layout.json")
        if not path.is_file():
            return "fail", "No final layout.json"
        cfg = load_object(path)
        keys = ("price_inr", "cta_height", "safe_bottom", "content_gap")
        if not all(type(cfg.get(k)) in (int, float) for k in keys):
            return "fail", "Invalid layout field types"
        if cfg["price_inr"] != 199 or cfg["cta_height"] != 48 or cfg["content_gap"] != 24:
            return "fail", "Unrelated contract/price was changed"
        if cfg["safe_bottom"] != 20:
            return "fail", "Safe-area fix not applied as required"
        for viewport in (480, 640, 800):
            for content in (100, 470, 760, 1200):
                top = min(content + cfg["content_gap"], viewport - cfg["safe_bottom"] - cfg["cta_height"])
                if top < 0 or top + cfg["cta_height"] > viewport - 20:
                    return "fail", "Independent layout check failed"
        return "pass", "Final file passes 12 independent viewport/content checks"
    artifact_keys = {"trace": "actions_file", "ownership": "ownership_file", "parallel": "parallel_file", "stress": "stress_file", "coverage": "coverage_file"}
    key = artifact_keys.get(kind)
    if key:
        if not obs.get(key):
            return "missing", "No collector artifact: " + key
        data = load_object(inside(base, obs[key]))
        if not data.get("raw_trace_refs"):
            return "missing", "Collector evidence needs raw trace references"
        for ref in data["raw_trace_refs"]:
            path = inside(base, ref)
            if not path.is_file() or not path.stat().st_size:
                return "missing", "Missing raw trace attachment"
        if kind == "trace":
            names = [a.get("tool") for a in data.get("actions", [])]
            ok = (all(n in names for n in check["required"])
                  and not any(n in names for n in check["forbidden"])
                  and any(a.get("tool") == "read_experiment_status" and a.get("operation_id") == check["operation_id"]
                          for a in data.get("actions", [])))
            return ("pass", "Observed tool actions satisfy outcome-reconciliation rule") if ok else ("fail", "Required read missing or unknown operation replayed")
        if kind == "ownership":
            claims = data.get("claim_results", [])
            ok = (len(claims) == 2
                  and sum(c.get("acquired") is True and c.get("conflict") is False for c in claims) == 1
                  and sum(c.get("acquired") is False and c.get("conflict") is True for c in claims) == 1
                  and data.get("new_generation", -1) > data.get("old_generation", -1)
                  and bool(data.get("head_after_takeover"))
                  and data.get("head_after_takeover") == data.get("head_after_stale_upload")
                  and bool(data.get("fork_thread_id")) and bool(data.get("stale_event_id"))
                  and data.get("stale_event_thread_id") == data.get("fork_thread_id"))
            return ("pass", "One owner; late event preserved on fork") if ok else ("fail", "Ownership or stale-routing invariant violated")
        if kind == "parallel":
            ok = (data.get("worktree_a") and data.get("worktree_b")
                  and data["worktree_a"] != data["worktree_b"]
                  and data.get("third_agent_progressed") is True
                  and data.get("sentinel_before")
                  and data["sentinel_before"] == data.get("sentinel_after"))
            return ("pass", "Independent worktree preserved and third agent progressed") if ok else ("fail", "Parallel work did not survive")
        if kind == "stress":
            ok = (data.get("compactions_or_resets", 0) >= check["minimum_compactions"]
                  and data.get("measured_origin_tokens", 0) >= check["minimum_origin_tokens"]
                  and type(data.get("successor_boot_tokens")) is int
                  and 0 < data["successor_boot_tokens"] <= check["maximum_boot_tokens"]
                  and data.get("successor_got_original_history_directly") is False)
            return ("pass", "Repeated-reset protocol observed; token size recorded") if ok else ("fail", "Long-history protocol not satisfied")
        if kind == "coverage":
            ok = (isinstance(data.get("captured_seq"), int) and isinstance(data.get("classified_seq"), int)
                  and data["captured_seq"] > data["classified_seq"]
                  and data.get("resume_disclosed_lag") is True
                  and data.get("unassigned_visible") is True
                  and data.get("unassigned_preserved_after_next_pass") is True)
            return ("pass", "Lag disclosed and unassigned evidence preserved") if ok else ("fail", "Incomplete organization presented as complete or evidence lost")
    return "fail", "Unknown evaluator check " + kind


def score_case(case, obs, base, direction=None):
    if obs.get("status") in ("skipped", "error"):
        return dict(case=case["id"], level=case["level"], status="not_run", checks=[],
                    reason=obs.get("reason", "Adapter did not execute case"), provenance=obs.get("provenance", {}))
    provenance = obs.get("provenance", {})
    if (obs.get("status") != "completed" or not isinstance(provenance, dict)
            or provenance.get("mode") != "live" or not provenance.get("system_revision") or not provenance.get("run_ref")):
        return dict(case=case["id"], level=case["level"], status="unverified", checks=[],
                    reason="Not a live-system observation with a revision and run reference", provenance=provenance)
    if direction:
        origin, successor = direction.split("-to-")
        if (provenance.get("origin_harness"), provenance.get("successor_harness")) != (origin, successor):
            return dict(case=case["id"], level=case["level"], status="unverified", checks=[],
                        reason="Observed harnesses do not match requested handoff direction", provenance=provenance)
    results = []
    for check in case["checks"]:
        try:
            status, detail = check_one(check, case, obs, base)
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
            status, detail = "missing", "Malformed or inaccessible collector evidence: " + str(exc)
        results.append(dict(type=check["type"], key=check.get("key", check.get("path")),
                            status=status, detail=detail, critical=check.get("critical", True)))
    statuses = {r["status"] for r in results}
    status = "fail" if "fail" in statuses else "unverified" if "missing" in statuses else "pass"
    return dict(case=case["id"], level=case["level"], status=status, checks=results,
                provenance=provenance, metrics=obs.get("metrics", {}))


def report(root, output, repetitions, directions):
    oracle = json.loads((Path(root) / "private/oracle.json").read_text())
    output = Path(output)
    results = []
    for case in oracle:
        for direction in directions:
            for repeat in range(1, repetitions + 1):
                base = output / "observations" / case["id"] / direction / str(repeat)
                try:
                    obs = load_object(base / "observation.json")
                except (OSError, ValueError):
                    obs = {"status": "skipped", "reason": "No valid observation bundle"}
                result = score_case(case, obs, base, direction)
                result.update(direction=direction, repetition=repeat)
                results.append(result)
    level_results = {}
    highest = 0
    for n, name in LEVELS.items():
        rows = [r for r in results if r["level"] == n]
        passed = sum(r["status"] == "pass" for r in rows)
        failures = sum(r["status"] == "fail" for r in rows)
        missing = len(rows) - passed - failures
        qualified = bool(rows) and passed == len(rows)
        level_results[n] = dict(name=name, passed=passed, failed=failures, missing_or_unverified=missing,
                                total=len(rows), passed_all_observed_cases=qualified)
        if n == highest + 1 and qualified:
            highest = n
    full_matrix = repetitions >= 3 and set(directions) == {"codex-to-claude", "claude-to-codex"}
    result = dict(suite_version=VERSION, generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  suite_sha256=hashlib.sha256((Path(root) / "private/oracle.json").read_bytes()).hexdigest(),
                  protocol=dict(repetitions=repetitions, directions=directions, qualification_matrix_selected=full_matrix),
                  provisional_level_on_selected_matrix=highest,
                  pilot_level_demonstrated=highest if full_matrix else None,
                  note="Strict fixture acceptance, not a statistical guarantee. Collector artifacts are trusted observations; scorer does not authenticate their origin.",
                  levels=level_results, results=results)
    dump(output / "report.json", result)
    lines = ["# Continuity evaluation results", "", "These results cover only the supplied observation bundles.", "",
             "Pilot level demonstrated: **%s**" % ((highest if highest else "None yet") if full_matrix else "Not assessed: run both directions with at least three repetitions"), "",
             "| Level | Capability | Passed | Failed | Not run / unverified |",
             "| --- | --- | --- | --- | --- |"]
    for n, val in level_results.items():
        lines.append("| %s | %s | %s/%s | %s | %s |" % (n, val["name"], val["passed"], val["total"], val["failed"], val["missing_or_unverified"]))
    lines += ["", "## Case results", "", "| Case | Direction | Repeat | Status |", "| --- | --- | --- | --- |"]
    for r in results:
        lines.append("| %s | %s | %s | %s |" % (r["case"], r["direction"], r["repetition"], r["status"]))
    lines += ["", "A level of 0 means no level verified; it does not mean the system has no continuity.",
              "No percentage is a population reliability estimate. Missing evidence never counts as a pass.",
              "Inspect report.json for individual checks and recorded latency/token metrics."]
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.md").write_text("\n".join(lines) + "\n")
    print(str(output / "report.md"))
    return result


def run(root, output, adapter, repetitions, directions, timeout):
    root, output = Path(root).resolve(), Path(output).resolve()
    command = json.loads(Path(adapter).read_text())
    if not isinstance(command, list) or not command or not all(isinstance(a, str) for a in command):
        raise ValueError("adapter config must be a JSON argv array; shell strings are not accepted")
    run_id = uuid.uuid4().hex[:12]
    for public_file in sorted((root / "public").glob("*.json")):
        case = load_object(public_file)
        for direction in directions:
            for repeat in range(1, repetitions + 1):
                base = output / "observations" / case["id"] / direction / str(repeat)
                if (base / "observation.json").exists():
                    raise ValueError("Refusing to overwrite prior trial: " + str(base))
                base.mkdir(parents=True, exist_ok=True)
                request = dict(protocol_version=1, case=case, direction=direction, repetition=repeat,
                               output_dir=str(base), trial_id="%s-%s-%s-%s" % (run_id, case["id"], direction, repeat))
                print("Running", request["trial_id"], flush=True)
                try:
                    result = subprocess.run(command, input=json.dumps(request), text=True, capture_output=True, timeout=timeout)
                    # Raw stderr may contain credentials. It is not automatically archived.
                    if result.returncode:
                        obs = {"status": "error", "reason": "Adapter exited with code %d; inspect its local redacted logs" % result.returncode}
                    else:
                        obs = json.loads(result.stdout)
                        if not isinstance(obs, dict):
                            raise ValueError("adapter response must be object")
                except subprocess.TimeoutExpired:
                    obs = {"status": "error", "reason": "Adapter timed out; independently check its managed fixture processes"}
                except (ValueError, OSError):
                    obs = {"status": "error", "reason": "Adapter invocation or JSON response invalid"}
                dump(base / "observation.json", obs)
    return report(root, output, repetitions, directions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--out", required=True)
    p.add_argument("--noise-events", type=int, default=1000)
    p.add_argument("--minimum-origin-tokens", type=int, default=100000)
    p.add_argument("--maximum-boot-tokens", type=int, default=12000)
    p.add_argument("--limits-noise", type=int, default=2, help="D04: unrelated turns in each gap between planted facts")
    p.add_argument("--cases", nargs="+", help="Build a focused suite containing only these case ids")
    for name in ("score", "run"):
        p = sub.add_parser(name)
        p.add_argument("--suite", required=True)
        p.add_argument("--out", required=True)
        p.add_argument("--repetitions", type=int, default=3)
        p.add_argument("--fail-under-level", type=int, choices=range(1, 6), help="Exit 1 unless the full pilot matrix demonstrates this level")
        p.add_argument("--directions", nargs="+", choices=["codex-to-claude", "claude-to-codex"], default=["codex-to-claude", "claude-to-codex"])
        if name == "run":
            p.add_argument("--adapter", required=True)
            p.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    if args.command == "prepare":
        if args.noise_events < 2:
            parser.error("noise-events must be at least 2")
        if args.minimum_origin_tokens < 1 or args.maximum_boot_tokens < 1:
            parser.error("token limits must be positive")
        if args.limits_noise < 0:
            parser.error("limits-noise must not be negative")
        prepare(args.out, args.noise_events, args.minimum_origin_tokens, args.maximum_boot_tokens,
                args.limits_noise, args.cases)
    else:
        if args.repetitions < 1:
            parser.error("repetitions must be positive")
        if len(set(args.directions)) != len(args.directions):
            parser.error("directions must be unique")
        if args.command == "run":
            if args.timeout < 1:
                parser.error("timeout must be positive")
            result = run(args.suite, args.out, args.adapter, args.repetitions, args.directions, args.timeout)
        else:
            result = report(args.suite, args.out, args.repetitions, args.directions)
        if args.fail_under_level and (result["pilot_level_demonstrated"] or 0) < args.fail_under_level:
            sys.exit(1)


if __name__ == "__main__":
    main()
