#!/usr/bin/env bash
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 1

node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Round 3 validation requires Node 22 or newer."); process.exit(1); }' || exit 1
out=$(mktemp -d "${TMPDIR:-/tmp}/otc-fam-round-3.XXXXXX") || exit 1
printf 'Validation artifacts: %s\n' "$out"
status=0

run() {
  local label=$1 result
  shift
  "$@" 2>&1 | tee "$out/$label.log"
  result=$?
  printf '%s exit %s\n' "$label" "$result"
  if (( result != 0 )); then status=1; fi
}

run frozen-integrity git diff --exit-code 9c00adeb195565c6ffdb928fe8a9056e73bf1bdd -- \
  .launchpad/checks .github/workflows contracts ':!contracts/BrokerDeals.sol'
run build npm run build
for round in 1 2 3; do
  run "frozen-round-$round" env LAUNCHPAD_GATE_OUT="$out/frozen-round-$round.json" \
    node ".launchpad/checks/round-$round/run.mjs"
done
run regression npm test
run chain-proof env TZ=America/Los_Angeles BROKER_EVIDENCE_DIR="$out" npm run prove:v3
run browser-proof env BROKER_VIEWPORT= BROKER_EVIDENCE_DIR="$out" npm run play:v3

printf 'Validation artifacts: %s\n' "$out"
exit "$status"
