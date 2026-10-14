# Weft

**Coordination-first version control for many agents working on one codebase at once, built on Cloudflare.**

Git records history. Agents need coordination: intent before edits, a single writer, and checks
on the merged result. Weft adds that layer on top of **Cloudflare Artifacts**, and every
repository stays plain git that any client can clone.

> Agents declare intent, the coordinator serializes, and the queue judges the merged tree.

Live: **https://weft.ceo-a53.workers.dev** (Mission Control). A finished five-agent run to open:
**https://weft.ceo-a53.workers.dev/#shop-10141259** (no account needed; reads are public).

## What it does

| Problem with git + agents | Weft's mechanism | Cloudflare primitive |
|---|---|---|
| Collisions surface at merge time, after the work is done | **Intent Ledger**: agents declare scope before editing; overlap forecasts and live alerts; soft and exclusive leases with TTLs | Durable Object per repo (SQLite, alarms, hibernating WebSockets) |
| Many writers race on `main` | **Changesets, not branches**: every workspace is an Artifacts fork with a fork-scoped token; agents never write trunk | Artifacts `fork()` + `createToken()` |
| Green branches produce a red trunk | **Speculative Weave queue**: batch, merge in memory (`git merge-tree`), check the merged tip once, bisect on red, land with a compare-and-swap push | Workflows + Containers (real git) |
| Hot files (changelogs, `package.json`, allow-lists) always conflict | **Merge-driver registry v2**: `union`, `json-merge` (3-way by key), `sorted-lines` | merge-runner `.gitattributes` + registered drivers |
| A conflict stops an agent cold | **Conflict Rooms**: Workers AI proposes a resolution, the merge-runner builds it on current trunk and runs the check; only a **green** proposal is offered (`weft room accept`) | RoomResolver Workflow + Workers AI: Gemma 4 `gemma-4-26b-a4b-it` writes the resolution (`kimi-k2.7-code` selectable), CLEF-flash pre-screens it for both intents + Container |
| Two agents in one file are flagged as colliding even in different functions | **Symbol-level intents**: tree-sitter (TS/JS/Python) reports the declarations each agent changed; same file + different symbols = no alert | CLI-side tree-sitter; DO forecast |
| Collisions are only seen when an agent asks | **Push-derived heartbeats**: a plain `git push` to a fork triggers a forecast and live alerts within seconds | Artifacts `cf.artifacts.repo.pushed` Workflow trigger |
| A crashed or new agent session loses its context | **Context packs + resume**: a token-budgeted, prompt-ready pack (peers, rejections + advice, recent landings, house rules); `weft resume` re-acquires an expired workspace, even on another machine | DO event log + Artifacts forks |
| Codemods (renames) break code that landed meanwhile | **Recipe changesets**: an admin-defined codemod is replayed on the newest trunk instead of merging text | merge-runner |
| Dependent work waits for review | **Stacked changesets** (`--after cs-x`): the child forks the parent's fork and lands right after it | Artifacts fork-of-fork |
| Forgeable attribution | Server-written trailers on every trunk commit (`Weft-Agent`, `Weft-Model`, `Weft-Task`, `Weft-Risk`, …), **SSH-signed** trunk commits, and a **provenance bundle** (prompt hash, tool calls, cost, risk, judge) linked by `refs/notes/weft` | Only the queue writes trunk; R2 |
| No signal for agents to improve against | **WQS-1 quality rubric**: deterministic gates + the **Cloudflare CLEF** decision-model judge, with **Gemma 4** as an independent second opinion (disagreement holds for a human) + process; scores go back to the agent and are ranked by agent and by model | Workers AI (`@cf/cloudflare/clef`, `@cf/google/gemma-4-26b-a4b-it`), D1 |
| Humans can't review everything | Risk-routed review: sensitive paths and judge holds go to a human, the rest auto-lands on green | Policy in the coordinator |
| Trying it needs a migration | **GitHub import**: `weft init shop --import https://github.com/owner/repo` | Artifacts `import()` |
| Teams still live on GitHub | **Mirror-out**: after every landing, trunk + provenance notes are pushed to a mirror (`weft mirror set`), credential sealed | merge-runner + KV (AES-GCM sealed) |
| Throughput stalls behind one merge | **Parallel lanes**: disjoint batches validate at the same time, each on its **own** merge-runner instance; trunk stays single-writer by CAS push + read-back | One Container instance per lane |
| A flaky test blames an innocent agent | **Flake guard**: a red tip (and a red trunk) is re-run before anyone is blamed; non-deterministic checks are reported as infra, never as the agent's fault | merge-runner |
| An agent can under-report its diff to dodge review | **Authoritative re-scoring**: risk is recomputed from the runner's own diff; hidden files or under-counted lines hold the change for a human | Coordinator + Container |
| Long-lived agent credentials | **EdDSA agent tokens** (1 h, `weft agent refresh`), public JWKS, weekly key rotation with overlap; humans via **Cloudflare Access** roles | D1 key store, Cron Trigger, `ctx.access` |
| Agents need somewhere to run code | **Sandbox per workspace**: `weft start --sandbox` clones the fork into a container the workspace owns; `weft exec`, `weft submit` from there | Durable Object container API (Sandbox SDK 1.0 model) |
| One namespace's rate limit caps the platform | **Namespace sharding** + a **Limits** dashboard of measured usage against documented limits | Multiple Artifacts namespaces |

