#!/usr/bin/env bash
# Live acceptance for FR-26 parallel lanes: disjoint changesets validate concurrently.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-lanes_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-lanes-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-lanes)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# A slow check (≈ 8 s) so the two lanes are certainly in flight at the same time.
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'sleep 8 && node --test test/*.test.js' --union 'CHANGELOG.md' --batch-window 500 --no-judge --json | jq -c '{repo: .data.repo}'
curl -s -X PATCH -H "authorization: Bearer $WEFT_ADMIN_TOKEN" -H 'content-type: application/json' "$WEFT_REMOTE/v1/repos/$WEFT_REPO/config" --data '{"lanes":2}' | jq -c '{lanes: .data.lanes}'
for a in lin mo; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
G lin start --task "round totals" --touch 'src/billing/**' --dir lin --json >/dev/null
G mo start --task "zero-pad formatting" --touch 'src/util/**' --dir mo --json >/dev/null
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
( cd lin && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal * 100) / 100;|' src/billing/invoice.js && echo "- billing: rounding (lin)" >>CHANGELOG.md && G lin submit -m "Round invoice totals" --json | jq -c '{lin: .data.changeset.id}' )
# wait until lin's batch is in flight, then submit a DISJOINT change
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_started 120 >/dev/null
( cd mo && perl -pi -e 's|\QpadStart(width, " ")\E|padStart(width, "0")|' src/util/format.js && echo "- util: zero padding (mo)" >>CHANGELOG.md && G mo submit -m "Zero-pad formatting" --json | jq -c '{mo: .data.changeset.id}' )
for _ in $(seq 1 90); do
  n=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=$S" | jq '[.data[] | select(.type == "queue.batch_landed")] | length')
  [ "$n" -ge 2 ] && break; sleep 3
done
curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=$S" | jq -c '.data[] | select(.type | test("batch_started|batch_landed|changeset.landed|changeset.rejected")) | {type, batch: .data.batchId, cs: .data.csId, inFlight: .data.lanesInFlight, laneRebases: .data.laneRebases, checks: .data.checksRun}' | tee ev.json
jq -se '[.[] | select(.type == "queue.batch_started" and (.inFlight | length) == 2)] | length >= 1' ev.json >/dev/null || fail "never had two lanes in flight"
jq -se '[.[] | select(.type == "changeset.landed")] | length == 2' ev.json >/dev/null || fail "both changesets should land"
jq -se '[.[] | select(.type == "queue.batch_landed") | .laneRebases] | add >= 1' ev.json >/dev/null || fail "the second lane should have rebased onto the first"
A log -n 3 --json | jq -rc '.data[] | "  \(.commit[0:10]) \(.subject) | \(.changeset // "-")"'
echo "PASS: two lanes in flight, both landed, one rebased (repo $WEFT_REPO)"
