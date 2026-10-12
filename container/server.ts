// weft merge-runner — the only process that writes trunk. Runs inside a Cloudflare Container
// (one instance per repo, addressed by getContainer(env.MERGE_RUNNER, repo)).
// Port of prototype/cli/src/queue.ts with git I/O against Artifacts remotes.
//
// Credentials arrive per request, are passed to git with `-c http.extraHeader`, and are never
// written to disk, config, logs or the process environment.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFiles, scanAddedLines } from "../src/core/rubric.ts";
import type { BatchMember, ConflictPeer, DiffStats, Rejection, SpeculationResult } from "../src/core/types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = "/srv/repos";
const GIT_TIMEOUT_MS = 600_000;
const CHECK_TIMEOUT_MS = 600_000;
const DIFF_BUDGET = 48_000;

class RunnerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, status = 500, retryable = false, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const redact = (s: string): string => s.replace(/Bearer [A-Za-z0-9_\-.?=]+/g, "Bearer <redacted>").replace(/art_v1_[0-9a-f]+/g, "art_v1_<redacted>");

const run = (cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string>; timeoutMs?: number; allow?: number[] } = {}): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 1_000_000) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new RunnerError("SPAWN_FAILED", `${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const r = { code: code ?? -1, stdout, stderr };
      if (r.code !== 0 && !(opts.allow ?? []).includes(r.code)) {
        reject(new RunnerError("GIT_FAILED", redact(`${cmd} ${args.filter((a) => !a.includes("Bearer")).slice(0, 4).join(" ")} exited ${r.code}: ${stderr.slice(0, 600)}`)));
      } else resolve(r);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

const git = (gitDir: string, args: string[], opts: { input?: string; env?: Record<string, string>; allow?: number[]; token?: string } = {}): Promise<Run> => {
  const auth = opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token.split("?expires=")[0] ?? opts.token}`] : [];
  return run("git", [...auth, `--git-dir=${gitDir}`, ...args], opts);
};

const out = async (gitDir: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> =>
  (await git(gitDir, args, opts)).stdout.trim();

const lines = (t: string): string[] => t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

// ---------------------------------------------------------------- repo cache

const repoDir = async (trunkRemote: string): Promise<string> => {
  const dir = join(ROOT, `${createHash("sha1").update(trunkRemote).digest("hex").slice(0, 16)}.git`);
  if (!existsSync(dir)) {
    mkdirSync(ROOT, { recursive: true });
    await run("git", ["init", "-q", "--bare", "-b", "main", dir]);
  }
  return dir;
};

const writeAttributes = (gitDir: string, unionGlobs: string[]): void => {
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "attributes"), unionGlobs.map((g) => `${g} merge=union\n`).join(""));
};

const hasObject = async (gitDir: string, sha: string): Promise<boolean> =>
  (await git(gitDir, ["cat-file", "-e", `${sha}^{commit}`], { allow: [1, 128] })).code === 0;

interface TrunkRef {
  remote: string;
  token: string;
}

interface ForkRef {
  id: string;
  forkRemote: string;
  forkToken: string;
  branch: string;
  headCommit: string;
}

const fetchTrunk = async (gitDir: string, trunk: TrunkRef, trunkHead: string): Promise<void> => {
  if (!(await hasObject(gitDir, trunkHead))) {
    await git(gitDir, ["fetch", "-q", trunk.remote, "+refs/heads/main:refs/weft/trunk"], { token: trunk.token });
  }
  if (!(await hasObject(gitDir, trunkHead))) {
    throw new RunnerError("TRUNK_MOVED", `trunk head ${trunkHead} not found on remote`, 409, true);
  }
};

const fetchFork = async (gitDir: string, m: ForkRef): Promise<void> => {
  if (await hasObject(gitDir, m.headCommit)) return;
  await git(gitDir, ["fetch", "-q", m.forkRemote, `+refs/heads/${m.branch}:refs/weft/cs/${m.id}`], { token: m.forkToken });
  if (!(await hasObject(gitDir, m.headCommit))) {
    throw new RunnerError("HEAD_MISSING", `changeset ${m.id}: head ${m.headCommit} not on its fork branch ${m.branch}`, 409, false, { csId: m.id });
  }
};

// ---------------------------------------------------------------- prepare: authoritative diffs for the judge

