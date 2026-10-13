#!/usr/bin/env bash
# Live acceptance for Tier E (build plan V-0.03):
#   E2 flake guard — a merged tip that is red once and green on re-run lands, with a queue.flaky_check event;
#   E3 authoritative risk — a submit that under-reports its diff (hides a sensitive file) is re-scored from the
#      runner's own diff and held for review, with a changeset.rescored event naming the hidden file.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-flake-rescore_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft-dev.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-flk-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-flake)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ev() { curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=$1"; }

# The check fails exactly once per commit whose invoice.js contains FLAKY (marker file in the runner's /tmp).
CHECK='if grep -q FLAKY src/billing/invoice.js && [ ! -f "/tmp/weft-flake-$WEFT_COMMIT" ]; then touch "/tmp/weft-flake-$WEFT_COMMIT"; echo "simulated flaky failure"; exit 1; fi; node --test test/*.test.js'
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check "$CHECK" --sensitive 'src/auth/**' --batch-window 500 --no-judge --json | jq -c '{repo: .data.repo, shard: .data.shard}'
for a in fern gale; do A agent register --name "$a" --model claude-haiku-5-5 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"

echo "== E2: flaky check on the merged tip"
G fern start --task "annotate invoice totals" --touch 'src/billing/**' --dir fern --json >/dev/null
S=$(ev 0 | jq '[.data[].seq] | max')
( cd fern && echo "// FLAKY marker for the live flake test" >>src/billing/invoice.js && G fern submit -m "Annotate invoice totals" --json | jq -c '{fern: .data.changeset.id}' )
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_landed 300 >/dev/null || fail "batch did not land"
ev "$S" | jq -c '.data[] | select(.type | test("flaky|batch_landed|changeset.landed|changeset.rejected")) | {type, cs: .data.csId, flaky: (.data.flaky // .data.changesets), checks: .data.checksRun, bisect: .data.bisectSteps}' | tee e2.json
jq -se '[.[] | select(.type == "queue.flaky_check")] | length == 1' e2.json >/dev/null || fail "no queue.flaky_check event"
jq -se '[.[] | select(.type == "changeset.landed")] | length == 1' e2.json >/dev/null || fail "the flaky-but-correct change should land"
jq -se '[.[] | select(.type == "changeset.rejected")] | length == 0' e2.json >/dev/null || fail "nobody may be blamed for a flake"

echo "== E3: a submit that hides a sensitive file from its stats"
G gale start --task "zero-pad formatting" --touch 'src/util/**' --dir gale --json >/dev/null
( cd gale && perl -pi -e 's|"0"|"0" /* pad */|' src/util/format.js && echo "// touched outside the intent, and sensitive" >>src/auth/session.js && G gale checkpoint -m wip --json >/dev/null )
WS=$(jq -r .ws gale/.git/weft.json); HEAD=$(git -C gale rev-parse HEAD); BASE=$(git -C gale config --get weft.base)
S=$(ev 0 | jq '[.data[].seq] | max')
BODY=$(jq -nc --arg h "$HEAD" --arg b "$BASE" '{message: "Zero-pad formatting", head: $h, base: $b, filesTouched: ["src/util/format.js"], linesAdded: 1, linesDeleted: 1, checkpoints: 1, behind: 0}')
curl -s -X POST -H "authorization: Bearer $(cat "$WORK/gale.tok")" -H 'content-type: application/json' "$WEFT_REMOTE/v1/repos/$WEFT_REPO/workspaces/$WS/changesets" --data "$BODY" | jq -c '{submitted: .data.changeset.id, claimedRisk: .data.changeset.riskScore, status: .data.changeset.status}' | tee sub.json
[ "$(jq -r .status sub.json)" = queued ] || fail "the forged claim should have looked harmless at submit"
CS=$(jq -r .submitted sub.json)
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" changeset.rescored 240 >/dev/null || fail "no changeset.rescored event"
ev "$S" | jq -c '.data[] | select(.type == "changeset.rescored") | .data' | tee rescored.json
jq -e '.underReported == true and (.hiddenFiles | index("src/auth/session.js")) != null and .held == true' rescored.json >/dev/null || fail "rescore did not flag the hidden sensitive file"
A show "$CS" --json | jq -c '{status: .data.status, risk: .data.riskScore, claimed: .data.provenance.claimed.filesTouched, actual: .data.provenance.filesTouched, hold: .data.scorecard.hold}' | tee held.json
[ "$(jq -r .status held.json)" = needs_review ] || fail "the under-reported changeset should be held for review"
echo "PASS: flake landed without blame; under-reported diff re-scored and held (repo $WEFT_REPO)"
