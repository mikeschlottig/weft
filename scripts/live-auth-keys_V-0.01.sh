#!/usr/bin/env bash
# Live acceptance for D6 + E8: EdDSA agent tokens, the public JWKS, refresh, the 1 h TTL policy, and rotation
# with a one-key overlap (a rotation never logs anyone out; the key before it is retired).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-auth-keys_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft-dev.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-keys-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-keys)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
T() { local f="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$f")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
hdr() { node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1], "utf8").split(".")[0], "base64url"))' "$WORK/$1"; }
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --no-judge --json | jq -c '{repo: .data.repo}'
AG="kai$(date +%H%M%S)"

echo "== EdDSA token, verified independently against /.well-known/jwks.json"
A agent register --name "$AG" --model claude-opus-5-5 --json >"$WORK/reg.json"
jq -r .data.token "$WORK/reg.json" >"$WORK/t1"
jq -c '.data | {kid, ttlSeconds, longLived}' "$WORK/reg.json"
[ "$(jq -r .data.ttlSeconds "$WORK/reg.json")" = 3600 ] || fail "default agent token TTL must be 1 h"
curl -s "$WEFT_REMOTE/.well-known/jwks.json" | jq -c '.data' >"$WORK/jwks.json"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const tok = readFileSync(process.argv[1], "utf8").trim();
  const jwks = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const [h, b, s] = tok.split(".");
  const head = JSON.parse(Buffer.from(h, "base64url"));
  const jwk = jwks.keys.find((k) => k.kid === head.kid);
  if (head.alg !== "EdDSA" || !jwk) { console.error("not EdDSA / kid not published", head); process.exit(1); }
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${b}`));
  const claims = JSON.parse(Buffer.from(b, "base64url"));
  console.log(JSON.stringify({ alg: head.alg, kid: head.kid, verifiedLocally: ok, ttl: claims.exp - claims.iat, jti: claims.jti ? "present" : "missing" }));
  process.exit(ok ? 0 : 1);
' "$WORK/t1" "$WORK/jwks.json" || fail "token does not verify against the published JWKS"
T t1 who src/util/format.js --json | jq -e '.ok == true' >/dev/null || fail "fresh token refused"

echo "== TTL policy"
A agent register --name "${AG}b" --model m --ttl-hours 6 --json | jq -c '{ttl: .data.ttlSeconds, longLived: .data.longLived, hint: .hints[0]}' | tee "$WORK/ttl.json"
[ "$(jq -r .ttl "$WORK/ttl.json")" = 3600 ] || fail "6 h without --long-lived must be capped at 1 h"
A agent register --name "${AG}c" --model m --ttl-hours 6 --long-lived --json | jq -c '{ttl: .data.ttlSeconds, longLived: .data.longLived}' | tee "$WORK/ll.json"
[ "$(jq -r .ttl "$WORK/ll.json")" = 21600 ] && [ "$(jq -r .longLived "$WORK/ll.json")" = true ] || fail "explicit long-lived grant not honoured"

echo "== refresh"
T t1 agent refresh --json | jq -r .data.token >"$WORK/t2"
T t2 who src/util/format.js --json | jq -e '.ok == true' >/dev/null && echo "  refreshed token works"

echo "== rotation 1: the old key becomes 'previous' — tokens it signed keep working"
A keys rotate --json | jq -c '.data' | tee "$WORK/rot1.json"
T t1 who src/util/format.js --json | jq -e '.ok == true' >/dev/null || fail "rotation logged out a token signed by the previous key"
echo "  pre-rotation token still accepted"
T t1 agent refresh --json | jq -r .data.token >"$WORK/t3"
K3=$(hdr t3 | jq -r .kid)
[ "$K3" = "$(jq -r .current "$WORK/rot1.json")" ] || fail "refresh after rotation should sign with the new key (got $K3)"
curl -s "$WEFT_REMOTE/.well-known/jwks.json" | jq -c '{published: [.data.keys[].kid]}'

echo "== rotation 2: the original key is retired — its tokens are refused, newer ones still work"
A keys rotate --json | jq -c '.data' | tee "$WORK/rot2.json"
set +e; T t1 who src/util/format.js --json >"$WORK/old.json" 2>&1; set -e
jq -c '{code: .error.code, message: .error.message}' "$WORK/old.json"
[ "$(jq -r .error.code "$WORK/old.json")" = UNAUTHENTICATED ] || fail "a token signed by a retired key was accepted"
T t3 who src/util/format.js --json | jq -e '.ok == true' >/dev/null || fail "token signed by the now-previous key refused"
A keys list --json | jq -c '.data'
echo "PASS: EdDSA + JWKS, 1 h default, audited long-lived grant, refresh, two-step rotation (repo $WEFT_REPO)"
