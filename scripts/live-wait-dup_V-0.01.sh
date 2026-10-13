#!/usr/bin/env bash
# Live acceptance for FR-10 (--wait, fair FIFO per scope) and FR-09 (duplicate-intent detection).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-wait-dup_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-wait-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-wait)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --json | jq -c '{repo: .data.repo}'
for a in hal wes1 wes2 pat quinn rae; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
echo "== FR-10: hal holds src/auth/** exclusively; wes1 then wes2 wait for it"
G hal start --task "rotate session secrets" --touch 'src/auth/**' --exclusive --dir hal --json | jq -c '{hal: .data.workspace.id}'
(G wes1 start --task "log session expiry" --touch 'src/auth/**' --wait --wait-timeout 180 --dir wes1 --json >wes1.json) &
P1=$!
sleep 4
(G wes2 start --task "add session refresh" --touch 'src/auth/**' --wait --wait-timeout 180 --dir wes2 --json >wes2.json) &
P2=$!
sleep 6
curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq -c '[.data[] | select(.type == "workspace.waiting") | {agent: .data.agentName, position: .data.position, blockedBy: .data.blockedBy}]' | tee waiting.json
jq -e 'map(select(.agent == "wes1"))[0].position == 1 and map(select(.agent == "wes2"))[0].position == 2' waiting.json >/dev/null || fail "expected wes1 #1 and wes2 #2"
echo "== hal abandons; the scope goes to wes1 first, then wes2"
G hal abandon --dir hal --json >/dev/null
wait $P1 $P2
jq -c '{wes1: .data.workspace.id}' wes1.json; jq -c '{wes2: .data.workspace.id}' wes2.json
curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq -r '[.data[] | select(.type == "workspace.started" and (.data.agentName == "wes1" or .data.agentName == "wes2")) | .data.agentName] | join(",")' | tee order.txt
[ "$(cat order.txt)" = "wes1,wes2" ] || fail "FIFO order violated: $(cat order.txt)"
echo "== FR-09: duplicate-intent detection"
G pat start --task "add 8% sales tax to invoice totals" --touch 'src/billing/**' --dir pat --json | jq -c '{pat: .data.workspace.id}'
G quinn start --task "apply sales tax to the invoice total" --touch 'src/billing/**' --dir quinn --json | jq -c '{quinn: [.data.forecast.duplicates[]? | {agentName, similarity}]}' | tee quinn.json
G rae start --task "zero-pad the currency formatter output" --touch 'src/util/**' --dir rae --json | jq -c '{rae: [.data.forecast.duplicates[]? | {agentName, similarity}]}' | tee rae.json
jq -e '.quinn | map(select(.agentName == "pat")) | length == 1' quinn.json >/dev/null || fail "quinn's task should be flagged as a duplicate of pat's"
jq -e '.rae | length == 0' rae.json >/dev/null || fail "rae's unrelated task should not be flagged"
echo "PASS: fair --wait FIFO + duplicate-intent detection (repo $WEFT_REPO)"
