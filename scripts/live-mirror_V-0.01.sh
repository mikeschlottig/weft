#!/usr/bin/env bash
# Live acceptance for D5 (FR-39 mirror-out): after every landing, trunk main + refs/notes/weft are pushed to the
# configured mirror. The target here is a second Artifacts repo (Bearer auth), so no personal GitHub token is
# needed; a GitHub target uses the same path with `--token-env` holding a GitHub token (Basic x-access-token).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-mirror_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft-dev.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-mir-$(date +%m%d%H%M)}"
SINK="${WEFT_REPO}-sink"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-mirror)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { WEFT_TOKEN="$(cat "$WORK/ivy.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ev() { curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=$1"; }
lsr() { git -c "http.extraHeader=Authorization: Bearer $(cat "$WORK/sink.tok")" ls-remote "$(cat "$WORK/sink.remote")" "$1" | cut -f1; }

A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --batch-window 500 --no-judge --json | jq -c '{repo: .data.repo, shard: .data.shard}'
# The mirror target: an empty Artifacts repo (created through Weft's init, which returns a 1 h write token).
curl -s -X POST -H "authorization: Bearer $WEFT_ADMIN_TOKEN" -H 'content-type: application/json' "$WEFT_REMOTE/v1/repos" --data "{\"repo\":\"$SINK\"}" >"$WORK/sink.json"
jq -r .data.remote "$WORK/sink.json" >"$WORK/sink.remote"; jq -r .data.token "$WORK/sink.json" | cut -d'?' -f1 >"$WORK/sink.tok"
[ -s "$WORK/sink.tok" ] || fail "could not create the mirror target"
echo "  mirror target: $(cat "$WORK/sink.remote")"

echo "== configure + first sync (token passed by env var, never argv)"
MIRROR_TOKEN="$(cat "$WORK/sink.tok")" A mirror set --url "$(cat "$WORK/sink.remote")" --token-env MIRROR_TOKEN --bearer --json | jq -c '.data | {url, kind, setBy}' | tee "$WORK/set.json"
grep -q "$(cut -c1-24 "$WORK/sink.tok")" "$WORK/set.json" && fail "token leaked into the response"
A mirror sync --json | jq -c '.data | {ok, pushed, remoteMain}' | tee "$WORK/sync.json"
[ "$(jq -r .ok "$WORK/sync.json")" = true ] || fail "initial mirror sync failed"
H0=$(A log -n 1 --json | jq -r '.data[0].commit')
[ "$(lsr refs/heads/main)" = "$H0" ] || fail "mirror main != trunk after sync"

echo "== a landing is mirrored automatically, with its provenance note"
A agent register --name "ivy$(date +%H%M%S)" --model claude-sonnet-5-5 --json | jq -r '.data.token' >"$WORK/ivy.tok"
cd "$WORK"
G start --task "zero-pad formatting docs" --touch 'src/util/**' --dir ivy --json >/dev/null
S=$(ev 0 | jq '[.data[].seq] | max')
( cd ivy && echo "// mirrored change" >>src/util/format.js && G submit -m "Annotate pad()" --json | jq -c '{cs: .data.changeset.id}' )
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S" mirror.pushed,mirror.failed 300 >/dev/null || fail "no mirror event after landing"
ev "$S" | jq -c '.data[] | select(.type | test("changeset.landed|mirror")) | {type, cs: .data.csId, commit: (.data.commit // null), remoteMain: (.data.remoteMain // null), error: (.data.error // null)}' | tee "$WORK/ev.json"
jq -se '[.[] | select(.type == "mirror.pushed")] | length == 1' "$WORK/ev.json" >/dev/null || fail "mirror push failed after landing"
H1=$(A log -n 1 --json | jq -r '.data[0].commit')
[ "$H1" != "$H0" ] || fail "trunk did not move"
[ "$(lsr refs/heads/main)" = "$H1" ] || fail "mirror main is not the new trunk head"
NOTES=$(lsr refs/notes/weft)
[ -n "$NOTES" ] || fail "provenance notes were not mirrored"
git init -q mcheck && git -C mcheck -c "http.extraHeader=Authorization: Bearer $(cat sink.tok)" fetch -q "$(cat sink.remote)" "+refs/heads/main:refs/heads/main" "+refs/notes/weft:refs/notes/weft"
git -C mcheck notes --ref=weft show "$H1" | head -3
A mirror show --json | jq -c '.data.last'
echo "PASS: mirror-out — trunk $H1 and its provenance note on the mirror after landing (repo $WEFT_REPO → $SINK)"
