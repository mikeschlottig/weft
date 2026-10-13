#!/usr/bin/env bash
# Live acceptance for FR-40: per-agent budgets (BUDGET_EXCEEDED) and the kill switch (≤ 5 s, git access revoked).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-budget-kill_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-kill-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-kill)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
K() { WEFT_TOKEN="$(cat "$WORK/kim.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
AG="kim$(date +%H%M%S)"
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --batch-window 60000 --json | jq -c '{repo: .data.repo}'
A agent register --name "$AG" --model claude-haiku-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/kim.tok"
A agent budget --name "$AG" --changesets-per-day 1 --open-workspaces 2 --json | jq -c '.data'
cd "$WORK"
K start --task "round totals" --touch 'src/billing/**' --dir w1 --json >/dev/null
K start --task "zero padding" --touch 'src/util/**' --dir w2 --json >/dev/null
set +e; K start --task "third" --touch 'test/**' --dir w3 --json >w3.json; c3=$?; set -e
echo "  3rd open workspace: exit=$c3 $(jq -r '.error.code' w3.json)"
[ "$c3" = 7 ] && [ "$(jq -r '.error.code' w3.json)" = BUDGET_EXCEEDED ] || fail "open-workspace budget not enforced"
( cd w1 && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal);|' src/billing/invoice.js && K submit -m "Round totals" --json | jq -c '{first: .data.changeset.id}' )
set +e; ( cd w2 && perl -pi -e 's|\QpadStart(width, " ")\E|padStart(width, "0")|' src/util/format.js && K submit -m "Zero padding" --json >../s2.json ); c2=$?; set -e
echo "  2nd changeset today: exit=$c2 $(jq -r '.error.code' s2.json)"
[ "$c2" = 7 ] && [ "$(jq -r '.error.code' s2.json)" = BUDGET_EXCEEDED ] || fail "changesets/day budget not enforced"
echo "== kill switch"
FORK=$(jq -r .fork.remote w2/.git/weft.json); BR=$(jq -r .branch w2/.git/weft.json)
( cd w2 && git -c user.name=k -c user.email=k@k commit -q --allow-empty -am "wip" && git -c "http.extraHeader=Authorization: Bearer $(jq -r .fork.token .git/weft.json)" push -q origin "HEAD:refs/heads/$BR" ) && echo "  before kill: git push with the fork token works"
A agent kill --name "$AG" --by mike --json | jq -c '{ms: .data.ms, affected: .data.affected}' | tee kill.json
[ "$(jq -r .ms kill.json)" -le 5000 ] || fail "kill took longer than 5 s"
( cd w2 && echo "// after kill" >>src/util/format.js && git -c user.name=k -c user.email=k@k commit -qam "after kill" )
set +e; ( cd w2 && git -c "http.extraHeader=Authorization: Bearer $(jq -r .fork.token .git/weft.json)" push -q origin "HEAD:refs/heads/$BR" 2>../push.err ); cp=$?; set -e
echo "  after kill: git push exit=$cp ($(head -c 120 push.err | tr '\n' ' '))"
[ "$cp" != 0 ] || fail "fork token still works after the kill"
set +e; ( cd w2 && K status --json >../st.json ); cs=$?; set -e
echo "  after kill: weft status exit=$cs $(jq -r '.error.code' st.json)"
[ "$(jq -r '.error.code' st.json)" = FORBIDDEN ] || fail "killed agent's JWT still accepted"
A agent revive --name "$AG" --json | jq -c '.data'
K who src/util/format.js --json | jq -e '.ok == true' >/dev/null && echo "  after revive: API access restored"
echo "PASS: budgets + kill switch (repo $WEFT_REPO, kill in $(jq -r .ms kill.json) ms)"
