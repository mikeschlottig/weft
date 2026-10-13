#!/usr/bin/env bash
# Live acceptance for FR-33 signed trunk commits + FR-34 provenance bundles linked by git notes.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-provenance_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-prov-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-prov)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --batch-window 2000 --json | jq -c '{repo: .data.repo}'
A agent register --name pia --model claude-opus-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/pia.tok"
cd "$WORK"
G pia start --task "round invoice totals" --touch 'src/billing/**' --dir pia --json >/dev/null
echo "the prompt that produced this change" >prompt.txt
S=$(curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events" | jq '[.data[].seq] | max')
( cd pia && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal * 100) / 100;|' src/billing/invoice.js && G pia submit -m "Round invoice totals" --prompt-file ../prompt.txt --tool-calls 7 --cost 0.12 --json | jq -c '{cs: .data.changeset.id}' | tee ../cs.json )
CS=$(jq -r .cs cs.json)
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" changeset.landed 600 >/dev/null || fail "did not land"
echo "== signing key published at /v1/signing-key"
curl -s "$WEFT_REMOTE/v1/signing-key" | jq -r '.data.allowedSigners' >allowed_signers
grep -q '^queue@weft.dev namespaces="git" ssh-ed25519 ' allowed_signers || fail "no allowed-signers line"
echo "== fetch trunk + notes and verify the landed commit"
( cd pia && git -c "http.extraHeader=Authorization: Bearer $(jq -r .trunk.token .git/weft.json)" fetch -q trunk main '+refs/notes/weft:refs/notes/weft' )
SHA=$(cd pia && git rev-parse FETCH_HEAD)
(cd pia && git -c gpg.ssh.allowedSignersFile=../allowed_signers verify-commit "$SHA") 2>&1 | tee verify.txt
grep -q 'Good "git" signature for queue@weft.dev' verify.txt || fail "trunk commit signature did not verify"
(cd pia && git notes --ref=weft show "$SHA") | tee note.txt
grep -q "changeset: $CS" note.txt || fail "provenance note missing"
echo "== the bundle the note points at"
curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/changesets/$CS/provenance" | jq '{sha256: .data.sha256, commit: .data.commit, agent: .data.bundle.agent, promptSha256: .data.bundle.promptSha256, toolCalls: .data.bundle.toolCalls, costUsd: .data.bundle.costUsd, risk: .data.bundle.risk.score}' | tee bundle.json
[ "$(jq -r .sha256 bundle.json)" = "$(sed -n 's/^sha256: //p' note.txt)" ] || fail "bundle sha256 does not match the note"
[ "$(jq -r .commit bundle.json)" = "$SHA" ] || fail "bundle commit mismatch"
[ "$(jq -r .promptSha256 bundle.json)" = "$(shasum -a 256 prompt.txt | cut -d' ' -f1)" ] || fail "prompt hash mismatch"
echo "PASS: signed trunk commit + provenance bundle via git notes (repo $WEFT_REPO, $CS @ ${SHA:0:10})"
