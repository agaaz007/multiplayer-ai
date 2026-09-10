#!/usr/bin/env python3
"""Integration boundary; intentionally does not simulate a successful Ledger run.

Read ADAPTER.md before replacing collect_trial(). This controller may see case
inputs. The successor must see only the resume prompt/answer keys, its recovered
worktree, and the Ledger tools it would normally have.
"""
import json
import sys


def collect_trial(request):
    # Implement in the Ledger repository using its existing helpers/fixtures:
    # 1. Create a unique, isolated test project/repo for request['trial_id'].
    # 2. Run origin event inputs through the real harness and local helper.
    # 3. Apply this case's setup, including capture/classifier/fault controls.
    # 4. Start a fresh successor in request['direction']. Retrieve through Ledger.
    # 5. Independently collect tool responses, DB/ref observations and file bytes.
    # 6. Write evidence under request['output_dir']; return the observation JSON.
    # 7. Clean up only processes/resources this adapter created, even on failure.
    # Never convert origin event inputs directly into retrieved_evidence.
    return {
        "status": "skipped",
        "reason": "Real Ledger/harness integration is not configured; see ADAPTER.md",
        "provenance": {"mode": "unconfigured"},
    }


def main():
    request = json.load(sys.stdin)
    if request.get("protocol_version") != 1:
        raise ValueError("Unsupported adapter protocol")
    response = collect_trial(request)
    # stdout is exclusively one JSON response; use redacted local logs for debug.
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
