#!/usr/bin/env bash
# Phase 1 of the continuity benchmark: ours vs gbrain, six cases, Codex→Claude, one repetition.
# Usage: eval/run-phase1.sh [run-name] [--directions "codex-to-claude claude-to-codex"] [--repetitions N]
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${1:-phase1-$(date -u +%Y%m%dT%H%M%SZ)}"; shift || true
DIRS="codex-to-claude"; REPS=1
while [ $# -gt 0 ]; do case "$1" in --directions) DIRS="$2"; shift 2;; --repetitions) REPS="$2"; shift 2;; *) echo "unknown arg $1"; exit 2;; esac; done
OUT="eval/runs/$RUN"; mkdir -p "$OUT"
export LEDGER_EVAL=1
export LEDGER_EVAL_DB="${LEDGER_EVAL_DB:-postgresql://localhost:5432/ledger_eval}"
export LEDGER_EVAL_ORIGIN_MODEL="${LEDGER_EVAL_ORIGIN_MODEL:-claude-haiku-4-5-20251001}"
export LEDGER_EVAL_SUCCESSOR_MODEL="${LEDGER_EVAL_SUCCESSOR_MODEL:-claude-sonnet-5}"
echo "run $RUN · directions: $DIRS · reps: $REPS · origin $LEDGER_EVAL_ORIGIN_MODEL · successor $LEDGER_EVAL_SUCCESSOR_MODEL"
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
LEDGER_CONTINUITY_DB="$LEDGER_EVAL_DB" LEDGER_CONFIG_DIR="$(mktemp -d)" node -e 'import("./dist/continuity/db.js").then(async m=>{const p=m.getPool({continuity:{database_url:process.env.LEDGER_CONTINUITY_DB}});const c=await m.migrate(p);console.log("eval db migrated",c.length?c.join(","):"(up to date)");await m.closePools()})'
{ python3 eval/kit/continuity_eval.py run --suite eval/runs/suite --out "$OUT/ours"   --adapter eval/adapter-ours.json   --directions $DIRS --repetitions "$REPS" > "$OUT/ours.log"   2>&1; echo "ours done";   } &
{ python3 eval/kit/continuity_eval.py run --suite eval/runs/suite --out "$OUT/gbrain" --adapter eval/adapter-gbrain.json --directions $DIRS --repetitions "$REPS" > "$OUT/gbrain.log" 2>&1; echo "gbrain done"; } &
wait
node dist/eval/compare.js --suite eval/runs/suite --runs "$OUT" --conditions ours,gbrain --directions $DIRS --repetitions "$REPS"
echo; echo "=== $OUT/matrix.md ==="; cat "$OUT/matrix.md"
