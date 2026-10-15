#!/usr/bin/env bash
# Live acceptance for rejection reasons (src/core/check-log.ts): on an npm repo whose install writes
# deprecation warnings to stderr, a changeset that breaks a test is rejected with a reason that names the
# failing test, not the install noise. Uses the admin token and a non-eval repo, so no evaluator slot is used.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-rejection-excerpt_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-rejx-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-rejx)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
fail() { printf 'FAIL: %s\n' "$*"; exit 1; }

echo "== import jonschlinkert/is-number as $WEFT_REPO (npm check: install warnings go to stderr)"
A init "$WEFT_REPO" --import https://github.com/jonschlinkert/is-number --check 'npm install --no-audit --no-fund && npm test' --json \
  | jq -ce '.ok and .data.repo != null' >/dev/null || fail "import"
A agent register --name rejx --model script --json | jq -r '.data.token' >"$WORK/rejx.tok"; chmod 600 "$WORK/rejx.tok"

echo "== an agent breaks a test: strings with surrounding whitespace stop counting as numbers"
cd "$WORK"
WEFT_TOKEN="$(cat rejx.tok)" node "$CLI" start --task "reject strings with surrounding whitespace" --touch index.js --dir ws --json | jq -ce '.ok' >/dev/null || fail "start"
cd ws
sed -i.bak "s/  if (typeof num === 'string' \&\& num.trim() !== '') {/  if (typeof num === 'string' \&\& num.trim() !== '' \&\& num.trim() === num) {/" index.js && rm -f index.js.bak
git diff --quiet && fail "edit did not apply"
git commit -qam "reject padded strings" && git push -q
CS="$(WEFT_TOKEN="$(cat ../rejx.tok)" node "$CLI" submit -m "reject padded strings" --json | jq -r '.data.changeset.id // .data.id')"
[ -n "$CS" ] && [ "$CS" != null ] || fail "submit"
echo "   submitted $CS"

echo "== wait for the queue"
for _ in $(seq 1 60); do
  S="$(curl -s --max-time 30 "$WEFT_REMOTE/v1/repos/$WEFT_REPO/changesets/$CS" | jq -r '.data.status')"
  case "$S" in rejected|landed|needs_review) break ;; esac; sleep 10
done
J="$(curl -s --max-time 30 "$WEFT_REMOTE/v1/repos/$WEFT_REPO/changesets/$CS")"
echo "$J" | jq -c '.data | {status, reason: .rejection.reason}'
[ "$(echo "$J" | jq -r '.data.status')" = rejected ] || fail "expected rejected, got $(echo "$J" | jq -r '.data.status')"
[ "$(echo "$J" | jq -r '.data.rejection.reason')" = check_failed ] || fail "expected check_failed"
D="$(echo "$J" | jq -r '.data.rejection.detail')"
printf '%s\n' "--- rejection detail" "$D" "---"
grep -q 'npm warn' <<<"$D" && fail "the reason still shows npm install warnings"
grep -qE 'failing|AssertionError|should be a number' <<<"$D" || fail "the reason does not name the failing test"
echo "PASS: rejection reason names the failing test, no install noise (repo $WEFT_REPO, $CS)"
