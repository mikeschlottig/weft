// weft-api Worker: the single public entry point (spec §6). Routes decisions to the repo's
// RepoCoordinator DO; git data never flows through here (agents talk to Artifacts directly).

import { WeftError, decodeFromRpc, forbidden, invalidState as invalidStateErr, usage } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";
import { type ContextPack, contextMarkdown } from "../core/context.ts";
import { DUPLICATE_THRESHOLD, EMBED_MODEL, cosine } from "../core/similarity.ts";
import { BAD_OUTCOMES, type LabeledRow, calibrate } from "../core/calibration.ts";
import { jwks, tokenTtl } from "../core/keys.ts";
import { DOCUMENTED } from "../core/limits.ts";
import type { AgentClaims, Envelope, ErrorEnvelope, IntentMode, RepoConfig } from "../core/types.ts";
import { pickShard, repoInfo, resolveShard, shardCount, trunkLog } from "./artifacts.ts";
import { getMirror, pushMirror, removeMirror, setMirror } from "./mirror.ts";
import { authenticate, optionalAuth, requireAdmin, requireReviewer } from "./auth.ts";
import { keyStatus, mintAgentToken, mintEvaluatorToken, publicKeys, rotateIfDue, rotateKeys } from "./keystore.ts";
import { EVAL_KILL_KEY, EVAL_MAX_AGENTS, EVAL_MAX_REPOS, evalAgentMay, evalExpiry, evaluatorMay, filterEvalConfig, isEvalName, isGithubHttps } from "../core/evaluator.ts";
import { handleMcp } from "./mcp.ts";

export { RepoCoordinator } from "./coordinator.ts";
export { MergeQueue } from "./merge-queue.ts";
export { RoomResolver } from "./room-resolver.ts";
export { PushObserver } from "./push-observer.ts";
export { MergeRunner } from "./runner-client.ts";
export { WorkspaceSandbox } from "./sandbox.ts";
import type { ExecResult } from "./sandbox.ts";

type Handler = (ctx: Ctx) => Promise<{ data: unknown; hints?: string[] }>;
interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  params: Record<string, string>;
  url: URL;
  claims: AgentClaims | null;
  body: () => Promise<Record<string, unknown>>;
}

type Auth = "public" | "read" | "agent" | "review" | "admin";
const routes: { method: string; pattern: RegExp; keys: string[]; command: string; auth: Auth; fn: Handler }[] = [];
const route = (method: string, path: string, command: string, auth: Auth, fn: Handler): void => {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/\./g, "\\.").replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
    keys.push(k);
    return "([^/]+)";
  })}$`);
  routes.push({ method, pattern, keys, command, auth, fn });
};

const coord = (env: Env, repo: string) => env.REPO.getByName(repo);

// ---- FR-40: budgets + kill switch (D1: consistent on every request)
interface Budget {
  changesetsPerDay?: number | null;
  costUsdPerDay?: number | null;
  openWorkspacesPerRepo?: number | null;
}
const today = (): string => new Date().toISOString().slice(0, 10);
const agentRow = (env: Env, id: string) =>
  env.DB.prepare("SELECT id, name, model, budget_json, killed_at, killed_by FROM agents WHERE id = ?").bind(id).first<{ id: string; name: string; model: string; budget_json: string | null; killed_at: number | null; killed_by: string | null }>();
const budgetOf = (row: { budget_json: string | null } | null): Budget => (row?.budget_json ? (JSON.parse(row.budget_json) as Budget) : {});

/** Refuse a killed agent on every request (the JWT alone is not enough once the kill switch is thrown). */
const gateAgent = async (env: Env, claims: AgentClaims | null): Promise<void> => {
  if (!claims || claims.role !== "agent") return;
  const row = await agentRow(env, claims.sub);
  if (row?.killed_at) throw new WeftError("FORBIDDEN", `agent ${claims.name} was disabled by ${row.killed_by ?? "an admin"}`, { hint: "ask an admin to run `weft agent revive`" });
};

/** Atomic check-and-increment of today's usage. Returns a compensation callback for a failed submit. */
const chargeSubmit = async (env: Env, claims: AgentClaims, costUsd: number): Promise<(() => Promise<void>) | null> => {
  const b = budgetOf(await agentRow(env, claims.sub));
  if (b.changesetsPerDay == null && b.costUsdPerDay == null) return null;
  const day = today();
  await env.DB.prepare("INSERT OR IGNORE INTO agent_usage (agent_id, day, changesets, cost_usd) VALUES (?, ?, 0, 0)").bind(claims.sub, day).run();
  const row = await env.DB.prepare(
    `UPDATE agent_usage SET changesets = changesets + 1, cost_usd = cost_usd + ?
       WHERE agent_id = ? AND day = ? AND changesets < ? AND cost_usd + ? <= ?
       RETURNING changesets, cost_usd`,
  )
    .bind(costUsd, claims.sub, day, b.changesetsPerDay ?? 1e9, costUsd, b.costUsdPerDay ?? 1e12)
    .first<{ changesets: number; cost_usd: number }>();
  if (!row) {
    const u = await env.DB.prepare("SELECT changesets, cost_usd FROM agent_usage WHERE agent_id = ? AND day = ?").bind(claims.sub, day).first<{ changesets: number; cost_usd: number }>();
    throw new WeftError("BUDGET_EXCEEDED", `budget exceeded for ${claims.name} today: ${u?.changesets ?? 0} changesets / $${(u?.cost_usd ?? 0).toFixed(2)} (limits ${b.changesetsPerDay ?? "∞"} / $${b.costUsdPerDay ?? "∞"})`, {
      exitCode: 7,
      hint: "wait until tomorrow (UTC) or ask an admin to raise the budget (weft agent budget)",
      details: { usage: u, budget: b },
    });
  }
  return async () => {
    await env.DB.prepare("UPDATE agent_usage SET changesets = MAX(0, changesets - 1), cost_usd = MAX(0, cost_usd - ?) WHERE agent_id = ? AND day = ?").bind(costUsd, claims.sub, day).run();
  };
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length === 0) throw usage(`missing ${name}`);
  return v;
};
const strs = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw usage(`${name} must be an array of strings`);
  return v as string[];
};
const numOr = (v: unknown, d: number | null): number | null => (typeof v === "number" && Number.isFinite(v) ? v : d);
const claimsOf = (c: Ctx): AgentClaims => {
  if (!c.claims) throw new WeftError("UNAUTHENTICATED", "missing bearer token");
  return c.claims;
};

const parseTrailers = (message: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = /^(Weft-[A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m && m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
};

// ------------------------------------------------------------ routes

route("GET", "/healthz", "health", "public", async () => ({ data: { ok: true, service: "weft", rubric: "wqs-1" } }));

// FR-33: the public key every trunk commit is signed with, in git's allowed-signers format.
route("GET", "/v1/signing-key", "signing-key", "public", async (c) => {
  const pub = (c.env as unknown as { WEFT_SIGNING_PUBKEY?: string }).WEFT_SIGNING_PUBKEY ?? null;
  if (!pub) throw new WeftError("NOT_FOUND", "this deployment does not sign commits");
  return {
    data: { format: "ssh", signer: "queue@weft.dev", publicKey: pub, allowedSigners: `queue@weft.dev namespaces="git" ${pub}` },
    hints: ["echo \"<allowedSigners>\" > allowed_signers && git -c gpg.ssh.allowedSignersFile=allowed_signers verify-commit <sha>"],
  };
});

// D6: the public verification keys for agent tokens (EdDSA, by kid).
route("GET", "/.well-known/jwks.json", "jwks", "public", async (c) => ({ data: jwks(await publicKeys(c.env)) }));

route("POST", "/v1/agents", "agent register", "admin", async (c) => {
  const b = await c.body();
  const name = str(b.name, "name");
  const model = str(b.model, "model");
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) throw usage(`invalid agent name: ${name}`, "lowercase letters, digits, - and _ (max 31)");
  if (claimsOf(c).role === "evaluator") {
    if (!isEvalName(name)) throw forbidden(`evaluator agents must be named eval-* (got ${name})`);
    const known = await c.env.DB.prepare("SELECT id FROM agents WHERE name = ?").bind(name).first<{ id: string }>();
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE name LIKE 'eval-%'").first<{ n: number }>();
    if (!known && (n?.n ?? 0) >= EVAL_MAX_AGENTS) throw new WeftError("BUDGET_EXCEEDED", `the evaluation cap of ${EVAL_MAX_AGENTS} eval-* agents is reached`, { exitCode: 7, hint: "reuse an existing eval-* agent name" });
  }
  // E8 (review H2): agent tokens live ≤ 1 h (spec §12). Longer is an explicit, recorded admin grant (≤ 24 h).
  const ttl = tokenTtl(numOr(b.ttlHours, null), b.longLived === true);
  const existing = await c.env.DB.prepare("SELECT id FROM agents WHERE name = ?").bind(name).first<{ id: string }>();
  const id = existing?.id ?? `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await c.env.DB.prepare("INSERT INTO agents (id, name, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET model = excluded.model")
    .bind(id, name, model, Date.now())
    .run();
  const minted = await mintAgentToken(c.env, { id, name, model }, ttl.ttlS, { by: claimsOf(c).name, via: "register", longLived: ttl.longLived });
  const hints = [`export WEFT_TOKEN=<token>  # as ${name}`, "weft agent refresh  # before it expires (tokens live 1 h)"];
  if (ttl.clamped) hints.unshift(`token lifetime capped at ${ttl.ttlS / 3600} h${b.longLived === true ? "" : " (pass --long-lived for an audited grant of up to 24 h)"}`);
  return { data: { agent: { id, name, model }, token: minted.token, expiresAt: minted.expiresAt, kid: minted.kid, ttlSeconds: ttl.ttlS, longLived: ttl.longLived }, hints };
});

