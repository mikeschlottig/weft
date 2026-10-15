#!/usr/bin/env bash
# Try Weft on a GitHub repository of your choice (contest evaluators).
#
#   export WEFT_TOKEN=<evaluator token from the submission form>
#   bash scripts/try-your-repo_V-0.01.sh https://github.com/owner/repo [--check 'CMD'] [--agents N] [--branch B]
#
# Imports the repo into Weft as eval-<name>-<id> (an Artifacts trunk), sets the check that guards trunk,
# registers N agents (default 3, 24 h tokens) and prints how to point any coding agent at it — via the
# weft CLI or MCP. Watch it live in Mission Control (no account needed).
# Evaluator tokens only reach eval-* repos and agents; see src/core/evaluator.ts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/cli/weft.ts"
export WEFT_REMOTE="${WEFT_REMOTE:-https://weft.ceo-a53.workers.dev}"
die() { printf 'try-your-repo: %s\n' "$*" >&2; exit 1; }

URL="${1:-}"; shift || true
CHECK=""; AGENTS=3; BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK="${2:?--check needs a command}"; shift 2 ;;
    --agents) AGENTS="${2:?--agents needs a number}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?$ ]] || die "usage: $0 https://github.com/owner/repo [--check CMD] [--agents N] [--branch B]"
[ -n "${WEFT_TOKEN:-}" ] || die "set WEFT_TOKEN to your evaluator token"
[[ "$AGENTS" =~ ^[1-9]$ ]] || die "--agents must be 1-9"
for t in node git jq; do command -v "$t" >/dev/null || die "$t is required"; done

# Names: eval-<repo slug>-<4 hex>; agents eval-<short slug>-a<k> (≤ 31 chars).
NAME="$(basename "${URL%/}" .git | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
ID="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
REPO="eval-$(printf %s "$NAME" | cut -c1-40)-$ID"
SHORT="$(printf %s "$NAME" | cut -c1-14 | sed 's/-$//')"
WORK="$(mktemp -d -t weft-try)"; chmod 700 "$WORK"

# Pick a check from what the repo contains, unless one was given (shallow clone, local only).
if [ -z "$CHECK" ]; then
  git clone -q --depth 1 ${BRANCH:+--branch "$BRANCH"} "$URL" "$WORK/probe" || die "could not clone $URL"
  if [ -f "$WORK/probe/package.json" ] && jq -e '.scripts.test // empty | test("no test specified") | not' "$WORK/probe/package.json" >/dev/null 2>&1; then
    if [ -f "$WORK/probe/package-lock.json" ]; then CHECK="npm ci --no-audit --no-fund && npm test"; else CHECK="npm install --no-audit --no-fund && npm test"; fi
  elif [ -f "$WORK/probe/pyproject.toml" ] || [ -f "$WORK/probe/requirements.txt" ] || [ -f "$WORK/probe/setup.py" ]; then
    REQ=""; [ -f "$WORK/probe/requirements.txt" ] && REQ="-r requirements.txt"
    INST=""; { [ -f "$WORK/probe/pyproject.toml" ] || [ -f "$WORK/probe/setup.py" ]; } && INST="-e ."
    CHECK="python3 -m venv /tmp/weft-venv && /tmp/weft-venv/bin/pip install -q pytest $REQ $INST && /tmp/weft-venv/bin/python -m pytest -q"
  fi
  rm -rf "$WORK/probe"
fi

printf '\n== importing %s as %s\n' "$URL" "$REPO"
INIT=(init "$REPO" --import "$URL" --json)
[ -n "$BRANCH" ] && INIT+=(--branch "$BRANCH")
[ -n "$CHECK" ] && INIT+=(--check "$CHECK")
node "$CLI" "${INIT[@]}" >"$WORK/init.json" || { jq -c '.error // .' "$WORK/init.json" >&2 2>/dev/null; die "import failed"; }
jq -c '{repo: .data.repo, imported: .data.imported, check: .data.config.checkCommand}' "$WORK/init.json"
[ -n "$CHECK" ] || printf '   no test command detected: Weft still coordinates, but cannot test merged results.\n   set one later:  WEFT_TOKEN=… node cli/weft.ts config --repo %s --check "CMD"\n' "$REPO"

printf '\n== registering %s agents (24 h tokens, saved with mode 600 in %s)\n' "$AGENTS" "$WORK"
for k in $(seq 1 "$AGENTS"); do
  A="eval-$SHORT-a$k"
  node "$CLI" agent register --name "$A" --model "your-coding-agent" --ttl-hours 24 --long-lived --json >"$WORK/$A.json" || { jq -c '.error' "$WORK/$A.json" >&2; die "could not register $A"; }
  jq -r '.data.token' "$WORK/$A.json" >"$WORK/$A.tok"; chmod 600 "$WORK/$A.tok"; rm -f "$WORK/$A.json"
  printf '   %s  token: %s/%s.tok\n' "$A" "$WORK" "$A"
done

cat <<EOF

== ready
Watch live (no account):  $WEFT_REMOTE/#$REPO

Give each coding agent (Claude Code, Codex, Cursor, a script…) its own token and a task. With the CLI:

  export WEFT_REMOTE=$WEFT_REMOTE WEFT_REPO=$REPO
  export WEFT_TOKEN=\$(cat $WORK/eval-$SHORT-a1.tok)
  node $CLI start --task "<what this agent will do>" --touch '<files or globs, e.g. src/**>' --dir work-a1 && cd work-a1
  # … the agent edits files; plain git commit + git push are heartbeats …
  node $CLI status                      # overlaps with other agents, before anyone submits
  node $CLI submit -m "<commit message>"
  node $CLI show <changeset-id>         # WQS scorecard, CLEF judge, provenance
  node $CLI room list                   # if a conflict was rejected: a test-verified resolution
  node $CLI room accept <room-id>

A change held for review (for example when the two judges disagree) waits for you, with your evaluator token:
  WEFT_TOKEN=<evaluator token> node $CLI approve <changeset-id> --repo $REPO

Or over MCP: point the agent's MCP client at $WEFT_REMOTE/mcp with header
  Authorization: Bearer <that agent's token>
(tools include weft_start, weft_heartbeat, weft_submit, weft_show, weft_rooms, weft_room_accept, weft_context).

Run two or three agents at once on overlapping files to see collision forecasts, the merge queue,
bisection and a Conflict Room. Limits: eval-* repos only, 25 repos / 75 agents in total, tokens expire.
EOF
