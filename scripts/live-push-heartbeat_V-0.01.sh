#!/usr/bin/env bash
# Live acceptance for FR-05 push-derived heartbeats: a plain `git push` (no weft command) is observed.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-push-heartbeat_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-push-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-push)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --json | jq -c '{repo: .data.repo}'
for a in ada bo; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
G ada start --task "round totals" --touch 'src/billing/**' --dir ada --json >/dev/null
G bo start --task "add a discount" --touch 'src/billing/**' --dir bo --json >/dev/null
( cd ada && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal);|' src/billing/invoice.js && G ada status --json >/dev/null )
echo "== bo edits the same file and only runs a plain git push (no weft command)"
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
( cd bo
  perl -pi -e 's|  return subtotal;|  return subtotal * 0.9;|' src/billing/invoice.js
  git -c user.name=bo -c user.email=bo@agents.weft.dev commit -q -am "wip: discount"
  git -c "http.extraHeader=Authorization: Bearer $(jq -r .fork.token .git/weft.json)" push -q origin "HEAD:refs/heads/$(jq -r .branch .git/weft.json)" )
echo "  pushed; waiting for the PushObserver"
T0=$(date +%s)
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" workspace.alert 180 --print \
  | jq -c 'select(.type == "workspace.heartbeat" or .type == "workspace.alert") | {type, agent: .data.agentName, source: .data.source, peer: .data.peerAgent, files: .data.files}' | tee ev.json
echo "  observed in $(( $(date +%s) - T0 )) s"
jq -se 'map(select(.type == "workspace.heartbeat" and .agent == "bo" and .source == "push")) | length >= 1' ev.json >/dev/null || fail "no push-sourced heartbeat for bo"
jq -se 'map(select(.type == "workspace.alert" and ((.agent == "bo" and .peer == "ada") or (.agent == "ada" and .peer == "bo")))) | length >= 1' ev.json >/dev/null || fail "no collision alert between bo and ada"
echo "PASS: push-derived heartbeat + alert (repo $WEFT_REPO)"