// E8: an agent re-issues its own token before expiry (≤ 1 h). A killed agent is refused by gateAgent first.
route("POST", "/v1/agents/token/refresh", "agent refresh", "agent", async (c) => {
  const cl = claimsOf(c);
  if (cl.role !== "agent") throw usage("only agent tokens can be refreshed", "admins and Access users do not need tokens");
  const minted = await mintAgentToken(c.env, { id: cl.sub, name: cl.name, model: cl.model }, tokenTtl(null, false).ttlS, { by: cl.name, via: "refresh", longLived: false });
  return { data: { agent: { id: cl.sub, name: cl.name, model: cl.model }, token: minted.token, expiresAt: minted.expiresAt, kid: minted.kid }, hints: ["export WEFT_TOKEN=<token>"] };
});

route("GET", "/v1/admin/keys", "keys list", "admin", async (c) => ({ data: await keyStatus(c.env) }));
route("POST", "/v1/admin/keys/rotate", "keys rotate", "admin", async (c) => ({
  data: await rotateKeys(c.env, claimsOf(c).name),
  hints: ["tokens signed by the previous key keep working until they expire; the key before it is retired"],
}));

route("GET", "/v1/agents", "agent list", "admin", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, name, model, created_at FROM agents ORDER BY name").all();
  return { data: rows.results };
});

route("GET", "/v1/agents/:name", "agent show", "admin", async (c) => {
  const row = await c.env.DB.prepare("SELECT id, name, model, budget_json, killed_at, killed_by FROM agents WHERE name = ?").bind(c.params.name ?? "").first<{ id: string; name: string; model: string; budget_json: string | null; killed_at: number | null; killed_by: string | null }>();
  if (!row) throw new WeftError("NOT_FOUND", `agent not found: ${c.params.name ?? ""}`);
  const usage = await c.env.DB.prepare("SELECT changesets, cost_usd FROM agent_usage WHERE agent_id = ? AND day = ?").bind(row.id, today()).first();
  return { data: { id: row.id, name: row.name, model: row.model, budget: budgetOf(row), usageToday: usage ?? { changesets: 0, cost_usd: 0 }, killed: row.killed_at ? { at: new Date(row.killed_at).toISOString(), by: row.killed_by } : null } };
});

route("PATCH", "/v1/agents/:name/budget", "agent budget", "admin", async (c) => {
  const b = await c.body();
  const pick = (k: string): number | null => (typeof b[k] === "number" && Number.isFinite(b[k]) && (b[k] as number) >= 0 ? (b[k] as number) : null);
  const budget: Budget = { changesetsPerDay: pick("changesetsPerDay"), costUsdPerDay: pick("costUsdPerDay"), openWorkspacesPerRepo: pick("openWorkspacesPerRepo") };
  const r = await c.env.DB.prepare("UPDATE agents SET budget_json = ? WHERE name = ? RETURNING id").bind(JSON.stringify(budget), c.params.name ?? "").first<{ id: string }>();
  if (!r) throw new WeftError("NOT_FOUND", `agent not found: ${c.params.name ?? ""}`);
  return { data: { name: c.params.name, budget } };
});

