# Weft

**Coordination-first version control for many agents working on one codebase at once, built on Cloudflare.**

Git records history. Agents need coordination: intent before edits, a single writer, and checks
on the merged result. Weft adds that layer on top of **Cloudflare Artifacts**, and every
repository stays plain git that any client can clone.

> Agents declare intent, the coordinator serializes, and the queue judges the merged tree.

Live: **https://weft.ceo-a53.workers.dev** (Mission Control; open a repo such as `#shop-live1`).

## What it does

| Problem with git + agents | Weft's mechanism | Cloudflare primitive |
|---|---|---|
| Collisions surface at merge time, after the work is done | **Intent Ledger**: agents declare scope before editing; overlap forecasts and live alerts; soft and exclusive leases with TTLs | Durable Object per repo (SQLite, alarms, hibernating WebSockets) |
| Many writers race on `main` | **Changesets, not branches**: every workspace is an Artifacts fork with a fork-scoped token; agents never write trunk | Artifacts `fork()` + `createToken()` |
| Green branches produce a red trunk | **Speculative Weave queue**: batch, merge in memory (`git merge-tree`), check the merged tip once, bisect on red, land with a compare-and-swap push | Workflows + Containers (real git) |
| Hot files (changelogs) always conflict | Merge-driver registry (union) | merge-runner `.gitattributes` |
| Forgeable attribution | Server-written trailers on every trunk commit (`Weft-Agent`, `Weft-Model`, `Weft-Task`, `Weft-Risk`, …) | Only the queue writes trunk |
| No signal for agents to improve against | **WQS-1 quality rubric**: deterministic gates + the **Cloudflare CLEF** decision-model judge + process; scores go back to the agent and are ranked by agent and by model | Workers AI (`@cf/cloudflare/clef`), D1 |
| Humans can't review everything | Risk-routed review: sensitive paths and judge holds go to a human, the rest auto-lands on green | Policy in the coordinator |

## Architecture

```
agent (weft CLI / MCP) ──► weft Worker ──► RepoCoordinator DO (1 per repo: intents, leases, queue, events)
        │                                        │ fork() · createToken()            │ create batch
        └── git push to OWN fork ──► Artifacts ◄─┘                                    ▼
                                         ▲                         MergeQueue Workflow
                                         │  push trunk (lease)     prepare → judge (Workers AI CLEF)
                                         └────── merge-runner ◄──── speculate · check · bisect → push → verify → land
                                                 Container (git 2.47)
```

Code map: `src/worker/coordinator.ts` (decisions), `src/worker/merge-queue.ts` (Workflow),
`container/server.ts` (the only trunk writer), `src/core/rubric.ts` (WQS-1), `cli/weft.ts` (agent CLI),
`src/worker/mcp.ts` (MCP tools), `web/index.html` (Mission Control).

## Run it

Requirements: Node ≥ 23.6, git ≥ 2.38, jq. A Cloudflare account on **Workers Paid** (Artifacts and
Containers), and Docker with buildx for deploys.

```bash
npm install
npm run typecheck && npm test            # strict TS (worker + node configs), 9 core unit tests
npx wrangler d1 create weft-index        # put the id in wrangler.jsonc
npx wrangler r2 bucket create weft-blobs
npx wrangler queues create weft-jobs
npx wrangler d1 migrations apply weft-index --remote
printf %s "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
printf %s "$JWT_SECRET"  | npx wrangler secret put JWT_SIGNING_SECRET
npx wrangler deploy
```

Use the CLI against your deployment:

```bash
export WEFT_REMOTE=https://<your-worker>.workers.dev
WEFT_TOKEN=$ADMIN_TOKEN node cli/weft.ts init shop --from examples/shop --check 'node --test test/*.test.js' --sensitive 'src/auth/**'
WEFT_TOKEN=$ADMIN_TOKEN node cli/weft.ts agent register --name atlas --model claude-opus-5-5   # prints an agent token
export WEFT_TOKEN=<agent token> WEFT_REPO=shop
node cli/weft.ts start --task "add sales tax" --touch 'src/billing/**' --dir atlas && cd atlas
# … edit …
node ../cli/weft.ts status        # heartbeat: touched files, overlaps with other agents, drift
node ../cli/weft.ts submit -m "Add 8% sales tax"
node ../cli/weft.ts show cs-0005  # scorecard, provenance, improvement advice
```

The full five-agent demo, run against production:

```bash
WEFT_ADMIN_TOKEN=… bash scripts/demo-live_V-0.01.sh
```

It shows concurrent starts, a refused exclusive lease, a collision flagged before submit, one batch
that lands one change, rejects one for conflict (naming the peer) and one for a broken test
(found by bisection), human review, conflict resolution, zero CHANGELOG conflicts, the quality
leaderboard and a one-command revert.

MCP: point any MCP client at `https://<worker>/mcp` with `Authorization: Bearer <agent token>`.
The tools are `weft_start`, `weft_heartbeat`, `weft_submit`, `weft_show`, `weft_who`, `weft_queue`
and `weft_leaderboard`.

## The agent contract

One JSON envelope per call (`{"ok":true,"command","data","hints"}` or `{"ok":false,"error":{code,message,retryable,hint,details}}`).
JSON is printed automatically when stdout is not a TTY. Exit codes: `0` ok · `2` usage · `3` conflict ·
`4` lease held · `5` check failed · `6` not found · `7` busy (retry) · `8` bad state. Nothing is interactive.

## Honest limits

- Artifacts is in open beta. Repos are capped at 1 GB and files at 32 MB.
- Heartbeats are reported by the CLI. Deriving them from push events needs one subscription per fork
  (planned).
- Humans authenticate with an admin token in this build (Cloudflare Access is planned). Read
  endpoints are public on this demo deployment (`PUBLIC_READ=true`).
- Rubric thresholds are not calibrated yet. Calibration needs labeled outcomes (reverted, hotfixed,
  human-rejected), which Weft is now recording.
- Latency figures have not been measured under load yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
