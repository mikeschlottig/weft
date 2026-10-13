#!/usr/bin/env bash
# Live acceptance for FR-47 outcome labels + FR-48 second-opinion judge and calibration report.
#   WEFT_REMOTE=… WEFT_ADMIN_TOKEN=… bash scripts/live-outcomes_V-0.01.sh [repo]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
export WEFT_REPO="${1:-out-$(date +%m%d%H%M)}"
CLI="$ROOT/cli/weft.ts"; WORK="$(mktemp -d -t weft-out)"; chmod 700 "$WORK"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
landed() { for _ in $(seq 1 120); do st=$(A show "$1" --json | jq -r '.data.status'); case "$st" in landed|rejected|needs_review) echo "$st"; return;; esac; sleep 3; done; echo timeout; }
A init "$WEFT_REPO" --from "$ROOT/examples/shop" --check 'node --test test/*.test.js' --sensitive 'src/auth/**' --batch-window 1500 --json | jq -c '{repo: .data.repo}'
for a in ola pia ula; do A agent register --name "$a" --model claude-sonnet-5-5 --ttl-hours 2 --json | jq -r '.data.token' >"$WORK/$a.tok"; done
cd "$WORK"
echo "== ola lands a rounding change; pia lands a FIX on the same file → ola's change is labelled hotfixed"
G ola start --task "round invoice totals" --touch 'src/billing/**' --dir ola --json >/dev/null
( cd ola && perl -pi -e 's|  return subtotal;|  return Math.round(subtotal);|' src/billing/invoice.js && G ola submit -m "Round invoice totals" --json | jq -r '.data.changeset.id' >../ola.cs )
echo "  $(cat ola.cs): $(landed "$(cat ola.cs)")"
A show "$(cat ola.cs)" --json | jq -c '{judge: .data.scorecard.judge.model, second: .data.scorecard.judge.second.model, intent: .data.scorecard.judge.intentAlignment, secondIntent: .data.scorecard.judge.second.intentAlignment, disagreement: .data.scorecard.judge.disagreement}' | tee judge.json
[ "$(jq -r .second judge.json)" = "@cf/cloudflare/clef-flash" ] || fail "no second-opinion judge on the scorecard"
G pia start --task "fix rounding to cents" --touch 'src/billing/**' --dir pia --json >/dev/null
( cd pia && perl -pi -e 's|Math.round\(subtotal\)|Math.round(subtotal * 100) / 100|' src/billing/invoice.js && G pia submit -m "Fix rounding bug: round to cents" --json | jq -r '.data.changeset.id' >../pia.cs )
echo "  $(cat pia.cs): $(landed "$(cat pia.cs)")"
A show "$(cat ola.cs)" --json | jq -c '{cs: .data.id, outcome: .data.outcome}' | tee ola.out.json
[ "$(jq -r .outcome.label ola.out.json)" = hotfixed ] || fail "ola's change was not labelled hotfixed"
echo "== ula's sensitive change is held; a human rejects it → human_rejected"
G ula start --task "shorten session TTL" --touch 'src/auth/**' --dir ula --json >/dev/null
( cd ula && perl -pi -e 's|86400|60|' src/auth/session.js && G ula submit -m "Shorten session TTL to a minute" --json | jq -r '.data.changeset.id' >../ula.cs )
A reject "$(cat ula.cs)" --reason "60 s sessions break mobile clients" --by mike --json | jq -c '{cs: .data.id, status: .data.status, outcome: .data.outcome.label}'
echo "== calibration report (D1 projection is eventually consistent: poll ≤ 60 s)"
for _ in $(seq 1 20); do
  A calibration --repo "$WEFT_REPO" --json | jq -c '.data | {labeled, bad, sufficient, autoLandPrecision, note, intent: (.signals[] | select(.signal == "intentAlignment") | {n, best})}' >cal.json
  [ "$(jq -r .bad cal.json)" -ge 2 ] && break; sleep 3
done
cat cal.json
[ "$(jq -r .bad cal.json)" -ge 2 ] || fail "calibration did not see both labelled outcomes"
echo "PASS: outcome labels (hotfixed, human_rejected) + second-opinion judge + calibration report (repo $WEFT_REPO)"
