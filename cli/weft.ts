#!/usr/bin/env node
// weft — the agent CLI for Weft on Cloudflare (spec §11.1).
//   * git runs here, against the agent's Artifacts fork (header tokens, never in URLs or config)
//   * decisions run on Cloudflare (WEFT_REMOTE); this CLI only reports facts and prints envelopes
//   * stdout = one JSON envelope when not a TTY (or --json); text for humans. Stable exit codes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, WeftError, exitFor, toWeftError, usage } from "../src/core/errors.ts";
import type { ErrorEnvelope } from "../src/core/types.ts";

const DEFAULT_REMOTE = "https://weft.ceo-a53.workers.dev";
const TIMEOUT_MS = 600_000;

const OPTIONS = {
  json: { type: "boolean" },
  human: { type: "boolean" },
  repo: { type: "string" },
  ws: { type: "string" },
  from: { type: "string" },
  check: { type: "string" },
  batch: { type: "string" },
  "review-threshold": { type: "string" },
  sensitive: { type: "string" },
  union: { type: "string" },
  "no-judge": { type: "boolean" },
  "batch-window": { type: "string" },
  name: { type: "string" },
  model: { type: "string" },
  "ttl-hours": { type: "string" },
  task: { type: "string" },
  touch: { type: "string", multiple: true },
  exclusive: { type: "boolean" },
  dir: { type: "string" },
  message: { type: "string", short: "m" },
  "prompt-file": { type: "string" },
  "tool-calls": { type: "string" },
  cost: { type: "string" },
  resolves: { type: "string" },
  continue: { type: "boolean" },
  abort: { type: "boolean" },
  by: { type: "string" },
  n: { type: "string", short: "n" },
  since: { type: "string" },
  follow: { type: "boolean" },
  global: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string;
};

const HELP = `weft — coordination-first version control for many agents (Cloudflare)

Env: WEFT_REMOTE (default ${DEFAULT_REMOTE}), WEFT_TOKEN (agent token or admin token), WEFT_REPO

Admin
  weft init <repo> [--from DIR] [--check CMD] [--batch N] [--batch-window MS] [--sensitive GLOBS] [--union GLOBS] [--no-judge]
  weft config [--check CMD] [--batch N] [--review-threshold N] [--sensitive GLOBS] [--no-judge]
  weft agent register --name NAME --model MODEL [--ttl-hours N]
  weft approve <cs> [--by NAME]       weft revert <cs> [--by NAME]       weft queue run

Agent loop (inside a workspace dir, or --ws)
  weft start --task "..." --touch GLOB [--touch GLOB] [--exclusive] [--dir PATH]
  weft status                         heartbeat: touched, drift, live overlaps, forecast
  weft widen --touch GLOB
  weft checkpoint [-m MSG]            commit + push to your fork
  weft sync [--continue|--abort]      merge trunk in; conflicts name the peer changeset
  weft submit -m MSG [--prompt-file F] [--tool-calls N] [--cost USD] [--resolves cs-x]
  weft abandon

Read
  weft queue · weft show <cs> · weft scorecard <cs> · weft logs <cs> · weft log [-n N]
  weft who <path> · weft events [--since SEQ] [--follow] · weft leaderboard [--global]

Conflict Rooms (an AI proposal, merged on current trunk and proven by the repo's check)
  weft room list · weft room show <id> · weft room log <id> · weft room accept <id>

Exit: 0 ok · 2 usage · 3 conflict · 4 lease held · 5 check failed · 6 not found · 7 busy (retry) · 8 bad state
`;

// ------------------------------------------------------------ api

const remote = (): string => (process.env.WEFT_REMOTE ?? DEFAULT_REMOTE).replace(/\/$/, "");