route("POST", "/v1/agents/:name/kill", "agent kill", "admin", async (c) => {
  const started = Date.now();
  const body: Record<string, unknown> = await c.body().catch(() => ({}));
  const actor = String(body.by ?? claimsOf(c).name);
  const row = await c.env.DB.prepare("UPDATE agents SET killed_at = ?, killed_by = ? WHERE name = ? RETURNING id").bind(Date.now(), actor, c.params.name ?? "").first<{ id: string }>();
  if (!row) throw new WeftError("NOT_FOUND", `agent not found: ${c.params.name ?? ""}`);
  // Fan out to every repo coordinator in parallel: revoke fork tokens, abandon workspaces, reject queued work.
  const repos = (await c.env.DB.prepare("SELECT id FROM repos").all<{ id: string }>()).results;
  const settled = await Promise.allSettled(repos.map((r) => coord(c.env, r.id).killAgent(row.id, actor)));
  const per = settled.flatMap((s) => (s.status === "fulfilled" && s.value.workspaces > 0 ? [s.value] : []));
  return {
    data: { agent: c.params.name, agentId: row.id, ms: Date.now() - started, reposScanned: repos.length, affected: per, failures: settled.filter((s) => s.status === "rejected").length },
    hints: ["the agent's JWT is refused from now on; `weft agent revive` re-enables it"],
  };
});

route("POST", "/v1/agents/:name/revive", "agent revive", "admin", async (c) => {
  const r = await c.env.DB.prepare("UPDATE agents SET killed_at = NULL, killed_by = NULL WHERE name = ? RETURNING id").bind(c.params.name ?? "").first<{ id: string }>();
  if (!r) throw new WeftError("NOT_FOUND", `agent not found: ${c.params.name ?? ""}`);
  return { data: { agent: c.params.name, revived: true } };
});

route("GET", "/v1/leaderboard", "leaderboard", "read", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT agent_name AS agent, model, COUNT(*) AS submitted, SUM(status = 'landed') AS landed, SUM(status = 'rejected') AS rejected,
            SUM(outcome = 'reverted') AS reverted, ROUND(AVG(wqs), 1) AS meanWqs, ROUND(AVG(intent_alignment), 2) AS meanIntentAlignment
       FROM scorecards GROUP BY agent_name, model ORDER BY meanWqs DESC`,
  ).all();
  return { data: { rubric: "wqs-1", rows: rows.results } };
});

/** Recent repos with their landed and scored counts — Mission Control's starting point (public read). */
route("GET", "/v1/repos", "repo list", "read", async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.url.searchParams.get("limit") ?? "12") || 12));
  const rows = await c.env.DB.prepare(
    `SELECT r.id AS repo, r.created_at AS createdAt, COUNT(s.cs_id) AS scored, COALESCE(SUM(s.status = 'landed'), 0) AS landed, ROUND(AVG(s.wqs), 1) AS meanWqs
       FROM repos r LEFT JOIN scorecards s ON s.repo = r.id
      GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?`,
  ).bind(limit).all<{ repo: string; createdAt: number; scored: number; landed: number; meanWqs: number | null }>();
  return { data: rows.results.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })) };
});

route("POST", "/v1/repos", "init", "admin", async (c) => {
  const b = await c.body();
  const repo = str(b.repo, "repo");
  const imp = b.import && typeof b.import === "object" ? (b.import as Record<string, unknown>) : null;
  if (claimsOf(c).role === "evaluator") {
    if (!isEvalName(repo)) throw forbidden(`evaluator repositories must be named eval-* (got ${repo})`);
    if (imp && !isGithubHttps(String(imp.url ?? ""))) throw forbidden("evaluators can import public GitHub repositories over HTTPS (https://github.com/owner/repo)");
    const known = await c.env.DB.prepare("SELECT id FROM repos WHERE id = ?").bind(repo).first<{ id: string }>();
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM repos WHERE id LIKE 'eval-%'").first<{ n: number }>();
    if (!known && (n?.n ?? 0) >= EVAL_MAX_REPOS) throw new WeftError("BUDGET_EXCEEDED", `the evaluation cap of ${EVAL_MAX_REPOS} eval-* repositories is reached`, { exitCode: 7, hint: "reuse an existing eval-* repository" });
    b.config = filterEvalConfig((b.config ?? {}) as Record<string, unknown>).patch;
    delete b.shard;
  }
  // D7: place the repo (and all of its forks) on a namespace shard; recorded before any Artifacts call.
  const shards = shardCount(c.env);
  const shard = typeof b.shard === "number" && Number.isInteger(b.shard) && b.shard >= 0 && b.shard < shards ? b.shard : pickShard(repo, shards);
  const prior = await c.env.DB.prepare("SELECT shard FROM repos WHERE id = ?").bind(repo).first<{ shard: number }>();
  const placed = prior ? prior.shard : shard; // an existing (adopted) repo keeps its shard
  await c.env.DB.prepare("INSERT INTO repos (id, created_at, config, shard) VALUES (?, ?, '{}', ?) ON CONFLICT(id) DO NOTHING").bind(repo, Date.now(), placed).run();
  const data = await coord(c.env, repo).init({
    repo,
    config: (b.config ?? {}) as Partial<RepoConfig>,
    actor: claimsOf(c).name,
    import: imp ? { url: str(imp.url, "import.url"), ...(typeof imp.branch === "string" && imp.branch ? { branch: imp.branch } : {}) } : null,
    shard: placed,
  });
  return { data, hints: ["push an initial commit to the returned remote (the CLI does this with --from DIR)", "weft agent register --name <agent> --model <model>"] };
});

route("PATCH", "/v1/repos/:repo/config", "config", "admin", async (c) => {
  let patch = (await c.body()) as Record<string, unknown>;
  const hints: string[] = [];
  if (claimsOf(c).role === "evaluator") {
    const f = filterEvalConfig(patch);
    patch = f.patch;
    if (f.dropped.length) hints.push(`ignored for evaluator tokens (admin-only): ${f.dropped.join(", ")}`);
  }
  return { data: await coord(c.env, c.params.repo ?? "").configure(patch as Partial<RepoConfig>, claimsOf(c).name), hints };
});

// Contest evaluator tokens (src/core/evaluator.ts): minted by an admin, limited to eval-* repos, hard expiry.
route("POST", "/v1/admin/evaluator-token", "evaluator token", "admin", async (c) => {
  const b = await c.body();
  const label = str(b.label, "label");
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(label)) throw usage(`invalid label: ${label}`, "lowercase letters, digits, - and _ (max 31)");
  const minted = await mintEvaluatorToken(c.env, label, evalExpiry(Date.now(), typeof b.expiresAt === "string" ? b.expiresAt : null), claimsOf(c).name);
  return {
    data: { label, token: minted.token, expiresAt: minted.expiresAt, kid: minted.kid, jti: minted.jti, limits: { repos: EVAL_MAX_REPOS, agents: EVAL_MAX_AGENTS, prefix: "eval-" } },
    hints: [`switch all evaluator access off: npx wrangler kv key put --binding CONFIG "${EVAL_KILL_KEY}" 1 --remote`],
  };
});

// ---- D7: namespace shards + limits dashboard
route("GET", "/v1/limits", "limits", "read", async (c) => {
  const shards = shardCount(c.env);
  const perShard = await c.env.DB.prepare("SELECT shard, COUNT(*) AS repos FROM repos GROUP BY shard").all<{ shard: number; repos: number }>();
  const repo = c.url.searchParams.get("repo");
  const detail = repo ? await coord(c.env, repo).limits() : null;
  return {
    data: {
      shards: Array.from({ length: shards }, (_, k) => ({ shard: k, binding: k === 0 ? "ARTIFACTS" : `ARTIFACTS_S${k}`, repos: perShard.results.find((r) => r.shard === k)?.repos ?? 0 })),
      documented: DOCUMENTED,
      repo: detail,
    },
    hints: repo ? [] : ["GET /v1/limits?repo=<name> for one repo's measured usage"],
  };
});

// ---- D5 mirror-out (FR-39)
route("PUT", "/v1/repos/:repo/mirror", "mirror set", "admin", async (c) => {
  const b = await c.body();
  const repo = c.params.repo ?? "";
  await coord(c.env, repo).snapshot(); // 404 unless the repo exists
  const kind = b.kind === "bearer" ? "bearer" : "github";
  const view = await setMirror(c.env, repo, { url: str(b.url, "url"), kind, token: str(b.token, "token"), by: claimsOf(c).name });
  return { data: view, hints: [`weft mirror sync --repo ${repo}  # push the current trunk now; every landing pushes afterwards`] };
});
route("GET", "/v1/repos/:repo/mirror", "mirror show", "admin", async (c) => {
  const v = await getMirror(c.env, c.params.repo ?? "");
  if (!v) throw new WeftError("NOT_FOUND", `no mirror configured for ${c.params.repo ?? ""}`, { hint: "weft mirror set --url https://github.com/owner/repo.git --token-env GITHUB_TOKEN" });
  const last = await coord(c.env, c.params.repo ?? "").mirrorLast();
  return { data: { ...v, last: last ?? v.last } };
});
route("POST", "/v1/repos/:repo/mirror/sync", "mirror sync", "admin", async (c) => {
  const repo = c.params.repo ?? "";
  await resolveShard(c.env, repo);
  const info = await repoInfo(c.env, repo);
  const last = await pushMirror(c.env, repo, info.remote, null);
  if (!last) throw new WeftError("NOT_FOUND", `no mirror configured for ${repo}`);
  await coord(c.env, repo).mirrorResult({ ok: last.ok, pushed: last.pushed, remoteMain: last.remoteMain, error: last.error });
  if (!last.ok) throw new WeftError("UPSTREAM_MIRROR", `mirror push failed: ${last.error ?? "unknown"}`, { retryable: true, details: { last } });
  return { data: last };
});
route("DELETE", "/v1/repos/:repo/mirror", "mirror remove", "admin", async (c) => ({ data: { removed: await removeMirror(c.env, c.params.repo ?? "") } }));

