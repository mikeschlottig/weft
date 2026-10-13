#!/usr/bin/env bash
# Live acceptance for D7: namespace sharding + the limits dashboard.
#  - a repo placed on shard 1 lives (trunk AND forks) in the second Artifacts namespace;
#  - start → edit → submit → land works there; push-derived heartbeats arrive through that namespace's trigger;
#  - GET /v1/limits reports per-shard repo counts and the repo's measured usage vs documented limits.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-shards-limits_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft-dev.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-shard-$(date +%m%d%H%M)}"
NS1="${WEFT_NS1:-weft-dev-s1}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-shard)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { WEFT_TOKEN="$(cat "$WORK/oak.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ev() { curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=$1"; }

BEFORE=$(curl -s "$WEFT_REMOTE/v1/limits" | jq '.data.shards[1].repos')
A init "$WEFT_REPO" --shard 1 --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --batch-window 500 --no-judge --json | tee "$WORK/init.json" | jq -c '{repo: .data.repo, shard: .data.shard, remote: .data.remote}'
[ "$(jq -r .data.shard "$WORK/init.json")" = 1 ] || fail "repo was not placed on shard 1"
jq -r .data.remote "$WORK/init.json" | grep -q "/git/$NS1/" || fail "trunk is not in namespace $NS1"
A agent register --name "oak$(date +%H%M%S)" --model claude-haiku-5-5 --json | jq -r '.data.token' >"$WORK/oak.tok"
cd "$WORK"
G start --task "round totals" --touch 'src/billing/**' --dir oak --json | jq -c '{ws: .data.workspace.id, fork: .data.fork.remote}' | tee start.json
jq -r .fork start.json | grep -q "/git/$NS1/" || fail "the fork is not in the trunk's namespace"

echo "== push-derived heartbeat through the shard-1 namespace trigger"
S=$(ev 0 | jq '[.data[].seq] | max')
( cd oak && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal * 100) / 100;|' src/billing/invoice.js \
  && git -c user.name=o -c user.email=o@o commit -qam "wip" \
  && git -c "http.extraHeader=Authorization: Bearer $(jq -r .fork.token .git/weft.json)" push -q origin "HEAD:refs/heads/$(jq -r .branch .git/weft.json)" )
for _ in $(seq 1 30); do
  ev "$S" | jq -e '[.data[] | select(.type == "workspace.heartbeat" and .data.source == "push")] | length >= 1' >/dev/null && break; sleep 3
done
ev "$S" | jq -e '[.data[] | select(.type == "workspace.heartbeat" and .data.source == "push")] | length >= 1' >/dev/null || fail "no push heartbeat from the shard-1 namespace"
echo "  push heartbeat observed"

echo "== land on shard 1"
S=$(ev 0 | jq '[.data[].seq] | max')
( cd oak && G submit -m "Round invoice totals" --json | jq -c '{cs: .data.changeset.id}' )
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" changeset.landed,changeset.rejected 300 >/dev/null || fail "no verdict"
ev "$S" | jq -e '[.data[] | select(.type == "changeset.landed")] | length == 1' >/dev/null || fail "change did not land on shard 1"
A log -n 1 --json | jq -rc '.data[0] | "  trunk: \(.commit[0:10]) \(.subject)"'

echo "== limits dashboard"
curl -s "$WEFT_REMOTE/v1/limits?repo=$WEFT_REPO" | tee lim.json | jq -c '{shards: .data.shards, usage: (.data.repo.usage | {shard, sqliteBytes, events, forksTotal, artifactsCalls10s, lanesConfigured})}'
jq -e --argjson b "$BEFORE" '.data.shards[1].repos == ($b + 1)' lim.json >/dev/null || fail "shard-1 repo count did not go up by one"
jq -e '.data.repo.usage.shard == 1 and (.data.repo.rows | length) >= 6 and .data.repo.usage.sqliteBytes > 0' lim.json >/dev/null || fail "limits rows missing"
jq -r '.data.repo.rows[] | "  \(.status | ascii_upcase | .[0:5])  \(.name): \(.used // "n/a") / \(.limit) \(.unit)"' lim.json
echo "PASS: shard-1 repo + fork in $NS1, push trigger, landing, limits dashboard (repo $WEFT_REPO)"