## Architecture

```
agent (weft CLI / MCP) ──► weft Worker ──► RepoCoordinator DO (1 per repo: intents, leases, queue, rooms, events)
        │                                        │ fork() · createToken()            │ create batch / open room
        └── git push to OWN fork ──► Artifacts ◄─┘                                    ▼
              │ cf.artifacts.repo.pushed ▲                         MergeQueue Workflow
              ▼                          │  push trunk (lease,      prepare → judge (Workers AI CLEF) → provenance (R2)
        PushObserver Workflow            │  signed, + notes)        → speculate · check · bisect · recipes · drivers
        (heartbeat + alerts)             └────── merge-runner ◄──── → push → verify → land
                                                 Container (git 2.47)  ▲
                                                                       │ build + check candidate
                                         RoomResolver Workflow ────────┘ (Workers AI proposes, only green is offered)
```

Code map: `src/worker/coordinator.ts` (decisions), `src/worker/merge-queue.ts` (Workflow),
`src/worker/room-resolver.ts` (Conflict Rooms), `src/worker/push-observer.ts` (push heartbeats),
`container/server.ts` (the only trunk writer: merges, checks, recipes, drivers, signing), `src/core/rubric.ts` (WQS-1),
`src/core/symbols.ts` + `cli/symbols.ts` (tree-sitter symbol intents), `cli/weft.ts` (agent CLI),
`src/worker/mcp.ts` (MCP tools), `src/worker/keystore.ts` + `src/core/keys.ts` (EdDSA keys, JWKS, Access roles),
`src/worker/mirror.ts` (mirror-out), `src/worker/sandbox.ts` (sandbox per workspace), `src/core/limits.ts` (limits),
`web/index.html` (Mission Control: Swarm, Queue, Changesets, Agents, Conflicts, Quality, Limits, Events).

## Run it

Requirements: Node ≥ 23.6, git ≥ 2.38, jq. A Cloudflare account on **Workers Paid** (Artifacts and
Containers), and Docker with buildx for deploys.

```bash
npm install
npm run typecheck && npm test            # strict TS; 64 tests incl. the real merge-runner against local git
npx wrangler d1 create weft-index        # put the ids below in wrangler.jsonc
npx wrangler r2 bucket create weft-blobs
npx wrangler kv namespace create weft-config
npx wrangler queues create weft-jobs && npx wrangler queues create weft-artifacts-events
npx wrangler d1 migrations apply weft-index --remote   # 0001–0004 (keys, token grants, shards)
printf %s "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
printf %s "$JWT_SECRET"  | npx wrangler secret put JWT_SIGNING_SECRET
ssh-keygen -t ed25519 -N "" -C queue@weft.dev -f weft-signing && npx wrangler secret put WEFT_SIGNING_KEY < weft-signing
# set vars.WEFT_SIGNING_PUBKEY to the contents of weft-signing.pub (optional: unsigned without it)
npx wrangler deploy                       # (`--env dev` deploys the separate weft-dev stack)
```

Use the CLI against your deployment:

```bash
export WEFT_REMOTE=https://<your-worker>.workers.dev
WEFT_TOKEN=$ADMIN_TOKEN node cli/weft.ts init shop --from examples/shop --check 'node --test test/*.test.js' --sensitive 'src/auth/**'
#   or bring your own repo:  init shop --import https://github.com/owner/repo
WEFT_TOKEN=$ADMIN_TOKEN node cli/weft.ts agent register --name atlas --model claude-opus-5-5   # prints an agent token
export WEFT_TOKEN=<agent token> WEFT_REPO=shop
node cli/weft.ts start --task "add sales tax" --touch 'src/billing/**' --dir atlas && cd atlas
node ../cli/weft.ts context --md  # prompt-ready context pack: peers, rules, what landed in your scope
# … edit …
node ../cli/weft.ts status        # heartbeat: touched files + symbols, overlaps with other agents, drift
node ../cli/weft.ts submit -m "Add 8% sales tax"
node ../cli/weft.ts show cs-0005  # scorecard, provenance, improvement advice
node ../cli/weft.ts room list     # if it was rejected for a conflict: a check-verified AI resolution
node ../cli/weft.ts room accept r-0007
node ../cli/weft.ts resume ws-0004-atlas --dir atlas2   # pick a workspace back up on another machine
```

Verify trunk yourself:

