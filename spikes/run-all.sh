#!/usr/bin/env bash
# Runs every spike present, prints the table, exits non-zero if any ran and failed.
set -uo pipefail
cd "$(dirname "$0")"

# spike:needs-a-model
SPIKES=(
  "00-harness:no"
  "01-veto:yes"
  "02-drive:yes"
  "03-submit:yes"
  "05-events:yes"
  "06-trust:no"
)

# A spike that cannot run exits 2, so a skip never reads as a pass or a failure.
SKIP_EXIT=2

echo "=== typecheck ==="
if npx tsc --noEmit; then
  echo "  ok"
else
  echo "  FAIL"
  exit 1
fi
echo

# Same resolution order as lib/env.ts: the environment first, then spikes/.env.
have_key="${ANTHROPIC_API_KEY:-${ANTHROPIC_KEY:-}}"
if [ -z "$have_key" ] && [ -f .env ]; then
  have_key="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?ANTHROPIC_\(API_\)\?KEY[[:space:]]*=[[:space:]]*//p' .env | tail -1)"
fi

results=()
status=0

for entry in "${SPIKES[@]}"; do
  name="${entry%%:*}"
  needs_model="${entry##*:}"

  if [ ! -f "$name/run.ts" ]; then
    results+=("$name|not written")
    continue
  fi
  if [ "$needs_model" = "yes" ] && [ -z "$have_key" ]; then
    results+=("$name|SKIP (no key: set ANTHROPIC_KEY in spikes/.env)")
    continue
  fi

  echo "=== $name ==="
  timeout 600 npx tsx "$name/run.ts"
  code=$?
  if [ "$code" -eq 0 ]; then
    results+=("$name|pass")
  elif [ "$code" -eq "$SKIP_EXIT" ]; then
    results+=("$name|SKIP (the spike declined to run)")
  else
    results+=("$name|FAIL")
    status=1
  fi
  echo
done

echo "=== summary ==="
for row in "${results[@]}"; do
  printf '  %-12s %s\n' "${row%%|*}" "${row#*|}"
done

echo
echo "04-attach needs a person at two terminals: npm run 04-attach (see docs/phases/phase-0.md §3.4)."
if [ -z "$have_key" ]; then
  echo "Model-backed spikes were skipped. Put ANTHROPIC_KEY=sk-... in spikes/.env and re-run."
fi
exit $status