const api = async <T>(method: string, path: string, body?: unknown): Promise<{ data: T; hints: string[] }> => {
  const token = process.env.WEFT_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // Retryable errors get ≥ 3 attempts with backoff + jitter. "Busy" codes (a batch is landing) keep
  // retrying for up to BUSY_BUDGET_MS: waiting out a landing is the client's job, not the agent's.
  const BUSY_BUDGET_MS = 90_000;
  const started = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; ; attempt += 1) {
    let busy = false;
    try {
      const res = await fetch(`${remote()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const env = (await res.json()) as { ok: boolean; data?: T; hints?: string[]; error?: ErrorEnvelope["error"] };
      if (env.ok) return { data: env.data as T, hints: env.hints ?? [] };
      const e = env.error ?? { code: "INTERNAL", message: `HTTP ${res.status}`, retryable: false, hint: null, details: {} };
      const we = new WeftError(e.code, e.message, { retryable: e.retryable, hint: e.hint, details: e.details, exitCode: exitFor(e.code) });
      if (!we.retryable) throw we;
      busy = /BUSY$/.test(we.code);
      lastErr = we;
    } catch (err: unknown) {
      if (err instanceof WeftError && !err.retryable) throw err;
      lastErr = err;
    }
    const outOfBudget = busy ? Date.now() - started > BUSY_BUDGET_MS : attempt >= 3;
    if (outOfBudget) break;
    const cap = Math.min(8_000, 400 * 2 ** Math.min(attempt, 5));
    await new Promise((r) => setTimeout(r, cap / 2 + Math.random() * (cap / 2)));
  }
  throw toWeftError(lastErr);
};

// ------------------------------------------------------------ git

interface Tok {
  remote: string;
  token: string;
  expiresAt: string;
}
interface WsFile {
  repo: string;
  ws: string;
  branch: string;
  fork: Tok;
  trunk: Tok;
}

const git = (args: string[], opts: { cwd?: string; token?: string; allow?: number[]; input?: string; env?: Record<string, string> } = {}): { code: number; stdout: string; stderr: string } => {
  const auth = opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token}`] : [];
  const r = spawnSync("git", [...auth, ...args], { cwd: opts.cwd, encoding: "utf8", input: opts.input, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) } });
  const res = { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").replace(/Bearer [A-Za-z0-9_\-.]+/g, "Bearer <redacted>") };
  if (res.code !== 0 && !(opts.allow ?? []).includes(res.code)) {
    throw new WeftError("GIT_FAILED", `git ${args.slice(0, 2).join(" ")} exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`);
  }
  return res;
};
const out = (args: string[], opts: Parameters<typeof git>[1] = {}): string => git(args, opts).stdout.trim();
const lines = (t: string): string[] => t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

const wsFilePath = (cwd: string): string => join(out(["rev-parse", "--absolute-git-dir"], { cwd }), "weft.json");

const loadWs = (flags: Flags): { cwd: string; w: WsFile } => {
  const cwd = flags.dir ? resolve(flags.dir) : process.cwd();
  const inRepo = git(["rev-parse", "--is-inside-work-tree"], { cwd, allow: [128] }).code === 0;
  if (!inRepo) throw usage("not inside a weft workspace", "cd into the directory `weft start` created, or pass --dir");
  const p = wsFilePath(cwd);
  if (!existsSync(p)) throw usage("this git repo is not a weft workspace", "run `weft start` first");
  return { cwd: out(["rev-parse", "--show-toplevel"], { cwd }), w: JSON.parse(readFileSync(p, "utf8")) as WsFile };
};

const saveWs = (cwd: string, w: WsFile): void => {
  const p = wsFilePath(cwd);
  writeFileSync(p, JSON.stringify(w, null, 2));
  chmodSync(p, 0o600);
};

