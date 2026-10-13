#!/usr/bin/env bash
# Live acceptance for FR-39: import a public GitHub repo as a Weft trunk, then land an agent change on it.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-import_V-0.01.sh [url] [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
URL="${1:-https://github.com/octocat/Hello-World}"
export WEFT_REPO="${2:-imp-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-imp)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
echo "== weft init $WEFT_REPO --import $URL"
A init "$WEFT_REPO" --import "$URL" --batch-window 2000 --json | jq -c '{repo: .data.repo, imported: .data.imported, trunk: .data.initialCommit}' | tee init.json
[ "$(jq -r '.trunk | length' init.json)" = "40" ] || fail "no trunk commit after import"
A agent register --name ike --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/ike.tok"
cd "$WORK"
G ike start --task "add a contributing note" --touch 'CONTRIBUTING.md' --dir ike --json | jq -c '{ws: .data.workspace.id, base: .data.workspace.baseCommit}'
ls ike | head -5
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
( cd ike && printf '# Contributing\n\nChanges land through Weft: weft start, edit, weft submit.\n' >CONTRIBUTING.md && G ike submit -m "Add a contributing note" --json | jq -c '{cs: .data.changeset.id, status: .data.changeset.status}' )
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_landed 600 --print | jq -rc 'select(.type | test("landed|rejected")) | "  \(.type) \(.data.csId // .data.batchId) \(.data.reason // "")"' | tee batch.txt
grep -q 'changeset.landed' batch.txt || fail "agent change did not land on the imported trunk"
A log -n 3 --json | jq -rc '.data[] | "  \(.commit[0:10]) \(.subject) | \(.changeset // "imported history")"'
echo "PASS: imported $URL → $WEFT_REPO and landed an agent change"
