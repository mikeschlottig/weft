#!/usr/bin/env bash
# Weft LIVE demo — five agents, one trunk, running on Cloudflare (Workers · Durable Objects ·
# Artifacts · Workflows · Containers · Workers AI). Port of prototype/cli/scripts/demo_V-0.01.sh.
#   act 1  concurrent starts: intents, forecasts, an exclusive lease refusing a fifth agent
#   act 2  concurrent edits + heartbeats: overlap detected BEFORE anyone submits
#   act 3  the queue: speculative batch, CLEF rubric judge (+ Gemma 4 second opinion), conflict, bisection, single trunk push
#   act 4  human review of a sensitive change, conflict resolution, resubmits, second batch
#   act 5  provenance trailers, quality leaderboard, one-command revert
#
# Usage: WEFT_ADMIN_TOKEN=… bash scripts/demo-live_V-0.01.sh [repo-name]
#   (or keep WEFT_ADMIN_TOKEN in ~/.env/weft.env — sourced automatically)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -z "${WEFT_ADMIN_TOKEN:-}" && -f "$HOME/.env/weft.env" ]] && { set -a; . "$HOME/.env/weft.env"; set +a; }
: "${WEFT_ADMIN_TOKEN:?set WEFT_ADMIN_TOKEN}"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
# Any failure prints a fixed marker (the video tape waits on it so a broken run ends the recording at once).
trap 'rc=$?; [[ $rc -ne 0 ]] && printf "\nDEMO FAILED (exit %s)\n" "$rc"' EXIT
export WEFT_REPO="${1:-shop-$(date +%m%d%H%M)}"
EXAMPLE="${WEFT_EXAMPLE:-$ROOT/examples/shop}"
WORK="$(mktemp -d -t weft-live)"; chmod 700 "$WORK"
CLI="$ROOT/cli/weft.ts"
A() { WEFT_TOKEN="$WEFT_ADMIN_TOKEN" node "$CLI" "$@"; }            # admin (human)
G() { local who="$1"; shift; WEFT_TOKEN="$(cat "$WORK/$who.tok")" node "$CLI" "$@"; }  # agent
J() { jq -r "$1"; }
say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
seq_now() { curl -s "$WEFT_REMOTE/v1/repos/$WEFT_REPO/events?since=0" | jq '[.data[].seq] | max // 0'; }

say "init: trunk '$WEFT_REPO' as an Artifacts repo · check = node --test · src/auth is sensitive · CHANGELOG union-merged"
A init "$WEFT_REPO" --from "$EXAMPLE" --check 'node --test test/*.test.js' --sensitive 'src/auth/**' --union 'CHANGELOG.md' --batch 4 --batch-window 9000 --json \
  | jq -c '{repo: .data.repo, remote: .data.remote, initialCommit: .data.initialCommit}'
for spec in atlas:claude-opus-5-5 birch:claude-sonnet-5-5 cedar:claude-haiku-5-5 dune:claude-sonnet-5-5 elm:claude-haiku-5-5; do
  A agent register --name "${spec%%:*}" --model "${spec##*:}" --ttl-hours 6 --json | J '.data.token' > "$WORK/${spec%%:*}.tok"
  chmod 600 "$WORK/${spec%%:*}.tok"
done
echo "agents: atlas birch cedar dune elm (short-lived JWTs minted by the control plane)"
echo "watch live: $WEFT_REMOTE/#$WEFT_REPO"

cd "$WORK"
say "act 1 — four agents start CONCURRENTLY (serialized by the repo's Durable Object)"
G atlas start --task "add sales tax to invoices" --touch 'src/billing/**' --touch 'test/invoice.test.js' --dir atlas --json >atlas.json &
G birch start --task "add currency formatting" --touch 'src/util/**' --dir birch --json >birch.json &
G cedar start --task "add volume discount" --touch 'src/billing/**' --dir cedar --json >cedar.json &
G dune start --task "shorten session TTL" --touch 'src/auth/**' --exclusive --dir dune --json >dune.json &
for pid in $(jobs -p); do wait "$pid" || { for a in atlas birch cedar dune; do echo "  $a: $(J '.error.message // "ok"' <"$a.json" 2>/dev/null)" >&2; done; exit 1; }; done
for a in atlas birch cedar dune; do printf '  %-6s %-20s forecast=%s\n' "$a" "$(J '.data.workspace.id' <"$a.json")" "$(J '.data.forecast.risk' <"$a.json")"; done