const prepare = async (body: { trunk: TrunkRef; trunkHead: string; members: ForkRef[] }): Promise<{ stats: Record<string, DiffStats> }> => {
  const gitDir = await repoDir(body.trunk.remote);
  await fetchTrunk(gitDir, body.trunk, body.trunkHead);
  const stats: Record<string, DiffStats> = {};
  let budget = DIFF_BUDGET * Math.max(1, body.members.length);
  for (const m of body.members) {
    await fetchFork(gitDir, m);
    const base = await out(gitDir, ["merge-base", body.trunkHead, m.headCommit]);
    const files = lines(await out(gitDir, ["diff", "--name-only", base, m.headCommit]));
    let added = 0;
    let deleted = 0;
    for (const row of lines(await out(gitDir, ["diff", "--numstat", base, m.headCommit]))) {
      const [a = "0", d = "0"] = row.split("\t");
      added += Number.isNaN(Number(a)) ? 0 : Number(a);
      deleted += Number.isNaN(Number(d)) ? 0 : Number(d);
    }
    const full = (await git(gitDir, ["diff", "--no-color", "--unified=3", base, m.headCommit])).stdout;
    const cap = Math.min(DIFF_BUDGET, budget);
    budget -= Math.min(full.length, cap);
    const { testFiles, sourceFiles } = classifyFiles(files);
    stats[m.id] = {
      files,
      added,
      deleted,
      testFiles,
      sourceFiles,
      secretFindings: scanAddedLines(full),
      diffText: full.slice(0, cap),
      truncated: full.length > cap,
    };
  }
  return { stats };
};

// ---------------------------------------------------------------- speculate: merge chain, check, bisect

interface SpecInput {
  trunk: TrunkRef;
  trunkHead: string;
  claimTime: number;
  checkCommand: string | null;
  unionGlobs: string[];
  members: (BatchMember & { forkToken: string })[];
}

interface Applied {
  m: BatchMember;
  commit: string;
  tree: string;
}

const commitEnv = (claimTime: number, authorName: string, authorEmail: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: authorName,
  GIT_AUTHOR_EMAIL: authorEmail,
  GIT_AUTHOR_DATE: `@${claimTime} +0000`,
  GIT_COMMITTER_NAME: "weft-merge-queue",
  GIT_COMMITTER_EMAIL: "queue@weft.dev",
  GIT_COMMITTER_DATE: `@${claimTime} +0000`,
});

const mergeTree = async (gitDir: string, base: string, ours: string, theirs: string): Promise<{ clean: boolean; tree: string; files: string[] }> => {
  const r = await git(gitDir, ["merge-tree", "--write-tree", "--name-only", `--merge-base=${base}`, ours, theirs], { allow: [1] });
  const [head, ...rest] = r.stdout.split("\n");
  const tree = (head ?? "").trim();
  if (r.code === 0) return { clean: true, tree, files: [] };
  const blank = rest.findIndex((l) => l.trim() === "");
  return { clean: false, tree, files: [...new Set(lines((blank === -1 ? rest : rest.slice(0, blank)).join("\n")))] };
};

const buildChain = async (gitDir: string, start: string, members: BatchMember[], claimTime: number) => {
  let tip = start;
  const applied: Applied[] = [];
  const conflicts: { m: BatchMember; files: string[]; peers: ConflictPeer[] }[] = [];
  for (const m of members) {
    const base = await out(gitDir, ["merge-base", tip, m.headCommit]);
    const merged = await mergeTree(gitDir, base, tip, m.headCommit);
    if (!merged.clean) {
      const peers: ConflictPeer[] = applied
        .map((a) => ({
          changesetId: a.m.id,
          agentId: a.m.agentId,
          agentName: a.m.agentName,
          workspaceId: a.m.wsId,
          commit: a.commit,
          files: merged.files.filter((f) => a.m.filesTouched.includes(f)),
        }))
        .filter((p) => p.files.length > 0);
      conflicts.push({ m, files: merged.files, peers });
      continue;
    }
    const msg = `${m.message}\n\n${m.trailers.join("\n")}\n`;
    const commit = await out(gitDir, ["commit-tree", merged.tree, "-p", tip, "-F", "-"], {
      input: msg,
      env: commitEnv(claimTime, m.agentName, `${m.agentId}@agents.weft.dev`),
    });
    applied.push({ m, commit, tree: merged.tree });
    tip = commit;
  }
  return { tip, applied, conflicts };
};

interface CheckOutcome {
  pass: boolean;
  text: string;
}