route("GET", "/v1/repos/:repo/snapshot", "snapshot", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").snapshot() }));

route("POST", "/v1/repos/:repo/workspaces", "start", "agent", async (c) => {
  const b = await c.body();
  const mode: IntentMode = b.mode === "exclusive" ? "exclusive" : "soft";
  const claims = claimsOf(c);
  const budget = claims.role === "agent" ? budgetOf(await agentRow(c.env, claims.sub)) : {};
  const res = await coord(c.env, c.params.repo ?? "").start({ agent: claims, task: str(b.task, "task"), globs: strs(b.touch, "touch"), mode, ttl: numOr(b.ttl, null), after: typeof b.after === "string" && b.after ? b.after : null, wait: b.wait === true, maxOpenWorkspaces: budget.openWorkspacesPerRepo ?? null });
  if ("waiting" in res) return { data: res, hints: [`waiting: #${res.position} in line for this scope; poll again with --wait`] };
  const hints = ["weft status", 'weft submit -m "..."'];
  const dup = res.forecast.duplicates?.[0];
  if (dup) hints.unshift(`coordinate with ${dup.agentName} (${dup.workspaceId}): "${dup.task}" looks like the same work (similarity ${dup.similarity})`);
  if (res.forecast.risk === "medium" || res.forecast.risk === "high") hints.unshift("weft who <path>  # another agent is in scope");
  return { data: res, hints };
});

route("POST", "/v1/repos/:repo/workspaces/:ws/heartbeat", "status", "agent", async (c) => {
  const b = await c.body();
  const symbols = b.symbols && typeof b.symbols === "object" && !Array.isArray(b.symbols)
    ? Object.fromEntries(Object.entries(b.symbols as Record<string, unknown>).map(([f, xs]) => [f, strs(xs, `symbols.${f}`)]))
    : undefined;
  const rep = await coord(c.env, c.params.repo ?? "").heartbeat({ wsId: c.params.ws ?? "", agent: claimsOf(c), touched: strs(b.touched ?? [], "touched"), symbols });
  const hints: string[] = [];
  if (rep.workspace.status === "conflicted") hints.push("resolve conflicts, then `weft sync --continue`");
  if (rep.outOfIntent.length > 0) hints.push(`weft widen --touch "${rep.outOfIntent[0] ?? ""}"`);
  if (rep.forecast.risk === "high") hints.push("weft who <file>  # another agent touched the same files");
  if (rep.workspace.status === "active" && rep.touched.length > 0) hints.push('weft submit -m "..."');
  return { data: rep, hints };
});

route("POST", "/v1/repos/:repo/workspaces/:ws/tokens", "tokens", "agent", async (c) => ({
  data: await coord(c.env, c.params.repo ?? "").tokens(c.params.ws ?? "", claimsOf(c)),
}));

route("POST", "/v1/repos/:repo/workspaces/:ws/intent", "widen", "agent", async (c) => {
  const b = await c.body();
  return { data: await coord(c.env, c.params.repo ?? "").widen({ wsId: c.params.ws ?? "", agent: claimsOf(c), globs: strs(b.touch, "touch") }) };
});

route("POST", "/v1/repos/:repo/workspaces/:ws/sync-report", "sync", "agent", async (c) => {
  const b = await c.body();
  const action = str(b.action, "action") as "merged" | "fast_forward" | "up_to_date" | "conflicted" | "continued" | "aborted";
  return {
    data: await coord(c.env, c.params.repo ?? "").syncReport({ wsId: c.params.ws ?? "", agent: claimsOf(c), action, base: str(b.base, "base"), conflictedFiles: strs(b.conflictedFiles ?? [], "conflictedFiles") }),
  };
});

route("POST", "/v1/repos/:repo/workspaces/:ws/changesets", "submit", "agent", async (c) => {
  const b = await c.body();
  const refund = claimsOf(c).role === "agent" ? await chargeSubmit(c.env, claimsOf(c), numOr(b.costUsd, 0) ?? 0) : null;
  const res = await coord(c.env, c.params.repo ?? "").submit({
    wsId: c.params.ws ?? "",
    agent: claimsOf(c),
    message: str(b.message, "message"),
    head: str(b.head, "head"),
    base: str(b.base, "base"),
    filesTouched: strs(b.filesTouched, "filesTouched"),
    linesAdded: numOr(b.linesAdded, 0) ?? 0,
    linesDeleted: numOr(b.linesDeleted, 0) ?? 0,
    checkpoints: numOr(b.checkpoints, 0) ?? 0,
    behind: numOr(b.behind, 0) ?? 0,
    promptSha256: typeof b.promptSha256 === "string" ? b.promptSha256 : null,
    toolCalls: numOr(b.toolCalls, null),
    costUsd: numOr(b.costUsd, null),
    resolves: typeof b.resolves === "string" ? b.resolves : null,
    recipe: b.recipe && typeof b.recipe === "object" ? { name: str((b.recipe as Record<string, unknown>).name, "recipe.name"), args: strs((b.recipe as Record<string, unknown>).args ?? [], "recipe.args") } : null,
  }).catch(async (err: unknown) => {
    if (refund) await refund();
    throw err;
  });
  const cs = res.changeset;
  return {
    data: res,
    hints: cs.status === "needs_review" ? [`weft approve ${cs.id}  # held for a human (risk ${cs.riskScore})`] : [`weft show ${cs.id}  # the queue runs automatically`, "weft events --follow"],
  };
});

// ---- D8 (FR-15): sandbox per workspace — clone, exec and submit in the cloud, no local checkout needed
const sandboxOf = (env: Env, repo: string, ws: string) => env.SANDBOX.getByName(`${repo}/${ws}`);
const openSandbox = async (c: Ctx): Promise<{ head: string; branch: string; ms: number }> => {
  const repo = c.params.repo ?? "";
  const ws = c.params.ws ?? "";
  const spec = await coord(c.env, repo).workspaceGit(ws, claimsOf(c)); // ownership + fresh tokens
  return sandboxOf(c.env, repo, ws).open({ repo, wsId: ws, branch: spec.branch, baseCommit: spec.baseCommit, agentName: spec.agentName, fork: spec.fork, trunk: spec.trunk, stackedOn: spec.stackedOn });
};
route("POST", "/v1/repos/:repo/workspaces/:ws/sandbox", "sandbox open", "agent", async (c) => {
  const opened = await openSandbox(c);
  return { data: { sandbox: `${c.params.repo ?? ""}/${c.params.ws ?? ""}`, ...opened, exec: `/v1/repos/${c.params.repo ?? ""}/workspaces/${c.params.ws ?? ""}/exec` }, hints: ['weft exec -- "npm test"', 'weft submit -m "..."  # commits and pushes from the sandbox'] };
});
route("GET", "/v1/repos/:repo/workspaces/:ws/sandbox", "sandbox status", "agent", async (c) => {
  await coord(c.env, c.params.repo ?? "").ownWorkspace(c.params.ws ?? "", claimsOf(c));
  return { data: await sandboxOf(c.env, c.params.repo ?? "", c.params.ws ?? "").status() };
});
route("POST", "/v1/repos/:repo/workspaces/:ws/exec", "exec", "agent", async (c) => {
  const b = await c.body();
  const cmd = str(b.cmd, "cmd");
  if (cmd.length > 20_000) throw usage("command too long (max 20,000 chars)");
  const repo = c.params.repo ?? "";
  const ws = c.params.ws ?? "";
  await coord(c.env, repo).workspaceGit(ws, claimsOf(c)); // ownership on every call
  const box = sandboxOf(c.env, repo, ws);
  let r = await box.exec(cmd, numOr(b.timeoutMs, 300_000) ?? 300_000);
  let reopened = false;
  if ("needsOpen" in r) {
    // The container stopped while idle: re-clone (pushed checkpoints survive on the fork) and run again.
    await openSandbox(c);
    reopened = true;
    r = await box.exec(cmd, numOr(b.timeoutMs, 300_000) ?? 300_000);
    if ("needsOpen" in r) throw new WeftError("UPSTREAM_SANDBOX", "sandbox could not be reopened", { retryable: true });
  }
  const res = r as ExecResult;
  return { data: { ...res, reopened }, hints: res.exitCode === 0 ? [] : [`exit ${res.exitCode}`] };
});
route("POST", "/v1/repos/:repo/workspaces/:ws/sandbox/submit", "submit", "agent", async (c) => {
  const b = await c.body();
  const repo = c.params.repo ?? "";
  const ws = c.params.ws ?? "";
  const spec = await coord(c.env, repo).workspaceGit(ws, claimsOf(c));
  const prep = await sandboxOf(c.env, repo, ws).prepareSubmit({ message: str(b.message, "message"), forkToken: spec.fork.token, trunkToken: spec.trunk.token });
  if ("needsOpen" in prep) throw invalidStateErr("the sandbox was stopped while idle; run `weft exec -- true` to reopen it (pushed checkpoints are kept), then submit");
  const refund = claimsOf(c).role === "agent" ? await chargeSubmit(c.env, claimsOf(c), numOr(b.costUsd, 0) ?? 0) : null;
  const res = await coord(c.env, repo)
    .submit({ wsId: ws, agent: claimsOf(c), message: str(b.message, "message"), head: prep.head, base: prep.base, filesTouched: prep.files, linesAdded: prep.added, linesDeleted: prep.deleted, checkpoints: prep.checkpoints, behind: prep.behind, promptSha256: typeof b.promptSha256 === "string" ? b.promptSha256 : null, toolCalls: numOr(b.toolCalls, null), costUsd: numOr(b.costUsd, null), resolves: typeof b.resolves === "string" ? b.resolves : null, recipe: null })
    .catch(async (err: unknown) => {
      if (refund) await refund();
      throw err;
    });
  return { data: { ...res, sandbox: { head: prep.head, files: prep.files.length } }, hints: [`weft show ${res.changeset.id}  # the queue runs automatically`] };
});
route("DELETE", "/v1/repos/:repo/workspaces/:ws/sandbox", "sandbox close", "agent", async (c) => {
  await coord(c.env, c.params.repo ?? "").ownWorkspace(c.params.ws ?? "", claimsOf(c));
  return { data: await sandboxOf(c.env, c.params.repo ?? "", c.params.ws ?? "").close() };
});

route("DELETE", "/v1/repos/:repo/workspaces/:ws", "abandon", "agent", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").abandon(c.params.ws ?? "", claimsOf(c)) }));

route("GET", "/v1/repos/:repo/queue", "queue", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").queue() }));
route("POST", "/v1/repos/:repo/queue/run", "queue run", "admin", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").queueRun(claimsOf(c).name) }));

route("GET", "/v1/repos/:repo/changesets/:cs", "show", "read", async (c) => {
  const cs = await coord(c.env, c.params.repo ?? "").show(c.params.cs ?? "");
  const hints: string[] = [];
  if (cs.status === "rejected" && cs.rejection?.reason === "conflict") hints.push("weft sync  # then resolve and resubmit");
  if (cs.status === "rejected" && cs.rejection?.logKey) hints.push(`weft logs ${cs.id}`);
  for (const a of cs.scorecard?.advice ?? []) hints.push(`improve: ${a}`);
  return { data: cs, hints };
});

route("GET", "/v1/repos/:repo/changesets/:cs/provenance", "provenance", "read", async (c) => {
  const key = `prov/${c.params.repo ?? ""}/${c.params.cs ?? ""}.json`;
  const obj = await c.env.BLOBS.get(key);
  if (!obj) throw new WeftError("NOT_FOUND", `no provenance bundle for ${c.params.cs ?? ""} (only landed changesets have one)`);
  const text = await obj.text();
  return { data: { key, sha256: obj.customMetadata?.sha256 ?? null, commit: obj.customMetadata?.commit ?? null, bundle: JSON.parse(text) as unknown } };
});

route("GET", "/v1/repos/:repo/changesets/:cs/log", "logs", "read", async (c) => {
  const cs = await coord(c.env, c.params.repo ?? "").show(c.params.cs ?? "");
  const key = cs.rejection?.logKey;
  if (!key) throw new WeftError("NOT_FOUND", `no check log for ${cs.id}`);
  const obj = await c.env.BLOBS.get(key);
  return { data: { key, log: obj ? await obj.text() : null } };
});

route("POST", "/v1/repos/:repo/changesets/:cs/approve", "approve", "review", async (c) => ({
  data: await coord(c.env, c.params.repo ?? "").approve(c.params.cs ?? "", claimsOf(c).name === "admin" ? String((await c.body()).by ?? "admin") : claimsOf(c).name),
  hints: ["the queue runs automatically"],
}));

route("POST", "/v1/repos/:repo/changesets/:cs/reject", "reject", "review", async (c) => {
  const b = await c.body();
  return { data: await coord(c.env, c.params.repo ?? "").reject(c.params.cs ?? "", String(b.by ?? claimsOf(c).name), String(b.reason ?? "rejected in review")) };
});

// FR-48: per-signal threshold sweep of the judge against outcome labels (reverted / hotfixed / human_rejected).
route("GET", "/v1/calibration", "calibration", "read", async (c) => {
  const repo = c.url.searchParams.get("repo");
  const sql = `SELECT repo, cs_id, status, hold, outcome, intent_alignment, test_adequacy, security_concern, data, updated_at FROM scorecards ${repo ? "WHERE repo = ?" : ""} ORDER BY updated_at DESC LIMIT 5000`;
  const res = await (repo ? c.env.DB.prepare(sql).bind(repo) : c.env.DB.prepare(sql)).all<{ status: string; hold: string | null; outcome: string | null; intent_alignment: number | null; test_adequacy: number | null; security_concern: number | null; data: string; updated_at: number }>();
  const weekAgo = Date.now() - 7 * 86_400_000;
  const rows: LabeledRow[] = [];
  for (const r of res.results) {
    const bad = r.outcome !== null && (BAD_OUTCOMES as readonly string[]).includes(r.outcome);
    const good = !bad && r.status === "landed" && r.updated_at < weekAgo;
    if (!bad && !good) continue; // unlabeled (too recent, or rejected for non-quality reasons)
    let second: number | null = null;
    let disagreement: number | null = null;
    try {
      const card = JSON.parse(r.data) as { judge?: { second?: { intentAlignment?: number | null } | null; disagreement?: number | null } | null };
      second = card.judge?.second?.intentAlignment ?? null;
      disagreement = card.judge?.disagreement ?? null;
    } catch (err: unknown) {
      console.log(JSON.stringify({ level: "warn", msg: "calibration: bad scorecard json", err: String(err) }));
    }
    rows.push({ bad, held: r.hold !== null, signals: { intentAlignment: r.intent_alignment, testAdequacy: r.test_adequacy, securityConcern: r.security_concern, secondIntentAlignment: second, judgeDisagreement: disagreement } });
  }
  const report = calibrate(rows);
  return { data: { repo: repo ?? "all", scanned: res.results.length, ...report }, hints: [report.note] };
});

route("POST", "/v1/repos/:repo/changesets/:cs/revert", "revert", "admin", async (c) => ({
  data: await coord(c.env, c.params.repo ?? "").revert(c.params.cs ?? "", String((await c.body()).by ?? claimsOf(c).name)),
}));

route("GET", "/v1/repos/:repo/log", "log", "read", async (c) => {
  const n = Math.min(100, Math.max(1, Number(c.url.searchParams.get("n") ?? "20")));
  await resolveShard(c.env, c.params.repo ?? "");
  const log = await trunkLog(c.env, c.params.repo ?? "", n);
  return {
    data: log.map((e) => {
      const t = parseTrailers(e.message);
      return { commit: e.hash, author: e.author.name, at: new Date(e.authoredAt * 1000).toISOString(), subject: e.message.split("\n")[0] ?? "", changeset: t["Weft-Changeset"] ?? null, model: t["Weft-Model"] ?? null, risk: t["Weft-Risk"] ? Number(t["Weft-Risk"]) : null, trailers: t };
    }),
  };
});

// ---- FR-09 calibration: score task pairs with the same embedding model the coordinator uses (admin only)
route("POST", "/v1/admin/similarity", "similarity", "admin", async (c) => {
  const b = await c.body();
  const pairs = Array.isArray(b.pairs) ? (b.pairs as unknown[]).filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string")).slice(0, 50) : [];
  if (pairs.length === 0) throw usage("pairs: [[taskA, taskB], ...] (max 50)");
  const texts = [...new Set(pairs.flat())];
  const raw = (await (c.env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> }).run(EMBED_MODEL, { text: texts })) as { data?: number[][] };
  const vecs = new Map(texts.map((t, i) => [t, raw.data?.[i] ?? []]));
  return { data: { model: EMBED_MODEL, threshold: DUPLICATE_THRESHOLD, scores: pairs.map(([x, y]) => ({ a: x, b: y, similarity: Math.round(cosine(vecs.get(x) ?? [], vecs.get(y) ?? []) * 1000) / 1000 })) } };
});

// ---- context preservation: context packs + resume (FR-16)
route("GET", "/v1/repos/:repo/workspaces/:ws/context", "context", "agent", async (c) => {
  const budget = Math.min(32_000, Math.max(800, Number(c.url.searchParams.get("budget") ?? "6000")));
  const pack = (await coord(c.env, c.params.repo ?? "").contextPack(c.params.ws ?? "", claimsOf(c), budget)) as unknown as ContextPack;
  const markdown = contextMarkdown(pack, c.params.repo ?? "");
  return { data: c.url.searchParams.get("format") === "md" ? { markdown } : { ...pack, markdown }, hints: pack.next };
});
route("POST", "/v1/repos/:repo/workspaces/:ws/resume", "resume", "agent", async (c) => {
  const res = await coord(c.env, c.params.repo ?? "").resume(c.params.ws ?? "", claimsOf(c));
  return { data: res, hints: ["weft context  # what happened while you were away", "weft status"] };
});

// ---- Conflict Rooms (FR-24)
route("GET", "/v1/repos/:repo/rooms", "room list", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").rooms() }));
route("GET", "/v1/repos/:repo/rooms/:room", "room show", "read", async (c) => {
  const r = await coord(c.env, c.params.repo ?? "").roomShow(c.params.room ?? "");
  const hints: string[] = [];
  if (r.status === "verified") hints.push(`weft room accept ${r.id}  # the proposal passed the check on current trunk`);
  if (r.status === "failed") hints.push(`weft sync  # resolve by hand, then weft submit --resolves ${r.csId}`);
  if (r.status === "open" || r.status === "proposing" || r.status === "verifying") hints.push(`weft room show ${r.id}  # resolver is working`);
  return { data: r, hints };
});
route("GET", "/v1/repos/:repo/rooms/:room/log", "room log", "read", async (c) => {
  const r = await coord(c.env, c.params.repo ?? "").roomShow(c.params.room ?? "");
  const n = Number(c.url.searchParams.get("attempt") ?? String(r.attempts.length));
  const key = r.attempts.find((a) => a.n === n)?.logKey;
  if (!key) throw new WeftError("NOT_FOUND", `no check log for ${r.id} attempt ${n}`);
  const obj = await c.env.BLOBS.get(key);
  return { data: { key, attempt: n, log: obj ? await obj.text() : null } };
});
route("POST", "/v1/repos/:repo/rooms/:room/accept", "room accept", "agent", async (c) => {
  const res = await coord(c.env, c.params.repo ?? "").roomAccept(c.params.room ?? "", claimsOf(c));
  return { data: res, hints: [`weft show ${res.changeset.id}  # resubmitted with Weft-Resolves: ${res.room.csId}`, "weft events --follow"] };
});

route("GET", "/v1/repos/:repo/who", "who", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").who(str(c.url.searchParams.get("path"), "path")) }));
route("GET", "/v1/repos/:repo/events", "events", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").events(Number(c.url.searchParams.get("since") ?? "0")) }));
route("GET", "/v1/repos/:repo/leaderboard", "leaderboard", "read", async (c) => ({ data: await coord(c.env, c.params.repo ?? "").leaderboard() }));

// ------------------------------------------------------------ dispatch

const json = (status: number, body: Envelope<unknown> | ErrorEnvelope, requestId: string): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": requestId, "access-control-allow-origin": "*" } });

const projection = async (batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> => {
  for (const msg of batch.messages) {
    const j = msg.body;
    try {
      if (j.kind === "scorecard") {
        const cs = j.cs as { id: string; agentId: string; agentName: string; model: string; status: string; wqs: number | null; outcome?: string | null; scorecard: { judge: { intentAlignment: number | null; testAdequacy: number | null; securityConcern: number | null } | null; hold: string | null } };
        await env.DB.prepare(
          `INSERT INTO scorecards (repo, cs_id, agent_id, agent_name, model, status, wqs, intent_alignment, test_adequacy, security_concern, hold, outcome, data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo, cs_id) DO UPDATE SET status = excluded.status, wqs = excluded.wqs, intent_alignment = excluded.intent_alignment,
             test_adequacy = excluded.test_adequacy, security_concern = excluded.security_concern, hold = excluded.hold,
             outcome = COALESCE(excluded.outcome, scorecards.outcome), data = excluded.data, updated_at = excluded.updated_at`,
        )
          .bind(String(j.repo), cs.id, cs.agentId, cs.agentName, cs.model, cs.status, cs.wqs, cs.scorecard.judge?.intentAlignment ?? null, cs.scorecard.judge?.testAdequacy ?? null, cs.scorecard.judge?.securityConcern ?? null, cs.scorecard.hold, cs.outcome ?? null, JSON.stringify(cs.scorecard), Date.now())
          .run();
      } else if (j.kind === "outcome") {
        await env.DB.prepare("UPDATE scorecards SET outcome = ?, updated_at = ? WHERE repo = ? AND cs_id = ?").bind(String(j.outcome), Date.now(), String(j.repo), String(j.csId)).run();
      } else if (j.kind === "repo") {
        await env.DB.prepare("INSERT INTO repos (id, created_at, config) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config")
          .bind(String(j.repo), Date.now(), JSON.stringify(j.config ?? {}))
          .run();
      }
      msg.ack();
    } catch (err: unknown) {
      console.log(JSON.stringify({ level: "error", msg: "projection failed", kind: j.kind, err: String(err) }));
      msg.retry({ delaySeconds: 10 });
    }
  }
};

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const requestId = crypto.randomUUID();
    const started = Date.now();
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, DELETE" } });
    }
    if (url.pathname === "/mcp") {
      try {
        const claims = await authenticate(req, env, exec);
        await gateAgent(env, claims);
        return await handleMcp(req, env, exec, claims);
      } catch (err: unknown) {
        const e = decodeFromRpc(err);
        return json(e.status, { ok: false, command: "mcp", error: e.toJSON(), requestId }, requestId);
      }
    }
    const wsMatch = /^\/v1\/repos\/([^/]+)\/ws$/.exec(url.pathname);
    if (wsMatch && req.headers.get("Upgrade") === "websocket") {
      try {
        const claims = await optionalAuth(req, env, exec);
        if (!claims && env.PUBLIC_READ !== "true") throw new WeftError("UNAUTHENTICATED", "missing bearer token");
        const headers = new Headers(req.headers);
        headers.set("x-weft-ws-role", claims && claims.role === "agent" && url.searchParams.get("as") === "agent" ? "agent" : "ui");
        if (claims) headers.set("x-weft-agent-id", claims.sub);
        return await coord(env, decodeURIComponent(wsMatch[1] ?? "")).fetch(new Request(req.url, { headers, method: "GET" }));
      } catch (err: unknown) {
        const e = decodeFromRpc(err);
        return json(e.status, { ok: false, command: "events --follow", error: e.toJSON(), requestId }, requestId);
      }
    }
    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) {
      if (url.pathname.startsWith("/v1/")) return json(404, { ok: false, command: "unknown", error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}`, retryable: false, hint: null, details: {} }, requestId }, requestId);
      return env.ASSETS.fetch(req);
    }
    const m = r.pattern.exec(url.pathname);
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m?.[i + 1] ?? "")));
    let cached: Record<string, unknown> | null = null;
    try {
      const claims = r.auth === "public" ? null : r.auth === "read" ? await optionalAuth(req, env, exec) : await authenticate(req, env, exec);
      if (r.auth === "read" && !claims && env.PUBLIC_READ !== "true") throw new WeftError("UNAUTHENTICATED", "missing bearer token");
      const evalScoped = claims && (claims.role === "evaluator" || (claims.role === "agent" && isEvalName(claims.name)));
      if (evalScoped && r.auth !== "public" && r.auth !== "read" && (await env.CONFIG.get(EVAL_KILL_KEY))) {
        throw forbidden("evaluator access is switched off on this deployment");
      }
      if (claims?.role === "evaluator") {
        // Contest judges: admin/review-level actions only on eval-* repos (src/core/evaluator.ts).
        const d = evaluatorMay(r.auth, r.command, params.repo);
        if (!d.allow) throw forbidden(d.reason ?? "not allowed for evaluator tokens");
      } else {
        if (r.auth === "admin" && claims) requireAdmin(claims);
        if (r.auth === "review" && claims) requireReviewer(claims);
      }
      if (claims?.role === "agent" && r.auth !== "public" && r.auth !== "read") {
        const d = evalAgentMay(claims.name, params.repo);
        if (!d.allow) throw forbidden(d.reason ?? "not allowed");
      }
      await gateAgent(env, claims);
      const ctx: Ctx = {
        req,
        env,
        exec,
        params,
        url,
        claims,
        body: async () => {
          if (cached) return cached;
          try {
            cached = (await req.json()) as Record<string, unknown>;
          } catch (err: unknown) {
            throw usage(`request body must be JSON (${String(err)})`);
          }
          return cached;
        },
      };
      // Idempotent reads ride out a transient platform error server-side (writes are retried by the client).
      const res = req.method === "GET" ? await withRetry(() => r.fn(ctx), { attempts: 3, baseMs: 150, retryable: (err) => decodeFromRpc(err).code === "UPSTREAM_PLATFORM" }) : await r.fn(ctx);
      console.log(JSON.stringify({ level: "info", msg: "api", requestId, command: r.command, repo: params.repo, ws: params.ws, cs: params.cs, actor: claims?.name ?? "public", ms: Date.now() - started }));
      return json(200, { ok: true, command: r.command, data: res.data, hints: res.hints ?? [] }, requestId);
    } catch (err: unknown) {
      const e = decodeFromRpc(err);
      console.log(JSON.stringify({ level: e.status >= 500 ? "error" : "warn", msg: "api error", requestId, command: r.command, code: e.code, message: e.message, ms: Date.now() - started }));
      return json(e.status, { ok: false, command: r.command, error: e.toJSON(), requestId }, requestId);
    }
  },

  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env): Promise<void> {
    await projection(batch, env);
  },

  // D6: weekly agent-token key rotation (no-op until the current key is 7 days old).
  async scheduled(_ctl: ScheduledController, env: Env): Promise<void> {
    const rotated = await rotateIfDue(env);
    console.log(JSON.stringify({ level: "info", msg: "cron: key rotation check", rotated }));
  },
} satisfies ExportedHandler<Env, Record<string, unknown>>;
