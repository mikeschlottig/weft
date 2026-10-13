// weft-api Worker: the single public entry point (spec §6). Routes decisions to the repo's
// RepoCoordinator DO; git data never flows through here (agents talk to Artifacts directly).

import { WeftError, decodeFromRpc, usage } from "../core/errors.ts";
import { type ContextPack, contextMarkdown } from "../core/context.ts";
import { DUPLICATE_THRESHOLD, EMBED_MODEL, cosine } from "../core/similarity.ts";
import { BAD_OUTCOMES, type LabeledRow, calibrate } from "../core/calibration.ts";
import { signJwt } from "../core/jwt.ts";
import type { AgentClaims, Envelope, ErrorEnvelope, IntentMode, RepoConfig } from "../core/types.ts";
import { trunkLog } from "./artifacts.ts";
import { authenticate, optionalAuth, requireAdmin } from "./auth.ts";
import { handleMcp } from "./mcp.ts";

export { RepoCoordinator } from "./coordinator.ts";
export { MergeQueue } from "./merge-queue.ts";
export { RoomResolver } from "./room-resolver.ts";
export { PushObserver } from "./push-observer.ts";
export { MergeRunner } from "./runner-client.ts";

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

const routes: { method: string; pattern: RegExp; keys: string[]; command: string; auth: "public" | "read" | "agent" | "admin"; fn: Handler }[] = [];
const route = (method: string, path: string, command: string, auth: "public" | "read" | "agent" | "admin", fn: Handler): void => {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
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

route("POST", "/v1/agents", "agent register", "admin", async (c) => {
  const b = await c.body();
  const name = str(b.name, "name");
  const model = str(b.model, "model");
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) throw usage(`invalid agent name: ${name}`, "lowercase letters, digits, - and _ (max 31)");
  const ttlHours = Math.min(168, Math.max(1, numOr(b.ttlHours, 24) ?? 24));
  const existing = await c.env.DB.prepare("SELECT id FROM agents WHERE name = ?").bind(name).first<{ id: string }>();
  const id = existing?.id ?? `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await c.env.DB.prepare("INSERT INTO agents (id, name, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET model = excluded.model")
    .bind(id, name, model, Date.now())
    .run();
  const iat = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: id, name, model, role: "agent", iat, exp: iat + ttlHours * 3600 }, c.env.JWT_SIGNING_SECRET);
  return { data: { agent: { id, name, model }, token, expiresAt: new Date((iat + ttlHours * 3600) * 1000).toISOString() }, hints: [`export WEFT_TOKEN=<token>  # as ${name}`] };
});

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

route("POST", "/v1/repos", "init", "admin", async (c) => {
  const b = await c.body();
  const repo = str(b.repo, "repo");
  const imp = b.import && typeof b.import === "object" ? (b.import as Record<string, unknown>) : null;
  const data = await coord(c.env, repo).init({
    repo,
    config: (b.config ?? {}) as Partial<RepoConfig>,
    actor: claimsOf(c).name,
    import: imp ? { url: str(imp.url, "import.url"), ...(typeof imp.branch === "string" && imp.branch ? { branch: imp.branch } : {}) } : null,
  });
  return { data, hints: ["push an initial commit to the returned remote (the CLI does this with --from DIR)", "weft agent register --name <agent> --model <model>"] };
});

route("PATCH", "/v1/repos/:repo/config", "config", "admin", async (c) => ({
  data: await coord(c.env, c.params.repo ?? "").configure((await c.body()) as Partial<RepoConfig>, claimsOf(c).name),
}));

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

route("POST", "/v1/repos/:repo/changesets/:cs/approve", "approve", "admin", async (c) => ({
  data: await coord(c.env, c.params.repo ?? "").approve(c.params.cs ?? "", claimsOf(c).name === "admin" ? String((await c.body()).by ?? "admin") : claimsOf(c).name),
  hints: ["the queue runs automatically"],
}));

route("POST", "/v1/repos/:repo/changesets/:cs/reject", "reject", "admin", async (c) => {
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
        const claims = await authenticate(req, env);
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
        const claims = await optionalAuth(req, env);
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
      const claims = r.auth === "public" ? null : r.auth === "read" ? await optionalAuth(req, env) : await authenticate(req, env);
      if (r.auth === "read" && !claims && env.PUBLIC_READ !== "true") throw new WeftError("UNAUTHENTICATED", "missing bearer token");
      if (r.auth === "admin" && claims) requireAdmin(claims);
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
      const res = await r.fn(ctx);
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
} satisfies ExportedHandler<Env, Record<string, unknown>>;
