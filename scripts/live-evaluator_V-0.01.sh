#!/usr/bin/env bash
# Live acceptance for contest evaluator access (src/core/evaluator.ts).
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-evaluator_V-0.01.sh
# 1. mints a short-lived evaluator token (admin), 2. proves every out-of-scope action is FORBIDDEN,
# 3. runs try-your-repo on a real GitHub repo with two agents and waits for both to land with a passing
#    merged-tree check. Tokens are kept in a mode-700 temp dir and never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
R="$WEFT_REMOTE"; CLI="$ROOT/cli/weft.ts"
WORK="$(mktemp -d -t weft-eval)"; chmod 700 "$WORK"
fail() { printf 'FAIL: %s\n' "$*"; exit 1; }

echo "== mint an evaluator token (expires in 2 h)"
EXP="$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
curl -s --max-time 60 -X POST -H "authorization: Bearer $WEFT_ADMIN_TOKEN" -H 'content-type: application/json' \
  "$R/v1/admin/evaluator-token" --data "{\"label\":\"gate-$(date +%H%M%S)\",\"expiresAt\":\"$EXP\"}" >"$WORK/mint.json"
jq -e '.ok' "$WORK/mint.json" >/dev/null || fail "mint: $(jq -c .error "$WORK/mint.json")"
jq -r '.data.token' "$WORK/mint.json" >"$WORK/ev.tok"; jq -c '{expiresAt: .data.expiresAt, limits: .data.limits}' "$WORK/mint.json"; rm "$WORK/mint.json"
E="$(cat "$WORK/ev.tok")"

echo "== out-of-scope actions must be FORBIDDEN"
deny() { # label curl-args...
  local label="$1"; shift
  local code; code="$(curl -s --max-time 60 "$@" | jq -r '.error.code // "OK"')"
  printf '  %-44s %s\n' "$label" "$code"
  [ "$code" = "FORBIDDEN" ] || fail "$label returned $code"
}
deny "rotate signing keys" -X POST -H "authorization: Bearer $E" "$R/v1/admin/keys/rotate"
deny "mint another evaluator token" -X POST -H "authorization: Bearer $E" -H 'content-type: application/json' "$R/v1/admin/evaluator-token" --data '{"label":"x"}'
deny "kill an agent" -X POST -H "authorization: Bearer $E" "$R/v1/agents/atlas/kill"
deny "create a non-eval repo" -X POST -H "authorization: Bearer $E" -H 'content-type: application/json' "$R/v1/repos" --data '{"repo":"not-eval"}'
deny "import from outside GitHub" -X POST -H "authorization: Bearer $E" -H 'content-type: application/json' "$R/v1/repos" --data '{"repo":"eval-x","import":{"url":"https://gitlab.com/a/b"}}'
deny "register a non-eval agent" -X POST -H "authorization: Bearer $E" -H 'content-type: application/json' "$R/v1/agents" --data '{"name":"atlas","model":"x"}'
deny "configure a non-eval repo" -X PATCH -H "authorization: Bearer $E" -H 'content-type: application/json' "$R/v1/repos/shop-10141259/config" --data '{"checkCommand":"true"}'
deny "approve in a non-eval repo" -X POST -H "authorization: Bearer $E" "$R/v1/repos/shop-10141259/changesets/cs-0020/approve"

echo "== try-your-repo on a real GitHub repository, two agents"
WEFT_TOKEN="$E" bash "$ROOT/scripts/try-your-repo_V-0.01.sh" https://github.com/jonschlinkert/is-number --agents 2 >"$WORK/try.log" 2>&1 || { cat "$WORK/try.log"; fail "try-your-repo"; }
REPO="$(grep -oE 'eval-is-number-[0-9a-f]{4}' "$WORK/try.log" | head -1)"; TW="$(grep -oE '/[^ ]*weft-try\.[A-Za-z0-9]+' "$WORK/try.log" | head -1)"
[ -n "$REPO" ] && [ -d "$TW" ] || fail "could not read repo/work dir from try-your-repo output"
echo "  repo $REPO"
A1="$(ls "$TW"/eval-*-a1.tok)"; A2="$(ls "$TW"/eval-*-a2.tok)"
deny "evaluation agent outside eval-*" -X POST -H "authorization: Bearer $(cat "$A1")" -H 'content-type: application/json' "$R/v1/repos/shop-10141259/workspaces" --data '{"task":"x","globs":["src/**"],"mode":"soft"}'
export WEFT_REPO="$REPO"; cd "$WORK"
WEFT_TOKEN="$(cat "$A1")" node "$CLI" start --task "add whitespace tests" --touch 'test.js' --dir a1 --json >a1.json &
WEFT_TOKEN="$(cat "$A2")" node "$CLI" start --task "document number formats" --touch 'README.md' --dir a2 --json >a2.json &
wait
jq -e '.ok' a1.json a2.json >/dev/null || fail "start: $(jq -c .error a1.json a2.json)"
printf "\ndescribe('whitespace', function() {\n  it('\" 12 \" is a number', function() { assert(isNumber(' 12 ')); });\n});\n" >>a1/test.js
printf '\n## Supported formats\n\nIntegers, floats, negatives, exponents and hex literals.\n' >>a2/README.md
(cd a1 && WEFT_TOKEN="$(cat "$A1")" node "$CLI" submit -m "Add a whitespace test" --json >../a1.sub.json) &
(cd a2 && WEFT_TOKEN="$(cat "$A2")" node "$CLI" submit -m "Document formats" --json >../a2.sub.json) &
wait
jq -e '.ok' a1.sub.json a2.sub.json >/dev/null || fail "submit: $(jq -c .error a1.sub.json a2.sub.json)"
settle() {
  for i in $(seq 1 60); do
    s="$(curl -s --max-time 30 "$R/v1/repos/$REPO/snapshot" | jq -r '[.data.changesets[].status] | join(",")')"
    case "$s" in *queued*|*validating*|"") sleep 10 ;; *) break ;; esac
  done
}
settle
# A change the judges hold (e.g. CLEF and Gemma disagree) waits for a human: the evaluator is that human here.
for cs in $(curl -s --max-time 30 "$R/v1/repos/$REPO/snapshot" | jq -r '.data.changesets[] | select(.status == "needs_review") | .id'); do
  printf '  %s held: %s → approved by the evaluator\n' "$cs" "$(curl -s --max-time 30 "$R/v1/repos/$REPO/changesets/$cs" | jq -r '.data.scorecard.hold')"
  WEFT_TOKEN="$E" node "$CLI" approve "$cs" --by evaluator --json | jq -e '.ok' >/dev/null || fail "evaluator could not approve $cs"
done
settle
curl -s --max-time 30 "$R/v1/repos/$REPO/snapshot" | jq -c '.data.changesets[] | {id, agent: .provenance.agentName, status, wqs: .scorecard.total, judge: .scorecard.judge.model}' | tee landed.json
[ "$(jq -s '[.[] | select(.status == "landed")] | length' landed.json)" = "2" ] || fail "both changesets should land (got: $s)"
echo "PASS: evaluator access scoped to eval-*, GitHub import + two agents landed on $REPO ($R/#$REPO)"
