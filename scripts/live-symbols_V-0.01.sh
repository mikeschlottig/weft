#!/usr/bin/env bash
# Live acceptance for FR-08 symbol-level collision detection.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-symbols_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-sym-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-sym)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --union 'CHANGELOG.md' --batch 4 --batch-window 6000 --json | jq -c '{repo: .data.repo}'
for a in sol ivy rex; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
G sol start --task "round invoice totals to cents" --touch 'src/billing/**' --dir sol --json >/dev/null
G ivy start --task "add invoice due dates" --touch 'src/billing/**' --dir ivy --json >/dev/null

echo "== sol edits total(); ivy adds dueDate() — same file, different functions"
( cd sol && perl -0pi -e 's|  return subtotal;|  return Math.round(subtotal * 100) / 100;|' src/billing/invoice.js )
( cd ivy && printf '\nexport function dueDate(issued, days = 30) {\n  return new Date(issued.getTime() + days * 86400000);\n}\n' >>src/billing/invoice.js )
(cd sol && G sol status --json >/dev/null)
(cd ivy && G ivy status --json) | jq -c '{forecast: .data.forecast.risk, overlaps: [.data.forecast.overlaps[] | {agentName, strength, symbols}]}' | tee ivy.json
jq -e '.forecast == "low" and .overlaps[0].strength == "symbols-disjoint"' ivy.json >/dev/null || fail "expected symbols-disjoint / low"

echo "== rex starts and edits total() as well — a real collision at symbol granularity"
G rex start --task "apply loyalty credit" --touch 'src/billing/**' --dir rex --json >/dev/null
( cd rex && perl -0pi -e 's|  return subtotal;|  return subtotal - 5;|' src/billing/invoice.js )
(cd rex && G rex status --json) | jq -c '{forecast: .data.forecast.risk, overlaps: [.data.forecast.overlaps[] | {agentName, strength, symbols}]}' | tee rex.json
jq -e '.forecast == "high" and ([.overlaps[] | select(.agentName == "sol" and .strength == "touched" and (.symbols | index("src/billing/invoice.js#total")))] | length) == 1' rex.json >/dev/null || fail "expected touched on invoice.js#total with sol"
jq -e '[.overlaps[] | select(.agentName == "ivy")][0].strength == "symbols-disjoint"' rex.json >/dev/null || fail "rex vs ivy should be symbols-disjoint"
curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq -c '[.data[] | select(.type == "workspace.alert") | {agentName: .data.agentName, peer: .data.peerAgent, symbols: .data.symbols}]' | tee alerts.json
# sol's first heartbeat may alert on the declared-intent overlap (both declared src/billing/** and ivy had not
# touched anything yet): that is correct. Once ivy reports its symbols, its heartbeat must raise no alert, and
# rex vs sol must alert at symbol granularity.
jq -e '([.[] | select(.agentName == "ivy")] | length) == 0' alerts.json >/dev/null || fail "ivy's symbol-disjoint heartbeat raised an alert"
jq -e '([.[] | select(.agentName == "rex" and .peer == "sol" and (.symbols | index("src/billing/invoice.js#total")))] | length) == 1' alerts.json >/dev/null || fail "missing rex↔sol symbol alert"

echo "== sol and ivy submit; different functions merge cleanly in one batch"
G rex abandon --dir rex --json >/dev/null
(cd sol && G sol submit -m "Round invoice totals to cents" --json | jq -c '{cs: .data.changeset.id}') &
(cd ivy && G ivy submit -m "Add invoice due dates" --json | jq -c '{cs: .data.changeset.id}') &
wait
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_landed 600 --print | jq -rc 'select(.type | test("landed|rejected")) | "  \(.type) \(.data.csId // .data.batchId) \(.data.agentName // "") \(.data.reason // "")"' | tee landed.txt
[ "$(grep -c 'changeset.landed' landed.txt)" = "2" ] || fail "expected both sol and ivy to land"
echo "PASS: symbol-level collisions (repo $WEFT_REPO)"