const runCheck = async (gitDir: string, commit: string, command: string): Promise<CheckOutcome> => {
  const dir = mkdtempSync(join(tmpdir(), "weft-check-"));
  try {
    const archive = await run("sh", ["-c", 'git --git-dir="$1" archive "$2" | tar -x -C "$3"', "sh", gitDir, commit, dir]);
    if (archive.code !== 0) throw new RunnerError("CHECKOUT_FAILED", `could not materialize ${commit}`);
    const r = await run("sh", ["-c", command], { cwd: dir, env: { WEFT_COMMIT: commit, CI: "1" }, timeoutMs: CHECK_TIMEOUT_MS, allow: Array.from({ length: 256 }, (_, i) => i).concat([-1]) });
    return { pass: r.code === 0, text: `$ ${command}\n# commit ${commit}\n${r.stdout}${r.stderr}\n# exit ${r.code}\n`.slice(0, 200_000) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const speculate = async (body: SpecInput): Promise<SpeculationResult> => {
  const gitDir = await repoDir(body.trunk.remote);
  writeAttributes(gitDir, body.unionGlobs);
  await fetchTrunk(gitDir, body.trunk, body.trunkHead);
  for (const m of body.members) await fetchFork(gitDir, m);

  const cache = new Map<string, CheckOutcome>();
  const logs: { commit: string; text: string }[] = [];
  let checksRun = 0;
  const check = async (commit: string, tree: string): Promise<CheckOutcome> => {
    if (!body.checkCommand) return { pass: true, text: "" };
    const hit = cache.get(tree);
    if (hit) return hit;
    checksRun += 1;
    const res = await runCheck(gitDir, commit, body.checkCommand);
    cache.set(tree, res);
    logs.push({ commit, text: res.text });
    return res;
  };

  const trunkTree = await out(gitDir, ["rev-parse", `${body.trunkHead}^{tree}`]);
  if (body.checkCommand && !(await check(body.trunkHead, trunkTree)).pass) {
    throw new RunnerError("TRUNK_RED", "the check fails on trunk itself; refusing to blame changesets", 409, false, {
      trunkHead: body.trunkHead,
      log: logs[0]?.text.slice(-2000) ?? "",
    });
  }

  const rejected: SpeculationResult["rejected"] = [];
  const checkPassed: Record<string, boolean> = {};
  let candidates: BatchMember[] = [...body.members];
  let bisectSteps = 0;
  for (;;) {
    const chain = await buildChain(gitDir, body.trunkHead, candidates, body.claimTime);
    for (const c of chain.conflicts) {
      const rejection: Rejection = {
        reason: "conflict",
        detail: `conflicts with trunk or earlier changesets in ${c.files.length} file(s)`,
        files: c.files,
        conflictsWith: c.peers,
        logKey: null,
      };
      rejected.push({ id: c.m.id, rejection });
    }
    candidates = chain.applied.map((a) => a.m);
    const last = chain.applied[chain.applied.length - 1];
    if (!last) return { tip: body.trunkHead, applied: [], rejected, checkPassed, checksRun, bisectSteps, logs };
    const tipOutcome = await check(last.commit, last.tree);
    if (tipOutcome.pass) {
      for (const a of chain.applied) checkPassed[a.m.id] = true;
      return { tip: chain.tip, applied: chain.applied.map((a) => ({ id: a.m.id, commit: a.commit, tree: a.tree })), rejected, checkPassed, checksRun, bisectSteps, logs };
    }
    let lo = 1;
    let hi = chain.applied.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = chain.applied[mid - 1];
      if (!probe) break;
      bisectSteps += 1;
      if ((await check(probe.commit, probe.tree)).pass) lo = mid + 1;
      else hi = mid;
    }
    const culprit = chain.applied[lo - 1];
    if (!culprit) throw new RunnerError("BISECT_LOST", "bisection lost its culprit");
    const outcome = await check(culprit.commit, culprit.tree);
    checkPassed[culprit.m.id] = false;
    rejected.push({
      id: culprit.m.id,
      rejection: {
        reason: "check_failed",
        detail: `check failed on the merged result (bisected in ${bisectSteps} step(s)): ${outcome.text.slice(-500)}`,
        files: culprit.m.filesTouched,
        conflictsWith: [],
        logKey: `commit:${culprit.commit}`,
      },
    });
    candidates = candidates.filter((c) => c.id !== culprit.m.id);
  }
};

// ---------------------------------------------------------------- push / revert

const push = async (body: { trunk: TrunkRef & { writeToken: string }; expectedOld: string; tip: string; rebuild: SpecInput }): Promise<{ pushed: true; tip: string }> => {
  const gitDir = await repoDir(body.trunk.remote);
  if (!(await hasObject(gitDir, body.tip))) {
    // Container restarted between steps: deterministic dates make the rebuild byte-identical.
    const again = await speculate(body.rebuild);
    if (again.tip !== body.tip) throw new RunnerError("TIP_DIVERGED", `rebuild produced ${again.tip}, expected ${body.tip}`, 409, true);
  }
  const r = await git(gitDir, ["push", "--porcelain", body.trunk.remote, `${body.tip}:refs/heads/main`, `--force-with-lease=main:${body.expectedOld}`], {
    token: body.trunk.writeToken,
    allow: [1],
  });
  if (r.code !== 0) throw new RunnerError("TRUNK_MOVED", `push rejected: ${redact(r.stderr || r.stdout).slice(0, 400)}`, 409, true);
  return { pushed: true, tip: body.tip };
};

const revert = async (body: {
  trunk: TrunkRef & { writeToken: string };
  trunkHead: string;
  landedCommit: string;
  message: string;
  actor: string;
  claimTime: number;
}): Promise<{ commit: string }> => {
  const gitDir = await repoDir(body.trunk.remote);
  await fetchTrunk(gitDir, body.trunk, body.trunkHead);
  if (!(await hasObject(gitDir, body.landedCommit))) throw new RunnerError("NOT_FOUND", `commit ${body.landedCommit} not on trunk`, 404);
  const merged = await mergeTree(gitDir, body.landedCommit, body.trunkHead, `${body.landedCommit}^`);
  if (!merged.clean) throw new RunnerError("REVERT_CONFLICT", "later trunk commits depend on this changeset", 409, false, { files: merged.files });
  const commit = await out(gitDir, ["commit-tree", merged.tree, "-p", body.trunkHead, "-F", "-"], {
    input: body.message,
    env: commitEnv(body.claimTime, body.actor, "revert@weft.dev"),
  });
  const r = await git(gitDir, ["push", "--porcelain", body.trunk.remote, `${commit}:refs/heads/main`, `--force-with-lease=main:${body.trunkHead}`], {
    token: body.trunk.writeToken,
    allow: [1],
  });
  if (r.code !== 0) throw new RunnerError("TRUNK_MOVED", "trunk moved; retry the revert", 409, true);
  return { commit };
};

// ---------------------------------------------------------------- http

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 32_000_000) reject(new RunnerError("TOO_LARGE", "request body too large", 413));
    });
    req.on("end", () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err: unknown) {
        reject(new RunnerError("BAD_JSON", `invalid JSON: ${String(err)}`, 400));
      }
    });
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// One repo per container instance and one batch at a time: serialize all mutating work.
let chain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://runner");
  if (req.method === "GET" && url.pathname === "/healthz") {
    run("git", ["--version"]).then(
      (r) => send(res, 200, { ok: true, git: r.stdout.trim() }),
      (err: unknown) => send(res, 500, { ok: false, error: { code: "GIT_MISSING", message: String(err) } }),
    );
    return;
  }
  const routes: Record<string, (b: never) => Promise<unknown>> = {
    "/prepare": prepare as (b: never) => Promise<unknown>,
    "/speculate": speculate as (b: never) => Promise<unknown>,
    "/push": push as (b: never) => Promise<unknown>,
    "/revert": revert as (b: never) => Promise<unknown>,
  };
  const handler = req.method === "POST" ? routes[url.pathname] : undefined;
  if (!handler) {
    send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
    return;
  }
  const started = Date.now();
  readJson(req)
    .then((body) => serialized(() => handler(body as never)))
    .then((data) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "runner.ok", path: url.pathname, ms: Date.now() - started }));
      send(res, 200, { ok: true, data });
    })
    .catch((err: unknown) => {
      const e = err instanceof RunnerError ? err : new RunnerError("INTERNAL", err instanceof Error ? err.message : String(err));
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "runner.error", path: url.pathname, code: e.code, message: redact(e.message) }));
      send(res, e.status, { ok: false, error: { code: e.code, message: redact(e.message), retryable: e.retryable, details: e.details } });
    });
}).listen(PORT, () => console.log(JSON.stringify({ level: "info", msg: "weft merge-runner listening", port: PORT })));