/** Refresh git tokens when they are within 5 minutes of expiry. */
const fresh = async (cwd: string, w: WsFile): Promise<WsFile> => {
  const soon = Date.now() + 5 * 60_000;
  if (Date.parse(w.fork.expiresAt) > soon && Date.parse(w.trunk.expiresAt) > soon) return w;
  const t = await api<{ fork: Tok; trunk: Tok }>("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/tokens`, {});
  const next = { ...w, fork: t.data.fork, trunk: t.data.trunk };
  saveWs(cwd, next);
  return next;
};

const base = (cwd: string): string => out(["config", "--get", "weft.base"], { cwd });
const setBase = (cwd: string, sha: string): void => {
  git(["config", "weft.base", sha], { cwd });
};

const touchedFiles = (cwd: string): string[] => {
  const b = base(cwd);
  const tracked = lines(out(["diff", "--name-only", b], { cwd }));
  const untracked = lines(out(["ls-files", "--others", "--exclude-standard"], { cwd }));
  return [...new Set([...tracked, ...untracked])].sort();
};

const commitAll = (cwd: string, message: string): string | null => {
  if (out(["status", "--porcelain"], { cwd }).length === 0) return null;
  git(["add", "-A"], { cwd });
  git(["commit", "-q", "--no-verify", "-m", message], { cwd });
  return out(["rev-parse", "HEAD"], { cwd });
};

const pushFork = (cwd: string, w: WsFile): void => {
  git(["push", "-q", "-f", "origin", `HEAD:refs/heads/${w.branch}`], { cwd, token: w.fork.token });
};

const fetchTrunk = (cwd: string, w: WsFile): string => {
  git(["fetch", "-q", "trunk", "+refs/heads/main:refs/remotes/trunk/main"], { cwd, token: w.trunk.token });
  return out(["rev-parse", "trunk/main"], { cwd });
};

// ------------------------------------------------------------ commands

type Result = { data: unknown; hints: string[] };

const csv = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean));
const intOf = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usage(`--${name} must be a non-negative number`);
  return n;
};
const repoOf = (f: Flags): string => {
  const r = f.repo ?? process.env.WEFT_REPO;
  if (r) return r;
  const g = git(["config", "--get", "weft.repo"], { allow: [1, 128] });
  if (g.code === 0 && g.stdout.trim()) return g.stdout.trim();
  throw usage("no repo given", "pass --repo or set WEFT_REPO");
};
const configPatch = (f: Flags): Record<string, unknown> => {
  const p: Record<string, unknown> = {};
  if (f.check !== undefined) p.checkCommand = f.check.length > 0 ? f.check : null;
  const b = intOf(f.batch, "batch");
  if (b !== undefined) p.batchSize = Math.max(1, Math.floor(b));
  const t = intOf(f["review-threshold"], "review-threshold");
  if (t !== undefined) p.reviewThreshold = t;
  const s = csv(f.sensitive);
  if (s) p.sensitiveGlobs = s;
  const u = csv(f.union);
  if (u) p.unionGlobs = u;
  if (f["no-judge"]) p.judge = { enabled: false };
  const bw = intOf(f["batch-window"], "batch-window");
  if (bw !== undefined) p.batchWindowMs = bw;
  return p;
};

