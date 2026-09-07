#!/usr/bin/env bash
# Conductor runs non-interactive shells, which may inherit an older system Node.
set -eo pipefail
cd "$(dirname "$0")/.."

supported_node() {
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null
}

if ! supported_node; then
  ledger_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$ledger_nvm_dir/nvm.sh" ]; then
    . "$ledger_nvm_dir/nvm.sh" --no-use
    nvm use --silent
  fi
fi
if ! supported_node; then
  echo "Ledger needs Node 20 or newer. Install Node 22 (see .nvmrc), then retry." >&2
  exit 1
fi

case "${1:-preview}" in
  setup) exec npm ci ;;
  preview)
    export LEDGER_UI_PORT="${CONDUCTOR_PORT:-${LEDGER_UI_PORT:-4318}}"
    exec npm run preview:ui
    ;;
  *) echo "Usage: bash scripts/conductor.sh [setup|preview]" >&2; exit 1 ;;
esac
