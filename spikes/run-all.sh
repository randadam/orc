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

echo "=== typecheck ==="
if npx tsc --noEmit; then
  echo "  ok"
else
  echo "  FAIL"
  exit 1
fi
echo

have_key="${ANTHROPIC_API_KEY:-}"
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
    results+=("$name|SKIP (no ANTHROPIC_API_KEY)")
    continue
  fi

  echo "=== $name ==="
  if timeout 180 npx tsx "$name/run.ts"; then
    results+=("$name|pass")
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
echo "04-attach requires a person at a terminal; see docs/phases/phase-0.md §3.4."
if [ -z "$have_key" ]; then
  echo "Model-backed spikes were skipped. Set ANTHROPIC_API_KEY and re-run to answer them."
fi
exit $status