say "act 1b — elm asks for src/auth/session.js while dune holds an exclusive lease"
set +e; G elm start --task "log session expiry" --touch 'src/auth/session.js' --dir elm --json >elm.json; code=$?; set -e
echo "  exit=$code code=$(J '.error.code' <elm.json) hint=\"$(J '.error.hint' <elm.json)\""

say "act 2 — all four agents edit at the same time (each in its own Artifacts fork)"
( cd atlas
  perl -pi -e 's|\Q  return subtotal;\E|  return Math.round(subtotal * 1.08 * 100) / 100;|' src/billing/invoice.js
  perl -pi -e 's|\Q), 20);\E|), 21.6);|' test/invoice.test.js
  echo "- billing: 8% sales tax on invoice totals (atlas)" >>CHANGELOG.md
  G atlas checkpoint -m "wip: tax" --json >/dev/null ) &
( cd birch
  cat >src/util/format.js <<'EOF'
export function pad(value, width) {
  return String(value).padStart(width, " ");
}

export function currency(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
EOF
  echo "- util: currency() formatter (birch)" >>CHANGELOG.md ) &
( cd cedar
  cat >src/billing/invoice.js <<'EOF'
export function discount(subtotal) {
  return subtotal >= 100 ? subtotal * 0.1 : 0;
}

export function total(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal - discount(subtotal);
}
EOF
  cat >test/discount.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/billing/invoice.js";

test("10% discount at 100 or more", () => {
  assert.equal(total([{ price: 200, qty: 1 }]), 180);
});
EOF
  echo "- billing: 10% volume discount over \$100 (cedar)" >>CHANGELOG.md ) &
( cd dune
  perl -pi -e 's|86400|3600|' src/auth/session.js
  echo "- auth: session TTL cut to 1h (dune)" >>CHANGELOG.md ) &
wait

say "act 2b — heartbeats: cedar learns atlas is in the same file BEFORE either submits"
(cd cedar && G cedar status --json) | jq '{touched: .data.touched, forecast: .data.forecast.risk, overlaps: [.data.forecast.overlaps[] | {agentName, strength, files}], hints}'
(cd atlas && G atlas status --json >/dev/null)

say "act 2c — all four submit concurrently"
S0=$(seq_now)
(cd atlas && G atlas submit -m "Add 8% sales tax to invoice totals" --tool-calls 14 --cost 0.42 --json >../atlas.sub.json) &
(cd birch && G birch submit -m "Add currency() formatter" --tool-calls 6 --cost 0.08 --json >../birch.sub.json) &
(cd cedar && G cedar submit -m "Add 10% volume discount" --tool-calls 9 --cost 0.03 --json >../cedar.sub.json) &
(cd dune && G dune submit -m "Shorten session TTL to one hour" --tool-calls 4 --cost 0.05 --json >../dune.sub.json) &
wait
for a in atlas birch cedar dune; do printf '  %-6s %s status=%-12s risk=%s\n' "$a" "$(J '.data.changeset.id' <"$a.sub.json")" "$(J '.data.changeset.status' <"$a.sub.json")" "$(J '.data.changeset.riskScore' <"$a.sub.json")"; done
cs() { J '.data.changeset.id' <"$1.sub.json"; }

say "act 3 — the queue: Workflow → Container (merge-tree chain, check on merged tree, bisect) → CLEF judge → one push"
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S0" queue.batch_landed 600 --print \
  | jq -rc 'select(.type | test("batch_started|judged|landed|rejected|needs_review")) | "  \(.type) \(.data.csId // .data.batchId) \(.data.agentName // "") \(if .data.reason then "reason=" + .data.reason else "" end) \(if .data.wqs != null then "WQS=" + (.data.wqs|tostring) else "" end) \(if .data.intentAlignment != null then "intent=" + (.data.intentAlignment|tostring) else "" end) \(if .data.checksRun != null then "checks=" + (.data.checksRun|tostring) + " bisect=" + (.data.bisectSteps|tostring) else "" end)"'
echo "  why was cedar rejected?"
A show "$(cs cedar)" --json | jq -c '.data.rejection | {reason, files, conflictsWith: [.conflictsWith[] | {changesetId, agentName, files}]}'
echo "  why was birch rejected? (merged-tree check log, from R2)"
A logs "$(cs birch)" --json | jq -r '.data.log' | grep -E "not ok|expected|actual" | head -3 || true

say "act 4 — a human approves dune's sensitive change; cedar's conflict goes to a Conflict Room; birch fixes its bug"
S1=$(seq_now)
A approve "$(cs dune)" --by mike --json | jq -c '{id: .data.id, status: .data.status, approvedBy: .data.approvedBy}'
# Poll a changeset until it is landed/rejected/reverted (the queue may land fixes in separate batches).
await_cs() { local id="$1" st=""; for _ in $(seq 1 150); do st=$(A show "$id" --json | J '.data.status'); case "$st" in landed|rejected|reverted) echo "$st"; return 0;; esac; sleep 4; done; echo "timeout:$st"; return 1; }
( cd birch
  perl -pi -e 's|\QpadStart(width, " ")\E|padStart(width, "0")|' src/util/format.js
  G birch submit -m "Add currency() formatter" --json >../birch.sub2.json ) &
( cd cedar
  room=$(A room list --json | jq -r --arg cs "$(J '.data.changeset.id' <../cedar.sub.json)" '[.data[] | select(.csId == $cs)][0].id // empty')
  if [ -n "$room" ]; then
    echo "  Conflict Room $room: Workers AI proposes a resolution; the merge-runner merges it on current trunk and runs the check"
    node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S0" room.verified,room.failed 900 >/dev/null || true
    A room show "$room" --json | jq -c '{room: .data.id, status: .data.status, attempts: [.data.attempts[] | {n, files, checkPassed, rationale}]}'
  fi
  if [ -n "$room" ] && [ "$(A room show "$room" --json | J '.data.status')" = "verified" ]; then
    G cedar room accept "$room" --json >../cedar.sub2.json
    jq -c '{path: "room", resubmitted: .data.changeset.id, resolves: .data.changeset.resolves, local: .data.local}' <../cedar.sub2.json
  else
    echo "  room did not verify — cedar resolves by hand (weft sync)"
    set +e; G cedar sync --json >../cedar.sync.json; set -e
    echo "  cedar sync: $(J '.error.code' <../cedar.sync.json) files=$(J '.error.details.conflicts.files | join(",")' <../cedar.sync.json) peer=$(J '.error.details.conflicts.peers[0].changesetId' <../cedar.sync.json) ($(J '.error.details.conflicts.peers[0].agentName' <../cedar.sync.json))"
    cat >src/billing/invoice.js <<'EOF'
export function discount(subtotal) {
  return subtotal >= 100 ? subtotal * 0.1 : 0;
}

export function total(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Math.round((subtotal - discount(subtotal)) * 1.08 * 100) / 100;
}
EOF
    perl -pi -e 's|\Q), 180);\E|), 194.4);|' test/discount.test.js
    G cedar sync --continue --json | jq -c '{action: .data.action}'
    G cedar submit -m "Add 10% volume discount (applied before tax)" --resolves "$(J '.data.changeset.id' <../cedar.sub.json)" --json >../cedar.sub2.json
  fi )
wait
for x in "dune:$(cs dune)" "birch:$(J '.data.changeset.id' <birch.sub2.json)" "cedar:$(J '.data.changeset.id' <cedar.sub2.json)"; do
  printf '  %-6s %-8s %s\n' "${x%%:*}" "${x##*:}" "$(await_cs "${x##*:}")"
done
node "$ROOT/scripts/wait-events.mjs" "$WEFT_REPO" "$S1" queue.batch_landed 60 --print \
  | jq -rc 'select(.type | test("judged|landed|rejected|room\\.")) | "  \(.type) \(.data.csId // .data.roomId // .data.batchId) \(.data.agentName // "") \(if .data.wqs != null then "WQS=" + (.data.wqs|tostring) else "" end) \(if .data.checksRun != null then "checks=" + (.data.checksRun|tostring) else "" end)"'

say "act 5 — trunk carries server-written provenance; CHANGELOG merged with zero conflicts"
A log -n 5 --json | jq -rc '.data[] | "  \(.commit[0:10]) \(.subject) | \(.changeset // "-") \(.model // "") risk=\(.risk // "-")"'
(cd cedar && git -c "http.extraHeader=Authorization: Bearer $(jq -r .trunk.token .git/weft.json)" fetch -q trunk main && git show FETCH_HEAD:CHANGELOG.md)
echo "  quality leaderboard (WQS rubric):"
A leaderboard --json | jq -rc '.data.byAgent[] | "  \(.key)\tWQS=\(.meanWqs)\tlanded=\(.landed)/\(.submitted)\tfirstTry=\(.firstTryRate)%"'

say "act 5b — blast radius: revert dune's auth change with one command"
A revert "$(cs dune)" --by mike --json | jq -c '.data'
echo
echo "demo repo: $WEFT_REPO · live UI: $WEFT_REMOTE/#$WEFT_REPO · work dir: $WORK"
