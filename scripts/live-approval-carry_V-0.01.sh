#!/usr/bin/env bash
# Live acceptance for approval carry-over (src/core/rubric.ts approvalCarries): a human approves a held changeset,
# it then loses a conflict, its Conflict Room resolution is held again for intent, and the approval carries over,
# so the resolution lands with no second approval. The intent hold is forced (judge.holdOnAlignment 3.1 > max 3),
# so the run does not depend on the two judges happening to disagree. Admin token, non-eval repo: no evaluator slot.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-approval-carry_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-carry-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-carry)"; chmod 700 "$WORK"
R="$WEFT_REMOTE/v1/repos/$WEFT_REPO"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { printf 'FAIL: %s\n' "$*"; exit 1; }
status() { curl -s --max-time 30 "$R/changesets/$1" | jq -r '.data.status'; }
wait_for() { # cs states...
  local cs="$1"; shift; local s=""
  for _ in $(seq 1 60); do s="$(status "$cs")"; for want in "$@"; do [ "$s" = "$want" ] && { echo "$s"; return 0; }; done; sleep 10; done
  echo "$s"; return 1
}

echo "== import jonschlinkert/is-number as $WEFT_REPO; force an intent hold on every changeset"
A init "$WEFT_REPO" --import https://github.com/jonschlinkert/is-number --check 'npm install --no-audit --no-fund && npm test' --json | jq -ce '.ok' >/dev/null || fail "import"
curl -s --max-time 60 -X PATCH -H "authorization: Bearer $WEFT_ADMIN_TOKEN" -H 'content-type: application/json' "$R/config" \
  --data '{"judge":{"holdOnAlignment":3.1}}' | jq -ce '.data.judge.holdOnAlignment == 3.1' >/dev/null || fail "config"
for a in carry-x carry-y; do A agent register --name "$a" --model script --json | jq -r '.data.token' >"$WORK/$a.tok"; chmod 600 "$WORK/$a.tok"; done

echo "== two agents change the same header line differently (tests still pass)"
cd "$WORK"
G carry-x start --task "mention the license file in the header" --touch index.js --dir x --json | jq -ce '.ok' >/dev/null || fail "start x"
G carry-y start --task "state the copyright years in the header" --touch index.js --dir y --json | jq -ce '.ok' >/dev/null || fail "start y"
sed -i.bak 's/^ \* Released under the MIT License\.$/ * Released under the MIT License (see LICENSE)./' x/index.js && rm -f x/index.js.bak
sed -i.bak 's/^ \* Released under the MIT License\.$/ * Released under the MIT License, 2014-present./' y/index.js && rm -f y/index.js.bak
(cd x && ! git diff --quiet && git commit -qam "header: license file" && git push -q) || fail "x edit"
(cd y && ! git diff --quiet && git commit -qam "header: years" && git push -q) || fail "y edit"
CX="$(cd x && G carry-x submit -m "header: license file" --json | jq -r '.data.changeset.id // .data.id')"
CY="$(cd y && G carry-y submit -m "header: years" --json | jq -r '.data.changeset.id // .data.id')"
echo "   submitted $CX (x), $CY (y)"

echo "== both held for intent; a human approves both"
[ "$(wait_for "$CX" needs_review)" = needs_review ] || fail "$CX was not held"
[ "$(wait_for "$CY" needs_review)" = needs_review ] || fail "$CY was not held"
curl -s --max-time 30 "$R/changesets/$CX" | jq -c '{cs: .data.id, hold: .data.scorecard.hold}'
A approve "$CX" --json | jq -ce '.ok' >/dev/null || fail "approve $CX"
A approve "$CY" --json | jq -ce '.ok' >/dev/null || fail "approve $CY"

echo "== one lands, the other loses the conflict and gets a Conflict Room"
SX="$(wait_for "$CX" landed rejected)"; SY="$(wait_for "$CY" landed rejected)"
echo "   $CX=$SX $CY=$SY"
if [ "$SX" = rejected ] && [ "$SY" = landed ]; then LOSER=carry-x; LDIR=x; LCS="$CX"; elif [ "$SX" = landed ] && [ "$SY" = rejected ]; then LOSER=carry-y; LDIR=y; LCS="$CY"; else fail "expected one landed and one rejected"; fi
[ "$(curl -s --max-time 30 "$R/changesets/$LCS" | jq -r '.data.rejection.reason')" = conflict ] || fail "$LCS was not rejected for a conflict"
ROOM=""
for _ in $(seq 1 60); do
  ROOM="$(curl -s --max-time 30 "$R/snapshot" | jq -r --arg cs "$LCS" '[.data.rooms[]? | select(.csId == $cs and .status == "verified") | .id][0] // empty')"
  [ -n "$ROOM" ] && break
  F="$(curl -s --max-time 30 "$R/snapshot" | jq -r --arg cs "$LCS" '[.data.rooms[]? | select(.csId == $cs and .status == "failed") | .id][0] // empty')"
  [ -n "$F" ] && fail "room $F failed to find a verified resolution"
  sleep 10
done
[ -n "$ROOM" ] || fail "no verified room for $LCS"
echo "   room $ROOM verified"

echo "== the losing agent accepts the room; the resolution must land with no second approval"
RES="$(cd "$LDIR" && G "$LOSER" room accept "$ROOM" --json | jq -r '.data.resubmitted // .data.changeset.id // .data.room.resubmittedAs // empty')"
[ -n "$RES" ] || RES="$(curl -s --max-time 30 "$R/snapshot" | jq -r --arg r "$ROOM" '.data.rooms[] | select(.id == $r) | .resubmittedAs')"
echo "   resolution $RES"
S="$(wait_for "$RES" landed rejected needs_review)" || true
J="$(curl -s --max-time 30 "$R/changesets/$RES")"
echo "$J" | jq -c '.data | {id, status, resolves, carried: .approvalCarriedFrom, hold: .scorecard.hold}'
[ "$S" = landed ] || fail "resolution $RES is $S (expected landed without a second approval)"
[ "$(echo "$J" | jq -r '.data.approvalCarriedFrom.csId')" = "$LCS" ] || fail "approvalCarriedFrom is not $LCS"
curl -s --max-time 30 "$R/events?since=0" | jq -e --arg cs "$RES" --arg from "$LCS" '[.data[] | select(.type == "changeset.hold_overridden") | tostring | select(contains($cs) and contains($from))] | length > 0' >/dev/null \
  || fail "no changeset.hold_overridden event carrying $LCS → $RES"
(cd "$LDIR" && G "$LOSER" status --json >/dev/null && git log -1 --format=%B trunk/main) >"$WORK/trailer.txt"
grep -q "Weft-Approved-By: .* (carried from $LCS)" "$WORK/trailer.txt" || { cat "$WORK/trailer.txt"; fail "trunk commit lacks the carried approval trailer"; }
grep -E "Weft-(Approved-By|Resolves)" "$WORK/trailer.txt"
echo "PASS: approval of $LCS carried to its room resolution $RES, which landed without a second approval (repo $WEFT_REPO)"
