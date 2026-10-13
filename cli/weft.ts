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
import { symbolsForWorktree } from "./symbols.ts";

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
  after: { type: "string" },
  driver: { type: "string", multiple: true },
  recipe: { type: "string" },
  import: { type: "string" },
  wait: { type: "boolean" },
  reason: { type: "string" },
  "changesets-per-day": { type: "string" },
  "cost-per-day": { type: "string" },
  "open-workspaces": { type: "string" },
  "wait-timeout": { type: "string" },
  branch: { type: "string" },
  arg: { type: "string", multiple: true },
  "recipe-def": { type: "string", multiple: true },
  continue: { type: "boolean" },
  abort: { type: "boolean" },
  by: { type: "string" },
  n: { type: "string", short: "n" },
  since: { type: "string" },
  follow: { type: "boolean" },
  global: { type: "boolean" },
  md: { type: "boolean" },
  budget: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string;
};

const HELP = `weft — coordination-first version control for many agents (Cloudflare)

Env: WEFT_REMOTE (default ${DEFAULT_REMOTE}), WEFT_TOKEN (agent token or admin token), WEFT_REPO

Admin
  weft init <repo> [--from DIR | --import https://github.com/owner/repo [--branch B]] [--check CMD] [--batch N] [--batch-window MS] [--sensitive GLOBS] [--union GLOBS] [--driver GLOB=DRIVER] [--no-judge]
                                      drivers: union · json-merge (3-way by key) · sorted-lines
  weft config [--check CMD] [--batch N] [--review-threshold N] [--sensitive GLOBS] [--no-judge]
  weft agent register --name NAME --model MODEL [--ttl-hours N]   weft agent show|kill|revive --name NAME
  weft agent budget --name NAME [--changesets-per-day N] [--cost-per-day USD] [--open-workspaces N]
  weft approve <cs> [--by NAME]       weft reject <cs> [--reason R]       weft revert <cs> [--by NAME]       weft queue run
  weft calibration [--repo R]         judge threshold sweep vs outcome labels (reverted, hotfixed, human-rejected)

Agent loop (inside a workspace dir, or --ws)
  weft start --task "..." --touch GLOB [--touch GLOB] [--exclusive] [--after cs-x] [--wait [--wait-timeout S]] [--dir PATH]
                                      --wait: queue fairly (FIFO) for a scope held under an exclusive lease (FR-10)
                                      --after: stack on a queued changeset (FR-27); --touch path#Symbol for symbol intents
  weft status                         heartbeat: touched, drift, live overlaps, forecast
  weft widen --touch GLOB
  weft checkpoint [-m MSG]            commit + push to your fork
  weft sync [--continue|--abort]      merge trunk in; conflicts name the peer changeset
  weft submit -m MSG [--prompt-file F] [--tool-calls N] [--cost USD] [--resolves cs-x] [--recipe NAME --arg X ...]
                                      --recipe: replay an admin-defined codemod on the newest trunk at landing (FR-25)
  weft abandon
  weft context [--md] [--budget TOKENS]  context pack: task, peers, rejections, recent landings, rules
  weft resume [<ws-id> --repo R --dir PATH]  re-acquire an expired workspace (or re-clone it elsewhere)

Read
  weft queue · weft show <cs> · weft scorecard <cs> · weft logs <cs> · weft log [-n N]
  weft who <path> · weft events [--since SEQ] [--follow] · weft leaderboard [--global]

Recipes (codemods replayed on the newest trunk instead of merging text)
  weft recipe list · weft recipe run <name> --arg X · weft submit --recipe <name> --arg X

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
  if (f["recipe-def"]) {
    // --recipe-def 'NAME=shell command using $1 $2 / $WEFT_ARG_1' (admin only)
    p.recipes = Object.fromEntries(f["recipe-def"].map((spec) => {
      const i = spec.indexOf("=");
      if (i <= 0) throw usage(`bad --recipe-def ${spec}`, "NAME=COMMAND");
      return [spec.slice(0, i), { command: spec.slice(i + 1) }];
    }));
  }
  if (f.driver) {
    p.drivers = f.driver.map((spec) => {
      const i = spec.lastIndexOf("=");
      const glob = spec.slice(0, i);
      const driver = spec.slice(i + 1);
      if (i <= 0 || !["union", "json-merge", "sorted-lines"].includes(driver)) throw usage(`bad --driver ${spec}`, "GLOB=union|json-merge|sorted-lines, e.g. --driver 'package.json=json-merge'");
      return { glob, driver };
    });
  }
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

/** FR-39: Weft's trunk is `main`. If an imported repo's default branch is another name, create `main` from it. */
const ensureMain = (remoteUrl: string, token: string, reportedDefault: string): string => {
  let defaultBranch = reportedDefault;
  const tok = token.split("?expires=")[0] ?? token;
  const heads = out(["ls-remote", "--heads", remoteUrl], { token: tok });
  const main = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(heads);
  if (main?.[1]) return main[1];
  const all = [...heads.matchAll(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/gm)].map((x) => ({ sha: x[1] ?? "", name: x[2] ?? "" }));
  const pick = all.find((h) => h.name === defaultBranch) ?? all.find((h) => h.name === "master") ?? (all.length === 1 ? all[0] : undefined);
  if (!pick) throw new WeftError("IMPORT_EMPTY", `imported repo has no ${defaultBranch} branch to use as trunk`, { hint: `pass --branch <name>; branches: ${all.map((h) => h.name).join(", ") || "(none)"}` });
  defaultBranch = pick.name;
  const src: [string, string] = ["", pick.sha];
  const tmp = mkdtempSync(join(tmpdir(), "weft-import-"));
  try {
    const gd = join(tmp, "g.git");
    git(["init", "-q", "--bare", gd]);
    git([`--git-dir=${gd}`, "fetch", "-q", remoteUrl, `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`], { token: tok });
    git([`--git-dir=${gd}`, "push", "-q", remoteUrl, `refs/heads/${defaultBranch}:refs/heads/main`], { token: tok });
    return src[1];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const run = async (cmd: string, pos: string[], f: Flags): Promise<Result> => {
  switch (cmd) {
    case "init": {
      const repo = pos[0];
      if (!repo) throw usage("weft init <repo> [--from DIR]");
      if (f.from && f.import) throw usage("use --from DIR or --import URL, not both");
      const r = await api<{ repo: string; remote: string; token: string; config: unknown; adopted: boolean; imported: { url: string; defaultBranch: string } | null }>("POST", "/v1/repos", {
        repo,
        config: configPatch(f),
        ...(f.import ? { import: { url: f.import, ...(f.branch ? { branch: f.branch } : {}) } } : {}),
      });
      let head: string | null = null;
      if (f.from) head = pushInitial(resolve(f.from), r.data.remote, r.data.token, repo);
      if (r.data.imported) head = ensureMain(r.data.remote, r.data.token, r.data.imported.defaultBranch);
      return { data: { repo, remote: r.data.remote, initialCommit: head, imported: r.data.imported, config: r.data.config, adopted: r.data.adopted }, hints: ["weft agent register --name <agent> --model <model>"] };
    }
    case "config":
      return api("PATCH", `/v1/repos/${repoOf(f)}/config`, configPatch(f));
    case "agent": {
      if (pos[0] === "register") {
        if (!f.name || !f.model) throw usage("weft agent register --name NAME --model MODEL");
        return api("POST", "/v1/agents", { name: f.name, model: f.model, ttlHours: intOf(f["ttl-hours"], "ttl-hours") });
      }
      if (pos[0] === "list") return api("GET", "/v1/agents");
      if (pos[0] === "show" || pos[0] === "kill" || pos[0] === "revive" || pos[0] === "budget") {
        if (!f.name) throw usage(`weft agent ${pos[0]} --name NAME`);
        const n = encodeURIComponent(f.name);
        if (pos[0] === "show") return api("GET", `/v1/agents/${n}`);
        if (pos[0] === "kill") return api("POST", `/v1/agents/${n}/kill`, { by: f.by ?? "admin" });
        if (pos[0] === "revive") return api("POST", `/v1/agents/${n}/revive`, {});
        return api("PATCH", `/v1/agents/${n}/budget`, {
          changesetsPerDay: intOf(f["changesets-per-day"], "changesets-per-day") ?? null,
          costUsdPerDay: f["cost-per-day"] !== undefined ? Number(f["cost-per-day"]) : null,
          openWorkspacesPerRepo: intOf(f["open-workspaces"], "open-workspaces") ?? null,
        });
      }
      throw usage("weft agent register|list|show|budget|kill|revive");
    }
    case "start": {
      const repo = repoOf(f);
      if (!f.task) throw usage('weft start needs --task "..."');
      type Started = {
        workspace: { id: string; branch: string; baseCommit: string };
        stackedOn: { changeset: string; branch: string; head: string } | null;
        forecast: unknown;
        fork: Tok;
        trunk: Tok & { head: string };
      };
      type Waiting = { waiting: true; position: number; ahead: { agentName: string; task: string }[] };
      const body = { task: f.task, touch: f.touch ?? [], mode: f.exclusive ? "exclusive" : "soft", after: f.after ?? null, wait: f.wait === true };
      // FR-10: with --wait, hold a FIFO ticket for the scope and poll (backoff + jitter) until it is ours.
      const deadline = Date.now() + (intOf(f["wait-timeout"], "wait-timeout") ?? 600) * 1000;
      let r = await api<Started | Waiting>("POST", `/v1/repos/${repo}/workspaces`, body);
      for (let i = 1; "waiting" in r.data; i += 1) {
        if (Date.now() > deadline) {
          throw new WeftError("WAIT_TIMEOUT", `still waiting for the scope (#${r.data.position} in line)`, { exitCode: EXIT.busy, retryable: true, hint: "weft start --wait again to keep your place", details: { ahead: r.data.ahead } });
        }
        if (process.stderr.isTTY || process.env.WEFT_VERBOSE) process.stderr.write(`waiting: #${r.data.position} in line${r.data.ahead.length ? ` (after ${r.data.ahead.map((a) => a.agentName).join(", ")})` : ""}\n`);
        const cap = Math.min(10_000, 1_000 * 2 ** Math.min(i, 4));
        await new Promise((res) => setTimeout(res, cap / 2 + Math.random() * (cap / 2)));
        r = await api<Started | Waiting>("POST", `/v1/repos/${repo}/workspaces`, body);
      }
      const started = r as { data: Started; hints: string[] };
      const ws = started.data.workspace;
      const dir = resolve(f.dir ?? ws.id);
      git(["clone", "-q", started.data.fork.remote, dir], { token: started.data.fork.token });
      git(["remote", "add", "trunk", started.data.trunk.remote], { cwd: dir });
      if (started.data.stackedOn) {
        // FR-27: the fork was forked from the parent's fork, so the parent's branch is here; build on its head.
        const p = started.data.stackedOn;
        git(["fetch", "-q", "origin", `+refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`], { cwd: dir, token: started.data.fork.token });
        git(["checkout", "-q", "-B", ws.branch, p.head], { cwd: dir });
      } else {
        git(["checkout", "-q", "-B", ws.branch], { cwd: dir });
      }
      git(["config", "user.name", process.env.WEFT_AGENT_NAME ?? ws.id.split("-").slice(2).join("-")], { cwd: dir });
      git(["config", "user.email", `${ws.id}@agents.weft.dev`], { cwd: dir });
      git(["config", "weft.repo", repo], { cwd: dir });
      git(["config", "weft.ws", ws.id], { cwd: dir });
      setBase(dir, ws.baseCommit);
      saveWs(dir, { repo, ws: ws.id, branch: ws.branch, fork: started.data.fork, trunk: started.data.trunk });
      const data = { ...started.data, fork: { remote: started.data.fork.remote, expiresAt: started.data.fork.expiresAt }, trunk: { remote: started.data.trunk.remote, head: started.data.trunk.head }, path: dir };
      return { data, hints: [`cd ${dir}`, ...started.hints] };
    }
    case "status": {
      const { cwd, w: w0 } = loadWs(f);
      const w = await fresh(cwd, w0);
      const touched = touchedFiles(cwd);
      const trunkHead = fetchTrunk(cwd, w);
      const b = base(cwd);
      const behind = Number(out(["rev-list", "--count", `${b}..${trunkHead}`], { cwd }));
      const trunkChanged = lines(out(["diff", "--name-only", b, trunkHead], { cwd }));
      const symbols = await symbolsForWorktree(cwd, b, touched);
      const r = await api<Record<string, unknown>>("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/heartbeat`, { touched, symbols });
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
      const touched = touchedFiles(cwd);
      await api("POST", `/v1/repos/${w.repo}/workspaces/${w.ws}/heartbeat`, { touched, symbols: await symbolsForWorktree(cwd, base(cwd), touched) });
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
        recipe: f.recipe ? { name: f.recipe, args: f.arg ?? [] } : null,
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
    case "reject":
      if (!pos[0]) throw usage("weft reject <cs> [--reason TEXT] [--by NAME]");
      return api("POST", `/v1/repos/${repoOf(f)}/changesets/${pos[0]}/reject`, { by: f.by ?? "admin", reason: f.reason ?? "rejected in review" });
    case "calibration":
      return api("GET", `/v1/calibration${f.repo ? `?repo=${encodeURIComponent(f.repo)}` : ""}`);
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
    case "context": {
      const { w } = loadWs(f);
      const budget = intOf(f.budget, "budget") ?? 6000;
      if (f.md) {
        const r = await api<{ markdown: string }>("GET", `/v1/repos/${w.repo}/workspaces/${w.ws}/context?format=md&budget=${budget}`);
        return { data: r.data.markdown, hints: [] };
      }
      return api("GET", `/v1/repos/${w.repo}/workspaces/${w.ws}/context?budget=${budget}`);
    }
    case "resume": {
      // In a workspace checkout: renew the lease + tokens. Elsewhere (`weft resume <ws> --repo R`): re-clone it.
      const target = pos[0];
      const inside = !target && git(["rev-parse", "--is-inside-work-tree"], { cwd: f.dir ? resolve(f.dir) : process.cwd(), allow: [128] }).code === 0;
      const repo = inside ? loadWs(f).w.repo : repoOf(f);
      const wsId = inside ? loadWs(f).w.ws : target;
      if (!wsId) throw usage("weft resume (inside a workspace) | weft resume <ws-id> --repo R [--dir PATH]");
      const r = await api<{ workspace: { id: string; branch: string; baseCommit: string }; wasExpired: boolean; forecast: unknown; fork: Tok; trunk: Tok & { head: string } }>("POST", `/v1/repos/${repo}/workspaces/${wsId}/resume`, {});
      let dir: string;
      if (inside) {
        const { cwd, w } = loadWs(f);
        saveWs(cwd, { ...w, fork: r.data.fork, trunk: r.data.trunk });
        dir = cwd;
      } else {
        dir = resolve(f.dir ?? wsId);
        git(["clone", "-q", r.data.fork.remote, dir], { token: r.data.fork.token });
        // The workspace branch exists on the fork once the agent has pushed (checkpoint/submit); before that,
        // the work starts again from the workspace base.
        const hasBranch = git(["ls-remote", "--exit-code", "--heads", "origin", r.data.workspace.branch], { cwd: dir, token: r.data.fork.token, allow: [2] }).code === 0;
        if (hasBranch) {
          git(["fetch", "-q", "origin", `+refs/heads/${r.data.workspace.branch}:refs/remotes/origin/${r.data.workspace.branch}`], { cwd: dir, token: r.data.fork.token });
          git(["checkout", "-q", "-B", r.data.workspace.branch, `origin/${r.data.workspace.branch}`], { cwd: dir });
        } else {
          git(["checkout", "-q", "-B", r.data.workspace.branch, r.data.workspace.baseCommit], { cwd: dir });
        }
        git(["remote", "add", "trunk", r.data.trunk.remote], { cwd: dir });
        git(["config", "user.name", process.env.WEFT_AGENT_NAME ?? wsId.split("-").slice(2).join("-")], { cwd: dir });
        git(["config", "user.email", `${wsId}@agents.weft.dev`], { cwd: dir });
        git(["config", "weft.repo", repo], { cwd: dir });
        git(["config", "weft.ws", wsId], { cwd: dir });
        setBase(dir, r.data.workspace.baseCommit);
        saveWs(dir, { repo, ws: wsId, branch: r.data.workspace.branch, fork: r.data.fork, trunk: r.data.trunk });
      }
      return { data: { workspace: r.data.workspace, wasExpired: r.data.wasExpired, forecast: r.data.forecast, path: dir }, hints: [`cd ${dir}`, "weft context --md  # what happened while you were away", ...r.hints] };
    }
    case "recipe": {
      // FR-25: run an admin-defined recipe locally exactly as the merge-runner replays it at landing.
      const repo = repoOf(f);
      const snap = await api<{ config: { recipes?: Record<string, { command: string; description?: string }> } }>("GET", `/v1/repos/${repo}/snapshot`);
      const recipes = snap.data.config.recipes ?? {};
      if (!pos[0] || pos[0] === "list") return { data: recipes, hints: ["weft recipe run <name> --arg X  # then: weft submit --recipe <name> --arg X"] };
      if (pos[0] !== "run" || !pos[1]) throw usage("weft recipe list | weft recipe run <name> --arg X [--arg Y]");
      const def = recipes[pos[1]];
      if (!def) throw usage(`unknown recipe: ${pos[1]}`, `available: ${Object.keys(recipes).join(", ") || "none"}`);
      const args = f.arg ?? [];
      const bad = args.find((x) => !/^[A-Za-z0-9_.\/@:+=,-]{1,200}$/.test(x));
      if (bad !== undefined) throw usage(`recipe argument not allowed: ${bad}`);
      const { cwd } = loadWs(f);
      const env: Record<string, string> = { ...process.env as Record<string, string>, CI: "1" };
      args.forEach((x, i) => (env[`WEFT_ARG_${i + 1}`] = x));
      const r = spawnSync("sh", ["-c", def.command, "weft-recipe", ...args], { cwd, encoding: "utf8", env, timeout: TIMEOUT_MS });
      if (r.status !== 0) throw new WeftError("RECIPE_FAILED", `recipe ${pos[1]} exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`, { exitCode: EXIT.checkFailed });
      const changed = touchedFiles(cwd);
      return { data: { recipe: pos[1], args, changed }, hints: [`weft submit -m "..." --recipe ${pos[1]}${args.map((x) => ` --arg ${x}`).join("")}  # replayed on the newest trunk at landing`] };
    }
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
