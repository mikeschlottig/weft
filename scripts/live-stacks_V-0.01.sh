#!/usr/bin/env bash
# Live acceptance for FR-27 stacked changesets.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-stacks_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-stack-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-stack)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --sensitive 'src/auth/**' --union 'CHANGELOG.md' --batch 4 --batch-window 3000 --json | jq -c '{repo: .data.repo}'
for a in ana ben; do A agent register --name "$a" --model claude-opus-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"

echo "== ana shortens the session TTL (sensitive path → held for a human)"
G ana start --task "shorten session TTL to 1h" --touch 'src/auth/**' --dir ana --json >/dev/null
( cd ana && perl -pi -e 's|86400|3600|' src/auth/session.js && G ana submit -m "Shorten session TTL to one hour" --json >../ana.json )
ANA=$(jq -r '.data.changeset.id' ana.json); echo "  ana: $ANA $(jq -r '.data.changeset.status' ana.json)"
[ "$(jq -r '.data.changeset.status' ana.json)" = "needs_review" ] || fail "ana should be held for review"

echo "== ben stacks on $ANA (forked from ana's fork) and adds a test that only passes on top of it"
G ben start --task "test the one-hour TTL" --touch 'test/**' --after "$ANA" --dir ben --json | jq -c '{ws: .data.workspace.id, stackedOn: .data.stackedOn.changeset}' | tee ben.start.json
grep -q 3600 ben/src/auth/session.js || fail "ben's checkout does not contain ana's unlanded change"
cat >ben/test/ttl.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("session TTL is one hour", () => {
  assert.match(readFileSync(new URL("../src/auth/session.js", import.meta.url), "utf8"), /3600/);
});
JS
( cd ben && G ben submit -m "Test the one-hour session TTL" --json >../ben.json )
BEN=$(jq -r '.data.changeset.id' ben.json); echo "  ben: $BEN $(jq -r '.data.changeset.status' ben.json) after=$(jq -r '.data.changeset.after' ben.json)"
[ "$(jq -r '.data.changeset.after' ben.json)" = "$ANA" ] || fail "ben's changeset is not stacked on $ANA"

echo "== while $ANA waits for review, $BEN must not be claimed"
sleep 12
[ "$(A show "$BEN" --json | jq -r '.data.status')" = "queued" ] || fail "$BEN was claimed before its parent"
echo "  $BEN still queued (parent held)"

echo "== a human approves $ANA → both land in one batch, parent first"
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
A approve "$ANA" --by mike --json | jq -c '{id: .data.id, status: .data.status}'
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_landed 600 --print | jq -rc 'select(.type | test("batch_started|landed|rejected")) | "  \(.type) \(.data.csId // .data.batchId) \(.data.reason // "") \(.data.changesets // "")"'
for x in "$ANA" "$BEN"; do [ "$(A show "$x" --json | jq -r '.data.status')" = "landed" ] || fail "$x did not land"; done
A log -n 3 --json | jq -rc '.data[] | "  \(.commit[0:10]) \(.subject) | \(.changeset // "-")"' | tee log.txt
head -1 log.txt | grep -q "$BEN" || fail "child should be the newest trunk commit"
sed -n 2p log.txt | grep -q "$ANA" || fail "parent should land just before the child"
echo "PASS: stacked changesets (repo $WEFT_REPO)"