```bash
curl -s $WEFT_REMOTE/v1/signing-key | jq -r .data.allowedSigners > allowed_signers
git -c gpg.ssh.allowedSignersFile=allowed_signers verify-commit <sha>      # Good "git" signature for queue@weft.dev
git fetch trunk 'refs/notes/weft:refs/notes/weft' && git notes --ref=weft show <sha>   # provenance bundle pointer
```

The full five-agent demo, run against production:

```bash
WEFT_ADMIN_TOKEN=… bash scripts/demo-live_V-0.01.sh
```

It shows concurrent starts, a refused exclusive lease, a collision flagged before submit, one batch
that lands one change, rejects one for conflict (naming the peer) and one for a broken test
(found by bisection), human review, an **AI Conflict Room** whose resolution passes the check and
lands, zero CHANGELOG conflicts, the quality leaderboard and a one-command revert.

Feature acceptance scripts (each runs against a live deployment and exits non-zero on failure):
`live-symbols`, `live-stacks`, `live-recipes-drivers`, `live-push-heartbeat`, `live-context-resume`,
`live-provenance`, `live-import`, `live-lanes` (V-0.02: proves lanes overlap in time), `live-flake-rescore`,
`live-auth-keys`, `live-mirror`, `live-sandbox`, `live-shards-limits` (all in `scripts/`), plus `loadtest_V-0.01.mjs`
and `swarm_V-0.01.mjs` (N real CLI agents; measures collision catch rate, resolver green rate and trunk red rate).

MCP: point any MCP client at `https://<worker>/mcp` with `Authorization: Bearer <agent token>`.
The tools are `weft_start`, `weft_heartbeat`, `weft_submit`, `weft_show`, `weft_who`, `weft_queue`,
`weft_context`, `weft_resume`, `weft_rooms`, `weft_room_show`, `weft_room_accept`, `weft_sandbox_open`, `weft_exec`,
`weft_limits` and `weft_leaderboard`. Agent tokens are EdDSA JWTs; verify them against `/.well-known/jwks.json`.

## Try it on your own repository (contest evaluators)

Judges get an **evaluator token** (in the submission form). It works against the production deployment, so
nothing needs deploying:

```bash
git clone https://github.com/mikeschlottig/weft && cd weft && npm install
export WEFT_TOKEN=<evaluator token>
bash scripts/try-your-repo_V-0.01.sh https://github.com/owner/repo            # any public GitHub repo
#   options: --check 'npm test' | --agents 3 | --branch main
```

It imports the repo as `eval-<name>-<id>`, detects a check (npm or pytest; pass `--check` to choose), registers
agents with 24 h tokens, and prints how to point any coding agent (Claude Code, Codex, a script…) at it over the
`weft` CLI or MCP, plus the live Mission Control link. Run two or three agents at once on overlapping files to
see collision forecasts, the merge queue, bisection and a Conflict Room. A change the judges hold (for example
when CLEF and Gemma disagree) waits for you: `weft approve <cs>`.

Scope, by design (`src/core/evaluator.ts`): evaluator tokens reach only `eval-*` repositories and the agents they
register only work there; 10 repos and 30 agents in total; tokens expire 2026-10-23; no key, kill-switch,
budget or mirror operations; an operator can switch all evaluator access off instantly. The merge-runner has
Node and Python 3; other toolchains need a check that installs them.

## The agent contract

One JSON envelope per call (`{"ok":true,"command","data","hints"}` or `{"ok":false,"error":{code,message,retryable,hint,details}}`).
JSON is printed automatically when stdout is not a TTY. Exit codes: `0` ok · `2` usage · `3` conflict ·
`4` lease held · `5` check failed · `6` not found · `7` busy (retry) · `8` bad state. Nothing is interactive.

## Honest limits

- Artifacts is in open beta. Repos are capped at 1 GB and files at 32 MB. We saw concurrent forks of
  one trunk occasionally report success and never exist; Weft serializes forks per trunk and re-forks.
- Humans: Cloudflare Access roles are built (`ctx.access`, roles in KV `access/roles`) but Access must be
  switched on for the Worker in the dashboard; until then the admin token is the human credential. Read
  endpoints are public on the demo deployments (`PUBLIC_READ=true`) so judges need no account.
- Rubric thresholds are not calibrated yet. Calibration needs labeled outcomes (reverted, hotfixed,
  human-rejected), which Weft records; precision targets need ≥ 150 real labels.
- Everything in the table above runs in production (promoted 2026-10-14, gated by live demo, lanes, sandbox and
  duplicate-detection runs). The 500- and 150-agent swarm runs were done on the separate `weft-dev` stack.
- Load test (single repo coordinator): 3,000 req/min → p95 260 ms; 6,000 req/min → p95 384 ms; zero 5xx.
- Symbol intents cover TS/JS/Python; other languages fall back to whole-file overlap. Conflict Room
  proposals come from a model: only proposals that pass the repo's check are offered, and the agent
  decides whether to accept.

## License

Apache-2.0. See [LICENSE](LICENSE).
