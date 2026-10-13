#!/usr/bin/env bash
# Live acceptance for FR-25 recipe changesets and driver registry v2 (json-merge).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-recipes-drivers_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-rcp-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-rcp)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
RENAME='files=$(grep -rlw -- "$1" src test || true); [ -z "$files" ] || perl -pi -e '"'"'s/\b\Q$ENV{WEFT_ARG_1}\E\b/$ENV{WEFT_ARG_2}/g'"'"' $files'

A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --union 'CHANGELOG.md' \
  --driver 'package.json=json-merge' --recipe-def "rename=$RENAME" --batch 6 --batch-window 9000 --json | jq -c '{repo: .data.repo, drivers: .data.config.drivers, recipes: (.data.config.recipes | keys)}'
for a in una vic wes xia; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
G una start --task "add an invoice report" --touch 'src/billing/**' --touch 'test/**' --dir una --json >/dev/null
G vic start --task "rename total to invoiceTotal" --touch 'src/**' --touch 'test/**' --dir vic --json >/dev/null
G wes start --task "add npm test script" --touch 'package.json' --dir wes --json >/dev/null
G xia start --task "pin node engine" --touch 'package.json' --dir xia --json >/dev/null

echo "== una adds a NEW caller of total(); vic renames total → invoiceTotal as a recipe"
( cd una
  printf 'import { total } from "./invoice.js";\nexport const report = (items) => `total: ${total(items)}`;\n' >src/billing/report.js
  printf 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { report } from "../src/billing/report.js";\ntest("report", () => assert.equal(report([{ price: 2, qty: 3 }]), "total: 6"));\n' >test/report.test.js
  G una submit -m "Add an invoice report" --json | jq -c '{una: .data.changeset.id}' )
( cd vic
  G vic recipe run rename --arg total --arg invoiceTotal --json | jq -c '{ran: .data.recipe, changed: .data.changed}' 
  G vic submit -m "Rename total to invoiceTotal" --recipe rename --arg total --arg invoiceTotal --json | jq -c '{vic: .data.changeset.id, recipe: .data.changeset.recipe}' )
echo "== wes and xia both edit the one-line package.json (a guaranteed text conflict)"
( cd wes && printf '{ "name": "shop", "type": "module", "private": true, "scripts": { "test": "node --test" } }\n' >package.json && G wes submit -m "Add npm test script" --json | jq -c '{wes: .data.changeset.id}' )
( cd xia && printf '{ "name": "shop", "type": "module", "private": true, "engines": { "node": ">=24" } }\n' >package.json && G xia submit -m "Pin node engine" --json | jq -c '{xia: .data.changeset.id}' )
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[] | select(.type == "changeset.submitted")][0].seq - 1')
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" queue.batch_landed 600 --print | jq -rc 'select(.type | test("batch_started|landed|rejected")) | "  \(.type) \(.data.csId // .data.batchId) \(.data.agentName // "") \(.data.reason // "")"' | tee batch.txt
[ "$(grep -c 'changeset.landed' batch.txt)" = "4" ] || fail "expected all four changesets to land"
(cd una && git -c "http.extraHeader=Authorization: Bearer $(jq -r .trunk.token .git/weft.json)" fetch -q trunk main)
echo "  trunk src/billing/report.js:"; (cd una && git show FETCH_HEAD:src/billing/report.js) | tee report.js | sed 's/^/    /'
grep -q 'invoiceTotal' report.js || fail "the replayed recipe did not rename una's new call site"
echo "  trunk package.json:"; (cd una && git show FETCH_HEAD:package.json) | tee pkg.json | sed 's/^/    /'
jq -e '.scripts.test == "node --test" and .engines.node == ">=24"' pkg.json >/dev/null || fail "json-merge did not combine both keys"
A log -n 6 --json | jq -rc '.data[] | "  \(.commit[0:10]) \(.subject) | \(.trailers["Weft-Recipe"] // "")"'
echo "PASS: recipes + json-merge driver (repo $WEFT_REPO)"