const pushInitial = (dir: string, remoteUrl: string, token: string, repo: string): string => {
  const tmp = mkdtempSync(join(tmpdir(), "weft-init-"));
  try {
    const gd = join(tmp, "g.git");
    git(["init", "-q", "--bare", "-b", "main", gd]);
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    git([`--git-dir=${gd}`, `--work-tree=${dir}`, "add", "-A", "."], { cwd: dir, env });
    const tree = out([`--git-dir=${gd}`, "write-tree"], { env });
    const head = out([`--git-dir=${gd}`, "commit-tree", tree, "-m", `weft: initialize ${repo}`], {
      env: { GIT_AUTHOR_NAME: "weft", GIT_AUTHOR_EMAIL: "weft@weft.dev", GIT_COMMITTER_NAME: "weft", GIT_COMMITTER_EMAIL: "weft@weft.dev" },
    });
    git([`--git-dir=${gd}`, "push", "-q", remoteUrl, `${head}:refs/heads/main`], { token: token.split("?expires=")[0] ?? token });
    return head;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const run = async (cmd: string, pos: string[], f: Flags): Promise<Result> => {
  switch (cmd) {
    case "init": {
      const repo = pos[0];
      if (!repo) throw usage("weft init <repo> [--from DIR]");
      const r = await api<{ repo: string; remote: string; token: string; config: unknown; adopted: boolean }>("POST", "/v1/repos", { repo, config: configPatch(f) });
      let head: string | null = null;
      if (f.from) head = pushInitial(resolve(f.from), r.data.remote, r.data.token, repo);
      return { data: { repo, remote: r.data.remote, initialCommit: head, config: r.data.config, adopted: r.data.adopted }, hints: ["weft agent register --name <agent> --model <model>"] };
    }
    case "config":
      return api("PATCH", `/v1/repos/${repoOf(f)}/config`, configPatch(f));
    case "agent": {
      if (pos[0] === "register") {
        if (!f.name || !f.model) throw usage("weft agent register --name NAME --model MODEL");
        return api("POST", "/v1/agents", { name: f.name, model: f.model, ttlHours: intOf(f["ttl-hours"], "ttl-hours") });
      }
      if (pos[0] === "list") return api("GET", "/v1/agents");
      throw usage("weft agent register|list");
    }
    case "start": {
      const repo = repoOf(f);
      if (!f.task) throw usage('weft start needs --task "..."');
      const r = await api<{
        workspace: { id: string; branch: string; baseCommit: string };
        forecast: unknown;
        fork: Tok;
        trunk: Tok & { head: string };
      }>("POST", `/v1/repos/${repo}/workspaces`, { task: f.task, touch: f.touch ?? [], mode: f.exclusive ? "exclusive" : "soft" });
      const ws = r.data.workspace;
      const dir = resolve(f.dir ?? ws.id);
      git(["clone", "-q", r.data.fork.remote, dir], { token: r.data.fork.token });
      git(["remote", "add", "trunk", r.data.trunk.remote], { cwd: dir });
      git(["checkout", "-q", "-B", ws.branch], { cwd: dir });
      git(["config", "user.name", process.env.WEFT_AGENT_NAME ?? ws.id.split("-").slice(2).join("-")], { cwd: dir });
      git(["config", "user.email", `${ws.id}@agents.weft.dev`], { cwd: dir });
      git(["config", "weft.repo", repo], { cwd: dir });
      git(["config", "weft.ws", ws.id], { cwd: dir });
      setBase(dir, ws.baseCommit);
      saveWs(dir, { repo, ws: ws.id, branch: ws.branch, fork: r.data.fork, trunk: r.data.trunk });
      const data = { ...r.data, fork: { remote: r.data.fork.remote, expiresAt: r.data.fork.expiresAt }, trunk: { remote: r.data.trunk.remote, head: r.data.trunk.head }, path: dir };
      return { data, hints: [`cd ${dir}`, ...r.hints] };
    }
    case "status": {
      const { cwd, w: w0 } = loadWs(f);
      const w = await fresh(cwd, w0);
      const touched = touchedFiles(cwd);
      const trunkHead = fetchTrunk(cwd, w);
      const b = base(cwd);
      const behind = Number(out(["rev-list", "--count", `${b}..${trunkHead}`], { cwd }));
      const trunkChanged = lines(out(["diff", "--name-only", b, trunkHead], { cwd }));
      const r = await api<Record<string, unknown>>("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/heartbeat`, { touched });
      const drift = { trunkHead, commitsBehind: behind, collidingWithTrunk: touched.filter((x) => trunkChanged.includes(x)) };
      const hints = [...r.hints];
      if (drift.collidingWithTrunk.length > 0) hints.unshift("weft sync  # trunk changed files you touched");
      else if (behind > 0) hints.unshift("weft sync");
      return { data: { ...r.data, drift }, hints };
    }
    case "widen": {
      const { w } = loadWs(f);
      return api("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/intent`, { touch: f.touch ?? [] });
    }
    case "checkpoint": {
      const { cwd, w: w0 } = loadWs(f);
      const w = await fresh(cwd, w0);
      const commit = commitAll(cwd, f.message ?? "weft: checkpoint");
      if (commit) pushFork(cwd, w);
      await api("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/heartbeat`, { touched: touchedFiles(cwd) });
      return { data: { commit, pushed: commit !== null }, hints: [] };
    }
    case "sync": {
      const { cwd, w: w0 } = loadWs(f);
      const w = await fresh(cwd, w0);
      const report = (action: string, b: string, conflictedFiles: string[] = []) =>
        api<{ peers: unknown[] }>("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/sync-report`, { action, base: b, conflictedFiles });
      if (f.abort) {
        git(["merge", "--abort"], { cwd });
        await report("aborted", base(cwd));
        return { data: { action: "aborted" }, hints: ["weft status"] };
      }
      if (f.continue) {
        const marked = lines(git(["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", "."], { cwd, allow: [1] }).stdout);
        if (marked.length > 0) throw new WeftError("CONFLICT_MARKERS", "conflict markers remain", { exitCode: EXIT.conflict, hint: "resolve the listed files, then `weft sync --continue`", details: { files: marked } });
        git(["add", "-A"], { cwd });
        git(["commit", "-q", "--no-edit", "--no-verify"], { cwd });
        const head = out(["rev-parse", "trunk/main"], { cwd });
        setBase(cwd, head);
        await report("continued", head);
        return { data: { action: "continued", base: head }, hints: ["weft status", 'weft submit -m "..."'] };
      }
      const auto = commitAll(cwd, "weft: checkpoint before sync");
      const trunkHead = fetchTrunk(cwd, w);
      if (git(["merge-base", "--is-ancestor", trunkHead, "HEAD"], { cwd, allow: [1] }).code === 0) {
        await report("up_to_date", base(cwd));
        return { data: { action: "up_to_date", trunkHead, autoCheckpoint: auto }, hints: [] };
      }
      const attrs = join(out(["rev-parse", "--absolute-git-dir"], { cwd }), "info", "attributes");
      if (!existsSync(attrs)) writeFileSync(attrs, "CHANGELOG.md merge=union\n**/CHANGELOG.md merge=union\n");
      const ff = git(["merge-base", "--is-ancestor", "HEAD", trunkHead], { cwd, allow: [1] }).code === 0;
      const merge = git(["merge", "-q", "--no-edit", "-m", `weft: sync with trunk ${trunkHead.slice(0, 10)}`, "trunk/main"], { cwd, allow: [1] });
      if (merge.code === 0) {
        setBase(cwd, trunkHead);
        await report(ff ? "fast_forward" : "merged", trunkHead);
        return { data: { action: ff ? "fast_forward" : "merged", trunkHead, autoCheckpoint: auto }, hints: ["weft status"] };
      }
      const files = lines(out(["diff", "--name-only", "--diff-filter=U"], { cwd }));
      const r = await report("conflicted", base(cwd), files);
      throw new WeftError("SYNC_CONFLICT", `sync stopped on ${files.length} conflicted file(s)`, {
        exitCode: EXIT.conflict,
        hint: "edit the files to remove conflict markers, then `weft sync --continue` (or `weft sync --abort`)",
        details: { conflicts: { files, peers: r.data.peers } },
      });
    }
    case "submit": {
      const { cwd, w: w0 } = loadWs(f);
      const w = await fresh(cwd, w0);
      if (!f.message) throw usage("submit needs -m <message>");
      commitAll(cwd, "weft: checkpoint before submit");
      const b = base(cwd);
      const head = out(["rev-parse", "HEAD"], { cwd });
      const files = lines(out(["diff", "--name-only", b, head], { cwd }));
      let added = 0;
      let deleted = 0;
      for (const row of lines(out(["diff", "--numstat", b, head], { cwd }))) {
        const [a = "0", d = "0"] = row.split("\t");
        added += Number.isNaN(Number(a)) ? 0 : Number(a);
        deleted += Number.isNaN(Number(d)) ? 0 : Number(d);
      }
      const checkpoints = Number(out(["rev-list", "--count", "--no-merges", `${b}..HEAD`], { cwd }));
      const trunkHead = fetchTrunk(cwd, w);
      const behind = Number(out(["rev-list", "--count", `${b}..${trunkHead}`], { cwd }));
      pushFork(cwd, w);
      const promptSha = f["prompt-file"] ? createHash("sha256").update(readFileSync(f["prompt-file"])).digest("hex") : null;
      return api("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/changesets`, {
        message: f.message,
        head,
        base: b,
        filesTouched: files,
        linesAdded: added,
        linesDeleted: deleted,
        checkpoints,
        behind,
        promptSha256: promptSha,
        toolCalls: intOf(f["tool-calls"], "tool-calls") ?? null,
        costUsd: f.cost !== undefined ? Number(f.cost) : null,
        resolves: f.resolves ?? null,
      });
    }
    case "abandon": {
      const { w } = loadWs(f);
      return api("DELETE", `/v1/repos/${w.repo}/workspaces/${w.ws}`);
    }
    case "queue":
      return pos[0] === "run" ? api("POST", `/v1/repos/${repoOf(f)}/queue/run`, {}) : api("GET", `/v1/repos/${repoOf(f)}/queue`);
    case "show":
      if (!pos[0]) throw usage("weft show <cs>");
      return api("GET", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}`);
    case "scorecard": {
      if (!pos[0]) throw usage("weft scorecard <cs>");
      const r = await api<{ id: string; status: string; provenance: { agentName: string; model: string }; scorecard: unknown }>("GET", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}`);
      return { data: { id: r.data.id, status: r.data.status, agent: r.data.provenance.agentName, model: r.data.provenance.model, scorecard: r.data.scorecard }, hints: r.hints };
    }
    case "logs":
      if (!pos[0]) throw usage("weft logs <cs>");
      return api("GET", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}/log`);
    case "approve":
      if (!pos[0]) throw usage("weft approve <cs>");
      return api("POST", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}/approve`, { by: f.by ?? "admin" });
    case "revert":
      if (!pos[0]) throw usage("weft revert <cs>");
      return api("POST", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}/revert`, { by: f.by ?? "admin" });
    case "log":
      return api("GET", `/v1/repos/${repoOf(f)}/log?n=${intOf(f.n, "n") ?? 20}`);
    case "who":
      if (!pos[0]) throw usage("weft who <path>");
      return api("GET", `/v1/repos/${repoOf(f)}/who?path=${encodeURIComponent(pos[0])}`);
    case "room": {
      const repo = repoOf(f);
      const sub = pos[0] ?? "list";
      if (sub === "list") return api("GET", `/v1/repos/${repo}/rooms`);
      const id = pos[1];
      if (!id) throw usage(`weft room ${sub} <room-id>`);
      if (sub === "show") return api("GET", `/v1/repos/${repo}/rooms/${id}`);
      if (sub === "log") return api("GET", `/v1/repos/${repo}/rooms/${id}/log`);
      if (sub === "accept") {
        const { cwd, w } = loadWs(f);
        const r = await api<{ branch: string; head: string; base: string; changeset: { id: string } }>("POST", `/v1/repos/${w.repo}/rooms/${id}/accept`, {});
        // Bring the local checkout to the verified resolution (the server fast-forwarded the fork branch).
        if (out(["status", "--porcelain"], { cwd }).length > 0) {
          return { data: { ...r.data, local: "not updated: uncommitted changes" }, hints: ["commit or stash, then `git fetch origin && git reset --hard origin/" + r.data.branch + "`", ...r.hints] };
        }
        const fw = await fresh(cwd, w);
        git(["fetch", "-q", "origin", `+refs/heads/${r.data.branch}:refs/remotes/origin/${r.data.branch}`], { cwd, token: fw.fork.token });
        git(["reset", "-q", "--hard", r.data.head], { cwd });
        setBase(cwd, r.data.base);
        return { data: { ...r.data, local: "updated to the verified resolution" }, hints: r.hints };
      }
      throw usage("weft room list | show <id> | log <id> | accept <id>");
    }
    case "leaderboard":
      return f.global ? api("GET", "/v1/leaderboard") : api("GET", `/v1/repos/${repoOf(f)}/leaderboard`);
    case "events":
      return api("GET", `/v1/repos/${repoOf(f)}/events?since=${intOf(f.since, "since") ?? 0}`);
    default:
      throw usage(`unknown command: ${cmd}`, "weft --help");
  }
};

// ------------------------------------------------------------ output

const isScalarList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null);
const render = (value: unknown, indent = ""): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (isScalarList(value)) return value.join(", ");
    return value.map((v) => `\n${indent}- ${render(v, `${indent}  `).replace(/^\n\s*/, "")}`).join("");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      const block = typeof v === "object" && v !== null && !isScalarList(v) && !(Array.isArray(v) && v.length === 0);
      return block ? `\n${indent}${k}:${render(v, `${indent}  `)}` : `\n${indent}${k}: ${render(v, indent)}`;
    })
    .join("");
};

const follow = async (repo: string, since: number, asJson: boolean): Promise<never> => {
  const url = `${remote().replace(/^http/, "ws")}/v1/repos/${repo}/ws`;
  const protocols = process.env.WEFT_TOKEN ? ["weft", process.env.WEFT_TOKEN] : ["weft"];
  const sock = new WebSocket(url, protocols);
  sock.addEventListener("open", () => sock.send(JSON.stringify({ t: "subscribe", since })));
  sock.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { t: string; event?: { seq: number; at: string; type: string; actor: string; data: unknown } };
    if (msg.t !== "event" || !msg.event) return;
    const e = msg.event;
    process.stdout.write(asJson ? `${JSON.stringify(e)}\n` : `${String(e.seq).padStart(5)} ${e.at.slice(11, 19)} ${e.type.padEnd(24)} ${e.actor.padEnd(16)} ${JSON.stringify(e.data)}\n`);
  });
  await new Promise<void>((_, reject) => {
    sock.addEventListener("close", () => reject(new WeftError("STREAM_CLOSED", "event stream closed", { retryable: true, exitCode: EXIT.busy })));
    sock.addEventListener("error", () => reject(new WeftError("STREAM_ERROR", "event stream error", { retryable: true, exitCode: EXIT.busy })));
  });
  throw new WeftError("STREAM_CLOSED", "event stream closed");
};

const main = async (argv: string[]): Promise<number> => {
  let command = "help";
  let asJson = !process.stdout.isTTY;
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const f = parsed.values as Flags;
    if (f.json) asJson = true;
    if (f.human) asJson = false;
    const [cmd, ...rest] = parsed.positionals;
    if (!cmd || f.help || cmd === "help") {
      process.stdout.write(HELP);
      return EXIT.ok;
    }
    command = cmd === "queue" && rest[0] === "run" ? "queue run" : cmd;
    if (cmd === "events" && f.follow) await follow(repoOf(f), intOf(f.since, "since") ?? 0, asJson);
    const res = await run(cmd, rest, f);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, command, data: res.data, hints: res.hints })}\n`);
    else {
      process.stdout.write(`${render(res.data).trimStart()}\n`);
      if (res.hints.length > 0) process.stdout.write(`\nnext:\n${res.hints.map((h) => `  ${h}`).join("\n")}\n`);
    }
    return EXIT.ok;
  } catch (err: unknown) {
    const e = toWeftError(err);
    const exitCode = e.exitCode !== EXIT.internal ? e.exitCode : exitFor(e.code);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, command, error: e.toJSON() })}\n`);
    else {
      process.stderr.write(`error ${e.code}: ${e.message}\n`);
      if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
      if (Object.keys(e.details).length > 0) process.stderr.write(`${render(e.details)}\n`);
    }
    return exitCode;
  }
};

process.exitCode = await main(process.argv.slice(2));
