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
DIRS="codex-to-claude"; REPS=1; NOISE=2; TIMEOUT=5400
while [ $# -gt 0 ]; do case "$1" in
  --noise) NOISE="$2"; shift 2;;
  --directions) DIRS="$2"; shift 2;;
  --repetitions) REPS="$2"; shift 2;;
  --timeout) TIMEOUT="$2"; shift 2;;
  *) echo "unknown arg $1"; exit 2;;
esac; done
# A local .env is read as DATA for exactly one OPENAI_API_KEY assignment: not sourced, so a stray
# command in that file is never executed, and nothing else in it enters the environment.
if [ -z "${OPENAI_API_KEY:-}" ] && [ -f .env ]; then
  OPENAI_API_KEY="$(sed -n 's/^[[:space:]]*OPENAI_API_KEY[[:space:]]*=[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' .env | head -1)"
  [ -n "$OPENAI_API_KEY" ] && export OPENAI_API_KEY && echo "loaded OPENAI_API_KEY from .env (${#OPENAI_API_KEY} chars)"
fi

# gbrain embeds on write and falls back to keyword/tsvector search without a key. A D04 history is
# small and lexically close to its own questions, so a keyword-only arm can look fine here while the
# product's actual hybrid retrieval is untested — and a paid ours-vs-gbrain number taken that way is
# not a comparison. Refuse rather than quietly handicap one arm.
if [ -z "${OPENAI_API_KEY:-}" ] && [ "${LEDGER_EVAL_GBRAIN_KEYWORD_ONLY:-}" != "1" ]; then
  echo "refusing: gbrain has no OPENAI_API_KEY, so its pages would not be embedded and only" >&2
  echo "keyword search would be measured. Export a key, or set LEDGER_EVAL_GBRAIN_KEYWORD_ONLY=1" >&2
  echo "to run a deliberately keyword-only gbrain arm and report it as such." >&2
  exit 3
fi
OUT="eval/runs/$RUN"; SUITE="$OUT/suite"; mkdir -p "$OUT"
export LEDGER_EVAL=1
export LEDGER_EVAL_DB="${LEDGER_EVAL_DB:-postgresql://localhost:5432/ledger_eval}"
# Per-harness form ("claude=<m>"), not a bare model name. A bare name applies to WHICHEVER harness
# plays the role, so `claude-haiku-...` would be handed to `codex exec -m`. Leaving codex unset makes
# it fall through to its own configured model, which is the honest default for that arm.
export LEDGER_EVAL_ORIGIN_MODEL="${LEDGER_EVAL_ORIGIN_MODEL:-claude=claude-haiku-4-5-20251001}"
export LEDGER_EVAL_SUCCESSOR_MODEL="${LEDGER_EVAL_SUCCESSOR_MODEL:-claude=claude-sonnet-5}"
echo "run $RUN · D04 · noise $NOISE · timeout ${TIMEOUT}s · directions: $DIRS · reps: $REPS · origin $LEDGER_EVAL_ORIGIN_MODEL · successor $LEDGER_EVAL_SUCCESSOR_MODEL"
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
LEDGER_CONTINUITY_DB="$LEDGER_EVAL_DB" LEDGER_CONFIG_DIR="$(mktemp -d)" node -e 'import("./dist/continuity/db.js").then(async m=>{const p=m.getPool({continuity:{database_url:process.env.LEDGER_CONTINUITY_DB}});const c=await m.migrate(p);console.log("eval db migrated",c.length?c.join(","):"(up to date)");await m.closePools()})'
# A focused suite: public/ and the private oracle hold D04 only, so the report is self-consistent.
python3 eval/kit/continuity_eval.py prepare --out "$SUITE" --cases D04 --limits-noise "$NOISE"
{ python3 eval/kit/continuity_eval.py run --suite "$SUITE" --out "$OUT/ours"   --adapter eval/adapter-ours.json   --directions $DIRS --repetitions "$REPS" --timeout "$TIMEOUT" > "$OUT/ours.log"   2>&1; echo "ours done";   } &
{ python3 eval/kit/continuity_eval.py run --suite "$SUITE" --out "$OUT/gbrain" --adapter eval/adapter-gbrain.json --directions $DIRS --repetitions "$REPS" --timeout "$TIMEOUT" > "$OUT/gbrain.log" 2>&1; echo "gbrain done"; } &
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
