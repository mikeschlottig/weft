#!/usr/bin/env bash
# Live acceptance for D8 (FR-15): a sandbox per workspace. The agent never clones anything locally:
# `weft start --sandbox` clones its fork inside a container owned by the workspace's Durable Object,
# `weft exec` edits and tests there, `weft submit` commits + pushes from there, and the change lands.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-sandbox_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft-dev.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-sbx-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-sandbox)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { WEFT_TOKEN="$(cat "$WORK/ash.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --batch-window 500 --no-judge --json | jq -c '{repo: .data.repo, shard: .data.shard}'
A agent register --name "ash$(date +%H%M%S)" --model claude-opus-5-5 --json | jq -r '.data.token' >"$WORK/ash.tok"
cd "$WORK"

echo "== start --sandbox (no local clone)"
T0=$(date +%s)
G start --task "round invoice totals to cents" --touch 'src/billing/**' --touch 'test/**' --sandbox --dir ash --json | tee start.json | jq -c '{ws: .data.workspace.id, sandbox: .data.sandbox}'
echo "  sandbox ready in $(( $(date +%s) - T0 )) s"
[ -f ash/.weft-sandbox.json ] && [ ! -d ash/.git ] || fail "expected a sandbox pointer and no local checkout"
cd ash

echo "== exec: look around, edit, run the repo's tests — all in the sandbox"
G exec --json -- "git log --oneline -1 && git status --short | wc -l && node --version" | tee first.json | jq -c 'if .ok then {exit: .data.exitCode, out: .data.stdout, ms: .data.ms} else .error end'
jq -e '.ok == true' first.json >/dev/null || fail "first exec failed: $(jq -c .error first.json)"
G exec --json -- "perl -pi -e 's|  return subtotal;|  return Math.round(subtotal * 100) / 100;|' src/billing/invoice.js && grep -n 'Math.round' src/billing/invoice.js" | jq -c '{exit: .data.exitCode, out: .data.stdout}'
G exec --json -- "node --test test/*.test.js 2>&1 | tail -4" | tee test.json | jq -c '{exit: .data.exitCode, out: .data.stdout}'
[ "$(jq -r .data.exitCode test.json)" = 0 ] || fail "tests should pass in the sandbox"
set +e; G exec --json -- "exit 3" >ex3.json; set -e
[ "$(jq -r .data.exitCode ex3.json)" = 3 ] || fail "a failing command must report its exit code"
G sandbox status --json | jq -c '.data | {running, cloned, head: .head[0:10]}'

echo "== submit from the sandbox → queue → landed"
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
G submit -m "Round invoice totals to cents" --json | tee sub.json | jq -c '{cs: .data.changeset.id, status: .data.changeset.status, files: .data.changeset.provenance.filesTouched, sandboxHead: .data.sandbox.head[0:10]}'
CS=$(jq -r .data.changeset.id sub.json)
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" changeset.landed,changeset.rejected 300 >/dev/null || fail "no verdict"
A show "$CS" --json | jq -c '{status: .data.status, commit: .data.landedCommit[0:10], risk: .data.riskScore, rescoredClaim: (.data.provenance.claimed != null)}' | tee show.json
[ "$(jq -r .status show.json)" = landed ] || fail "sandbox changeset did not land"
A log -n 1 --json | jq -rc '.data[0] | "  trunk: \(.commit[0:10]) \(.subject) | \(.changeset)"'
G sandbox close --json | jq -c '.data'
echo "PASS: sandbox workspace — cloned, edited, tested and submitted in the cloud; $CS landed (repo $WEFT_REPO)"
