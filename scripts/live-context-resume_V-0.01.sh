#!/usr/bin/env bash
# Live acceptance for context packs + resume (A2, A3 / FR-16) against a repo that already ran demo-live.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-context-resume_V-0.01.sh <repo>
# Exits non-zero on the first failed expectation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:?usage: live-context-resume_V-0.01.sh <repo>}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-ctx)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
K() { WEFT_TOKEN="$(cat "$WORK/kai.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
api() { curl -s -m 60 -X "$1" -H "authorization: Bearer $WEFT_ADMIN_TOKEN" -H 'content-type: application/json' "$WEFT_REMOTE$2" ${3:+--data "$3"}; }

A agent register --name kai --model claude-opus-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/kai.tok"; chmod 600 "$WORK/kai.tok"
cd "$WORK"
echo "== start kai in a scope with history (src/billing/**)"
K start --task "add invoice due dates" --touch 'src/billing/**' --dir kai --json | jq -c '{ws: .data.workspace.id, forecast: .data.forecast.risk}'
WS=$(git -C kai config weft.ws)
echo "== context pack (markdown)"
(cd kai && K context --md --json) | jq -r '.data' >ctx.md
head -30 ctx.md
grep -q "# Weft context — $WEFT_REPO · $WS" ctx.md || fail "context header"
grep -q "Recently landed in your scope" ctx.md || fail "recent landings section"
grep -q "House rules" ctx.md || fail "house rules section"

echo "== kai does some work and checkpoints it to its fork"
( cd kai
  printf '\n// TODO(kai): due dates — started before the crash\n' >>src/billing/invoice.js
  K checkpoint -m "wip: due dates" --json | jq -c '{commit: .data.commit, pushed: .data.pushed}' )
echo "== let the lease expire (repo lease TTL → 5 s for this test)"
api PATCH "/v1/repos/$WEFT_REPO/config" '{"leaseTtlSeconds":5}' | jq -c '{ok, leaseTtl: .data.leaseTtlSeconds}'
(cd kai && K status --json >/dev/null)   # heartbeat renews with the new 5 s TTL
sleep 8
(cd kai && K context --json) | jq -e '.data.workspace.expired == true' >/dev/null || fail "context did not report the expired lease"
echo "  context reports: lease EXPIRED"
api PATCH "/v1/repos/$WEFT_REPO/config" '{"leaseTtlSeconds":1800}' | jq -c '{ok, leaseTtl: .data.leaseTtlSeconds}'

echo "== resume from a DIFFERENT directory (new session / new machine): re-clone + re-acquire"
K resume "$WS" --repo "$WEFT_REPO" --dir kai2 --json | jq -c '{ws: .data.workspace.id, wasExpired: .data.wasExpired, forecast: .data.forecast.risk, path: .data.path}' | tee resume.json
jq -e '.wasExpired == true' resume.json >/dev/null || fail "resume did not see the expiry"
(cd kai2 && K context --json) | jq -e '.data.workspace.expired == false' >/dev/null || fail "lease not renewed"
grep -q "started before the crash" kai2/src/billing/invoice.js || fail "checkpointed work was not restored in the new checkout"
echo "  checkpointed work restored in the new checkout"
echo "  lease renewed; work continues in the new checkout"
( cd kai2
  cat >>src/billing/invoice.js <<'JS'

export function dueDate(issued, days = 30) {
  return new Date(issued.getTime() + days * 86_400_000);
}
JS
  K submit -m "Add invoice due dates" --json | jq -c '{cs: .data.changeset.id, status: .data.changeset.status}' )
echo "PASS: context pack + resume"
