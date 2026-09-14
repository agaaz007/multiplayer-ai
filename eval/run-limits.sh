#!/usr/bin/env bash
# D04 limits probe: ours vs gbrain on one PM history carrying a corrected number, a rejected
# option, and an assumption nobody states. One case, so a full pass is 4 answers per arm.
#
#   eval/run-limits.sh [run-name] [--noise N] [--directions "..."] [--repetitions N]
#
# --noise is the number of unrelated turns in each gap between planted facts (default 2). Raising it
# separates retrieval from recall: at 2 a successor could in principle read the whole history, at 20
# it has to find each fact. Origin turns are real model calls, so cost scales with it.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${1:-limits-$(date -u +%Y%m%dT%H%M%SZ)}"; shift || true
DIRS="codex-to-claude"; REPS=1; NOISE=2
while [ $# -gt 0 ]; do case "$1" in
  --noise) NOISE="$2"; shift 2;;
  --directions) DIRS="$2"; shift 2;;
  --repetitions) REPS="$2"; shift 2;;
  *) echo "unknown arg $1"; exit 2;;
esac; done
OUT="eval/runs/$RUN"; SUITE="$OUT/suite"; mkdir -p "$OUT"
export LEDGER_EVAL=1
export LEDGER_EVAL_DB="${LEDGER_EVAL_DB:-postgresql://localhost:5432/ledger_eval}"
export LEDGER_EVAL_ORIGIN_MODEL="${LEDGER_EVAL_ORIGIN_MODEL:-claude-haiku-4-5-20251001}"
export LEDGER_EVAL_SUCCESSOR_MODEL="${LEDGER_EVAL_SUCCESSOR_MODEL:-claude-sonnet-5}"
echo "run $RUN · D04 · noise $NOISE · directions: $DIRS · reps: $REPS · origin $LEDGER_EVAL_ORIGIN_MODEL · successor $LEDGER_EVAL_SUCCESSOR_MODEL"
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
LEDGER_CONTINUITY_DB="$LEDGER_EVAL_DB" LEDGER_CONFIG_DIR="$(mktemp -d)" node -e 'import("./dist/continuity/db.js").then(async m=>{const p=m.getPool({continuity:{database_url:process.env.LEDGER_CONTINUITY_DB}});const c=await m.migrate(p);console.log("eval db migrated",c.length?c.join(","):"(up to date)");await m.closePools()})'
# A focused suite: public/ and the private oracle hold D04 only, so the report is self-consistent.
python3 eval/kit/continuity_eval.py prepare --out "$SUITE" --cases D04 --limits-noise "$NOISE"
{ python3 eval/kit/continuity_eval.py run --suite "$SUITE" --out "$OUT/ours"   --adapter eval/adapter-ours.json   --directions $DIRS --repetitions "$REPS" > "$OUT/ours.log"   2>&1; echo "ours done";   } &
{ python3 eval/kit/continuity_eval.py run --suite "$SUITE" --out "$OUT/gbrain" --adapter eval/adapter-gbrain.json --directions $DIRS --repetitions "$REPS" > "$OUT/gbrain.log" 2>&1; echo "gbrain done"; } &
wait
node dist/eval/compare.js --suite "$SUITE" --runs "$OUT" --conditions ours,gbrain --directions $DIRS --repetitions "$REPS"
echo; echo "=== $OUT/matrix.md ==="; cat "$OUT/matrix.md"
echo; echo "=== per-answer detail ==="
for c in ours gbrain; do
  echo "--- $c"
  python3 - "$OUT/$c/report.json" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1]))["results"]:
    if r["case"] != "D04": continue
    print("  %s rep%s: %s" % (r["direction"], r["repetition"], r["status"]))
    for chk in r.get("checks", []):
        print("    %-22s %-9s %s" % (chk["key"], chk["status"], chk["detail"]))
PY
done
