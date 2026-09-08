"""Synthetic scorer checks only. None of these tests runs Ledger or an agent."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import continuity_eval as ev


class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.cases = {c["id"]: c for c in ev.cases(noise_events=4)}

    def observation(self, case_id):
        """Construct synthetic expected observations to exercise the scorer."""
        case = self.cases[case_id]
        ev.dump(self.base / "raw/retrieval.json", {"events": case["events"]})
        return dict(
            status="completed",
            provenance=dict(mode="live", system_revision="synthetic-unit-test-only",
                            run_ref="synthetic-unit-test-only", origin_harness="codex", successor_harness="claude"),
            answers={c["key"]: {"value": c["expected"], "evidence_ids": c["sources"]}
                     for c in case["checks"] if c["type"] == "answer"},
            retrieved_evidence={e["id"]: {"text": e["text"], "system_ref": "synthetic/" + e["id"],
                                           "raw_ref": "raw/retrieval.json"} for e in case["events"]},
        )

    def score(self, id_, obs):
        return ev.score_case(self.cases[id_], obs, self.base, "codex-to-claude")

    def artifact(self, obs, key, payload):
        filename = key + ".json"
        ev.dump(self.base / "raw/collector.json", payload)
        ev.dump(self.base / filename, {**payload, "raw_trace_refs": ["raw/collector.json"]})
        obs[key] = filename

    def test_supported_decisions_pass(self):
        for id_ in ("D01", "D02", "D03", "R02"):
            with self.subTest(id_=id_):
                self.assertEqual(self.score(id_, self.observation(id_))["status"], "pass")

    def test_wrong_price_fails(self):
        obs = self.observation("D01")
        obs["answers"]["price_inr"]["value"] = 299
        self.assertEqual(self.score("D01", obs)["status"], "fail")

    def test_superseded_definition_fails(self):
        obs = self.observation("D02")
        obs["answers"]["denominator"]["value"] = "all_sessions"
        self.assertEqual(self.score("D02", obs)["status"], "fail")

    def test_guessing_resolution_fails(self):
        obs = self.observation("D03")
        obs["answers"]["accepted_join_rate"]["value"] = 100
        self.assertEqual(self.score("D03", obs)["status"], "fail")

    def test_missing_or_fabricated_evidence_fails(self):
        for edit in ("remove_citation", "wrong_text", "empty_reference", "missing_raw"):
            with self.subTest(edit=edit):
                obs = self.observation("D01")
                if edit == "remove_citation":
                    obs["answers"]["price_inr"]["evidence_ids"] = []
                elif edit == "wrong_text":
                    obs["retrieved_evidence"]["constraint"]["text"] = "invented"
                elif edit == "empty_reference":
                    obs["retrieved_evidence"]["constraint"]["system_ref"] = ""
                else:
                    obs["retrieved_evidence"]["constraint"].pop("raw_ref")
                self.assertEqual(self.score("D01", obs)["status"], "fail")

    def test_missing_answer_is_unverified(self):
        obs = self.observation("D01")
        obs["answers"].pop("price_inr")
        self.assertEqual(self.score("D01", obs)["status"], "unverified")

    def test_unconfigured_and_failed_adapters_do_not_pass(self):
        for status in ("skipped", "error"):
            self.assertEqual(self.score("D01", {"status": status})["status"], "not_run")

    def test_synthetic_mode_and_wrong_harness_are_unverified(self):
        obs = self.observation("D01")
        obs["provenance"]["mode"] = "synthetic"
        self.assertEqual(self.score("D01", obs)["status"], "unverified")
        obs = self.observation("D01")
        obs["provenance"]["successor_harness"] = "codex"
        self.assertEqual(self.score("D01", obs)["status"], "unverified")

    def test_malformed_nested_evidence_does_not_crash(self):
        obs = self.observation("D01")
        obs["answers"] = []
        self.assertEqual(self.score("D01", obs)["status"], "unverified")
        obs["provenance"] = []
        self.assertEqual(self.score("D01", obs)["status"], "unverified")

    def test_wrong_topic_fails_even_with_right_facts(self):
        obs = self.observation("R01")
        obs["selected_topic"] = "hiring"
        self.assertEqual(self.score("R01", obs)["status"], "fail")
        obs["selected_topic"] = "paywall"
        self.assertEqual(self.score("R01", obs)["status"], "pass")

    def recovered(self):
        obs = self.observation("E01")
        obs["recovered_files"] = "recovered"
        for name, content in self.cases["E01"]["seed_files"].items():
            path = self.base / "recovered" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        return obs

    def test_exact_recovery_and_deletion(self):
        obs = self.recovered()
        self.assertEqual(self.score("E01", obs)["status"], "pass")
        (self.base / "recovered/obsolete.txt").write_text("resurrected")
        self.assertEqual(self.score("E01", obs)["status"], "fail")

    def test_missing_or_modified_file_fails(self):
        obs = self.recovered()
        path = self.base / "recovered/generated/study.txt"
        path.write_text("different bytes")
        self.assertEqual(self.score("E01", obs)["status"], "fail")
        path.unlink()
        self.assertEqual(self.score("E01", obs)["status"], "fail")

    def test_path_escape_is_rejected(self):
        obs = self.recovered()
        obs["recovered_files"] = "../outside"
        self.assertEqual(self.score("E01", obs)["status"], "unverified")

    def test_external_operation_must_reconcile_correct_id(self):
        obs = self.observation("E02")
        actions = [{"tool": "read_experiment_status", "operation_id": "create-experiment-7"}]
        self.artifact(obs, "actions_file", {"actions": actions})
        self.assertEqual(self.score("E02", obs)["status"], "pass")
        actions[0]["operation_id"] = "another-operation"
        self.artifact(obs, "actions_file", {"actions": actions})
        self.assertEqual(self.score("E02", obs)["status"], "fail")

    def test_external_replay_fails_even_after_correct_read(self):
        obs = self.observation("E02")
        self.artifact(obs, "actions_file", {"actions": [
            {"tool": "read_experiment_status", "operation_id": "create-experiment-7"},
            {"tool": "create_experiment"}]})
        self.assertEqual(self.score("E02", obs)["status"], "fail")

    def test_final_file_is_checked_independently(self):
        obs = self.observation("E03")
        obs["final_files"] = "final"
        cfg = {"price_inr": 199, "cta_height": 48, "safe_bottom": 20, "content_gap": 24}
        ev.dump(self.base / "final/layout.json", cfg)
        self.assertEqual(self.score("E03", obs)["status"], "pass")
        for key, wrong in (("price_inr", 99), ("safe_bottom", 0), ("cta_height", 24), ("content_gap", "24")):
            ev.dump(self.base / "final/layout.json", {**cfg, key: wrong})
            self.assertEqual(self.score("E03", obs)["status"], "fail")

    def ownership(self):
        return dict(claim_results=[dict(acquired=True, conflict=False), dict(acquired=False, conflict=True)],
                    old_generation=2, new_generation=3, head_after_takeover="head-3",
                    head_after_stale_upload="head-3", fork_thread_id="fork-1",
                    stale_event_id="late-event", stale_event_thread_id="fork-1")

    def test_claim_and_fork_invariants(self):
        obs = self.observation("C01")
        payload = self.ownership()
        self.artifact(obs, "ownership_file", payload)
        self.assertEqual(self.score("C01", obs)["status"], "pass")
        for key, bad in (("new_generation", 2), ("head_after_stale_upload", "overwritten"),
                         ("stale_event_thread_id", "original-thread"), ("stale_event_id", None)):
            self.artifact(obs, "ownership_file", {**payload, key: bad})
            self.assertEqual(self.score("C01", obs)["status"], "fail")

    def test_double_claim_and_ambiguous_claim_results_fail(self):
        obs = self.observation("C01")
        for claims in ([dict(acquired=True, conflict=False)] * 2,
                       [dict(acquired=True, conflict=True), dict(acquired=False, conflict=False)]):
            self.artifact(obs, "ownership_file", {**self.ownership(), "claim_results": claims})
            self.assertEqual(self.score("C01", obs)["status"], "fail")

    def test_parallel_work_must_progress_and_preserve_sentinel(self):
        obs = self.observation("C02")
        payload = dict(worktree_a="/work/a", worktree_b="/work/b", third_agent_progressed=True,
                       sentinel_before="hash-a", sentinel_after="hash-a")
        self.artifact(obs, "parallel_file", payload)
        self.assertEqual(self.score("C02", obs)["status"], "pass")
        for key, bad in (("worktree_b", "/work/a"), ("third_agent_progressed", False), ("sentinel_after", "changed")):
            self.artifact(obs, "parallel_file", {**payload, key: bad})
            self.assertEqual(self.score("C02", obs)["status"], "fail")

    def test_long_history_requires_measured_size_budget_and_resets(self):
        obs = self.observation("L01")
        payload = dict(compactions_or_resets=3, measured_origin_tokens=100000, successor_boot_tokens=10000,
                       successor_got_original_history_directly=False)
        self.artifact(obs, "stress_file", payload)
        self.assertEqual(self.score("L01", obs)["status"], "pass")
        for key, bad in (("measured_origin_tokens", 10), ("successor_boot_tokens", 50000),
                         ("compactions_or_resets", 2), ("successor_got_original_history_directly", True)):
            self.artifact(obs, "stress_file", {**payload, key: bad})
            self.assertEqual(self.score("L01", obs)["status"], "fail")

    def test_lag_and_preservation_must_be_observed(self):
        obs = self.observation("L02")
        payload = dict(captured_seq=100, classified_seq=90, resume_disclosed_lag=True,
                       unassigned_visible=True, unassigned_preserved_after_next_pass=True)
        self.artifact(obs, "coverage_file", payload)
        self.assertEqual(self.score("L02", obs)["status"], "pass")
        for key, bad in (("classified_seq", 100), ("resume_disclosed_lag", False),
                         ("unassigned_preserved_after_next_pass", False)):
            self.artifact(obs, "coverage_file", {**payload, key: bad})
            self.assertEqual(self.score("L02", obs)["status"], "fail")

    def test_missing_raw_trace_is_unverified(self):
        obs = self.observation("C01")
        self.artifact(obs, "ownership_file", self.ownership())
        (self.base / "raw/collector.json").unlink()
        self.assertEqual(self.score("C01", obs)["status"], "unverified")

    def test_private_answers_not_in_public_case(self):
        suite = self.base / "suite"
        ev.prepare(suite, 4)
        public = json.loads((suite / "public/D01.json").read_text())
        self.assertNotIn("checks", public)
        self.assertEqual(public["answer_keys"], ["price_inr", "animation_target", "whole_card_rejection"])
        self.assertTrue((suite / "private/oracle.json").exists())
        with self.assertRaises(ValueError):
            ev.prepare(suite, 4)

    def test_report_does_not_qualify_missing_runs_or_smoke_matrix(self):
        suite = self.base / "suite"
        ev.prepare(suite, 4)
        directions = ["codex-to-claude", "claude-to-codex"]
        report = ev.report(suite, self.base / "full", 3, directions)
        self.assertEqual(report["pilot_level_demonstrated"], 0)
        self.assertEqual(len(report["results"]), 72)
        self.assertTrue(all(r["status"] == "not_run" for r in report["results"]))
        smoke = ev.report(suite, self.base / "smoke", 1, directions[:1])
        self.assertIsNone(smoke["pilot_level_demonstrated"])

    def test_cumulative_level_stops_at_first_gap(self):
        suite, output = self.base / "suite", self.base / "results"
        ev.prepare(suite, 4)
        for id_ in ("D01", "D02", "D03", "R02"):
            obs = self.observation(id_)
            for direction in ("codex-to-claude", "claude-to-codex"):
                obs["provenance"]["origin_harness"], obs["provenance"]["successor_harness"] = direction.split("-to-")
                for repeat in range(1, 4):
                    trial = output / "observations" / id_ / direction / str(repeat)
                    ev.dump(trial / "raw/retrieval.json", {"synthetic": True})
                    ev.dump(trial / "observation.json", obs)
        report = ev.report(suite, output, 3, ["codex-to-claude", "claude-to-codex"])
        self.assertEqual(report["pilot_level_demonstrated"], 1)
        self.assertEqual(report["levels"][2]["missing_or_unverified"], 6)

    def test_ci_gate_fails_for_unmeasured_system(self):
        suite = self.base / "suite"
        ev.prepare(suite, 4)
        result = subprocess.run([sys.executable, str(Path(ev.__file__)), "score", "--suite", str(suite),
                                 "--out", str(self.base / "ci"), "--fail-under-level", "1"], capture_output=True)
        self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
