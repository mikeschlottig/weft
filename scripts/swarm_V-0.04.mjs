#!/usr/bin/env node
// D9: synthetic swarm — exit evidence for PRD §9 milestones, measured on a live deployment. (V-0.02: --stealth; V-0.03: exact drain + counts at any scale; V-0.04: duplicate-landing check)
//
//   node scripts/swarm_V-0.02.mjs --agents 24 --pairs 8 [--stealth] [--modules 64] [--pool 24] [--batch 8] [--lanes 2] [--repo R]
//
// --stealth: each colliding pair DECLARES two different private modules but both edit a third, shared module
// (out of intent). No intent overlaps, so any warning must come from the heartbeat's touched files — this
// measures whether the forecast catches collisions the agents did not declare.
//
// Every agent is a real `weft` CLI client: it registers, starts a workspace (an Artifacts fork + local clone),
// edits its module, sends a heartbeat, and submits. `--pairs K` makes K pairs of agents edit the SAME line of the
// same module differently (a guaranteed textual conflict); everyone else edits a module of their own.
//
// Measured (never estimated), written to $RUN_DIR/swarm-metrics.json:
//   M1 peak concurrent live workspaces (sampled from the coordinator's /v1/limits usage);
//   M2 collision catch rate  = conflict-rejected changesets whose agent was warned BEFORE submitting
//                              (start forecast ≥ medium, or a workspace.alert naming it) / all conflict rejections;
//      resolver green rate   = Conflict Rooms that reached a check-verified proposal / rooms opened;
//   M3 trunk red rate        = trunk commits on which the repo check fails when re-run independently afterwards
//                              (an observer clones the final trunk and runs the check on every commit) / commits.
//   duplicate landings       = changeset ids whose `Weft-Changeset` trailer appears on more than one trunk commit
//                              (must be 0: a changeset lands exactly once, whatever fails in between).
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli", "weft.ts");
const { values: o } = parseArgs({
  options: {
    agents: { type: "string", default: "24" },
    pairs: { type: "string", default: "8" },
    modules: { type: "string" },
    pool: { type: "string", default: "24" },
    batch: { type: "string", default: "8" },
    lanes: { type: "string", default: "2" },
    repo: { type: "string" },
    "accept-rooms": { type: "boolean", default: true },
    "drain-timeout": { type: "string", default: "3600" },
    stealth: { type: "boolean", default: false },
  },
});
const N = Number(o.agents);
const PAIRS = Math.min(Number(o.pairs), Math.floor(N / 2));
const STEALTH = o.stealth === true;
const MODULES = Number(o.modules ?? Math.max(N + (STEALTH ? PAIRS * 2 : 0), 8));
const POOL = Number(o.pool);
const REMOTE = (process.env.WEFT_REMOTE ?? "https://weft-dev.ceo-a53.workers.dev").replace(/\/$/, "");
const ADMIN = process.env.WEFT_ADMIN_TOKEN;
if (!ADMIN) throw new Error("set WEFT_ADMIN_TOKEN");
const REPO = o.repo ?? `swarm${N}-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "")}`;
const WORK = mkdtempSync(join(tmpdir(), "weft-swarm-"));
const OUT = process.env.RUN_DIR ?? WORK;
const CHECK = "node --test test/*.test.js";
const t0 = Date.now();
const log = (msg, extra = {}) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), msg, ...extra }));

/** Run the CLI; resolves with the parsed JSON envelope (the CLI prints one even on errors). Retries transport-level failures. */
const weft = (args, { token, cwd } = {}) =>
  new Promise((res) => {
    const attempt = (n) =>
      execFile(process.execPath, [CLI, ...args, "--json"], { cwd: cwd ?? WORK, env: { ...process.env, WEFT_REMOTE: REMOTE, WEFT_REPO: REPO, WEFT_TOKEN: token ?? ADMIN }, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => {
        let env = null;
        try {
          env = JSON.parse(stdout);
        } catch {
          env = { ok: false, error: { code: "CLI_OUTPUT", message: `${String(err ?? "")} ${stderr.slice(-400)}`, retryable: true } };
        }
        if (!env.ok && env.error?.retryable && n < 4) {
          const wait = Math.min(15_000, 1000 * 2 ** n) * (0.5 + Math.random());
          setTimeout(() => attempt(n + 1), wait);
          return;
        }
        res(env);
      });
    attempt(0);
  });

const api = async (path) => {
  for (let n = 0; ; n += 1) {
    try {
      const r = await fetch(`${REMOTE}${path}`, { headers: { authorization: `Bearer ${ADMIN}` }, signal: AbortSignal.timeout(60_000) });
      const j = await r.json();
      if (j.ok) return j.data;
      if (n >= 3) throw new Error(`${path}: ${j.error?.code} ${j.error?.message}`);
    } catch (err) {
      if (n >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n * (0.5 + Math.random())));
  }
};

const pool = async (items, size, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
};

const pad = (n) => String(n).padStart(3, "0");

// ---------------------------------------------------------------- fixture: MODULES small modules, one test file
const fixture = join(WORK, "fixture");
mkdirSync(join(fixture, "src"), { recursive: true });
mkdirSync(join(fixture, "test"), { recursive: true });
writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "swarm", type: "module", private: true }) + "\n");
writeFileSync(join(fixture, "CHANGELOG.md"), "# Changelog\n");
for (let m = 1; m <= MODULES; m += 1) writeFileSync(join(fixture, "src", `mod-${pad(m)}.js`), `// module ${m}\nexport const f = (x) => x + ${m};\nexport const id = ${m};\n`);
writeFileSync(
  join(fixture, "test", "all.test.js"),
  `import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
for (const file of readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".js"))) {
  test(file, async () => {
    const m = await import(new URL("../src/" + file, import.meta.url));
    assert.equal(m.f(0), m.id, file + ": f(0) must equal id");
  });
}
`,
);

// ---------------------------------------------------------------- plan: who edits what
// Pair k (k < PAIRS): agents 2k and 2k+1 both edit module k+1's `f` line differently. Others: their own module.
const plan = Array.from({ length: N }, (_, i) => {
  const paired = i < PAIRS * 2;
  const mod = paired ? Math.floor(i / 2) + 1 : PAIRS + (i - PAIRS * 2) + 1;
  // stealth: a paired agent declares its own private module (top of the range) but edits the shared one.
  const declared = STEALTH && paired ? MODULES - i : mod;
  return { i, name: `sw${pad(i)}x${Date.now().toString(36).slice(-4)}`, mod: ((mod - 1) % MODULES) + 1, declared, paired, dir: join(WORK, `a${pad(i)}`) };
});

const main = async () => {
  log("swarm", { repo: REPO, agents: N, pairs: PAIRS, stealth: STEALTH, modules: MODULES, remote: REMOTE, work: WORK });
  const init = await weft(["init", REPO, "--from", fixture, "--check", CHECK, "--batch", o.batch, "--batch-window", "1500", "--union", "CHANGELOG.md", "--no-judge"]);
  if (!init.ok) throw new Error(`init: ${JSON.stringify(init.error)}`);
  await fetch(`${REMOTE}/v1/repos/${REPO}/config`, { method: "PATCH", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ lanes: Number(o.lanes) }) });
  log("repo", { shard: init.data.shard, remote: init.data.remote });

  // M1: sample live workspaces from the coordinator while the swarm runs.
  let peakLive = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const l = await api(`/v1/limits?repo=${REPO}`);
        peakLive = Math.max(peakLive, l.repo?.usage?.workspacesLive ?? 0);
      } catch (err) {
        log("sample failed", { err: String(err) });
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();

  // 1. register (long-lived grant: a large swarm can outlive a 1 h token; recorded in token_grants)
  await pool(plan, 16, async (a) => {
    const r = await weft(["agent", "register", "--name", a.name, "--model", a.i % 3 === 0 ? "claude-opus-5-5" : a.i % 3 === 1 ? "claude-sonnet-5-5" : "claude-haiku-5-5", "--ttl-hours", "4", "--long-lived"]);
    if (!r.ok) throw new Error(`register ${a.name}: ${JSON.stringify(r.error)}`);
    a.token = r.data.token;
  });
  log("registered", { agents: N });

  // 2. start: every agent opens a workspace (fork + clone) — all live at once
  const tStart = Date.now();
  await pool(plan, POOL, async (a) => {
    const r = await weft(["start", "--task", `${a.paired ? "rework" : "tune"} module ${a.mod} (${a.name})`, "--touch", `src/mod-${pad(a.declared)}.js`, "--touch", "CHANGELOG.md", "--dir", a.dir], { token: a.token });
    a.started = r.ok;
    a.startRisk = r.ok ? r.data.forecast?.risk ?? "none" : null;
    if (!r.ok) log("start failed", { agent: a.name, err: r.error });
  });
  log("started", { ok: plan.filter((a) => a.started).length, s: Math.round((Date.now() - tStart) / 1000) });

  // 3. edit + heartbeat (the heartbeat reports touched files → live collision alerts)
  await pool(plan.filter((a) => a.started), POOL, async (a) => {
    const file = join(a.dir, "src", `mod-${pad(a.mod)}.js`);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/^export const f = \(x\) => x \+ (\d+);.*$/m, `export const f = (x) => x + $1; // tuned by ${a.name}`));
    writeFileSync(join(a.dir, "CHANGELOG.md"), readFileSync(join(a.dir, "CHANGELOG.md"), "utf8") + `- module ${a.mod}: tuned (${a.name})\n`);
    const r = await weft(["status"], { token: a.token, cwd: a.dir });
    a.statusRisk = r.ok ? r.data.forecast?.risk ?? null : null;
  });
  const seqBeforeSubmit = (await api(`/v1/repos/${REPO}/events?since=0`)).reduce((m, e) => Math.max(m, e.seq), 0);
  log("edited", { seqBeforeSubmit });

  // 4. submit (all at once)
  await pool(plan.filter((a) => a.started), POOL, async (a) => {
    const r = await weft(["submit", "-m", `Tune module ${a.mod} (${a.name})`], { token: a.token, cwd: a.dir });
    a.cs = r.ok ? r.data.changeset.id : null;
    if (!r.ok) log("submit failed", { agent: a.name, err: r.error });
  });
  log("submitted", { changesets: plan.filter((a) => a.cs).length });

  // 5. drain: wait until nothing is queued/validating and every room has settled; accept verified rooms
  const drainDeadline = Date.now() + Number(o["drain-timeout"]) * 1000;
  const accepted = new Set();
  for (;;) {
    // The snapshot lists at most 100 changesets, so queue depth comes from the coordinator's own counters.
    const snap = await api(`/v1/repos/${REPO}/snapshot`);
    const usage = (await api(`/v1/limits?repo=${REPO}`)).repo.usage;
    const pending = usage.queued + usage.validating;
    const rooms = snap.rooms ?? [];
    const busyRooms = rooms.filter((r) => ["open", "proposing", "verifying"].includes(r.status)).length;
    if (o["accept-rooms"]) {
      for (const r of rooms.filter((x) => x.status === "verified" && !accepted.has(x.id))) {
        const owner = plan.find((a) => a.name === r.agentName);
        if (!owner) continue;
        accepted.add(r.id);
        const acc = await weft(["room", "accept", r.id], { token: owner.token, cwd: owner.dir });
        log("room accept", { room: r.id, agent: owner.name, ok: acc.ok, err: acc.ok ? undefined : acc.error?.code });
      }
    }
    log("drain", { pending, queued: usage.queued, validating: usage.validating, busyRooms, lanesInFlight: usage.lanesInFlight });
    if (pending === 0 && busyRooms === 0 && rooms.filter((x) => x.status === "verified" && !accepted.has(x.id)).length === 0) break;
    if (Date.now() > drainDeadline) {
      log("drain timeout");
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  sampling = false;
  await sampler;

  // ---------------------------------------------------------------- metrics from the coordinator's own event log
  const evs = [];
  for (let since = 0; ; ) {
    const page = await api(`/v1/repos/${REPO}/events?since=${since}`);
    if (page.length === 0) break;
    evs.push(...page);
    since = page[page.length - 1].seq;
  }
  const submittedSeq = new Map(evs.filter((e) => e.type === "changeset.submitted").map((e) => [e.data.csId, e.seq]));
  const alertsFor = (name, beforeSeq) => evs.some((e) => e.type === "workspace.alert" && e.seq < beforeSeq && (e.data.agentName === name || e.data.peerAgent === name));
  const conflictRejections = evs.filter((e) => e.type === "changeset.rejected" && e.data.reason === "conflict");
  const caught = conflictRejections.filter((e) => {
    const a = plan.find((x) => x.name === e.data.agentName);
    const sub = submittedSeq.get(e.data.csId) ?? e.seq;
    return (a && ["medium", "high"].includes(a.startRisk)) || (a && ["medium", "high"].includes(a.statusRisk)) || alertsFor(e.data.agentName, sub);
  });
  const roomsOpened = evs.filter((e) => e.type === "room.opened").length;
  const roomsVerified = new Set(evs.filter((e) => e.type === "room.verified").map((e) => e.data.roomId)).size;
  const roomsFailed = new Set(evs.filter((e) => e.type === "room.failed").map((e) => e.data.roomId)).size;
  const landed = evs.filter((e) => e.type === "changeset.landed").length;
  const batches = evs.filter((e) => e.type === "queue.batch_landed");
  const checksRun = batches.reduce((n, e) => n + (e.data.checksRun ?? 0), 0);

  // M3: an observer clones the FINAL trunk (its fork is a copy of main) and re-runs the check on every commit.
  const obs = plan[0];
  const observer = await weft(["start", "--task", "observe final trunk", "--touch", "README.md", "--dir", join(WORK, "observer")], { token: obs.token });
  let trunk = { commits: 0, red: 0, redCommits: [], duplicateLandings: [] };
  if (observer.ok) {
    const od = join(WORK, "observer");
    const sh = (args, cwd = od) =>
      new Promise((res) => execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => res(err ? "" : stdout.trim())));
    const commits = (await sh(["rev-list", "--first-parent", "HEAD"])).split("\n").filter(Boolean);
    const runCheck = (commit) =>
      new Promise((res) => {
        const dir = mkdtempSync(join(tmpdir(), "weft-swarm-chk-"));
        execFile("sh", ["-c", `git -C "${od}" archive ${commit} | tar -x -C "${dir}" && cd "${dir}" && ${CHECK}`], { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (err) => res(!err));
      });
    const verdicts = await pool(commits, 8, runCheck);
    const trailers = (await sh(["log", "--first-parent", "--format=%(trailers:key=Weft-Changeset,valueonly,separator=%x2c)", "HEAD"])).split("\n").flatMap((l) => l.split(",")).map((x) => x.trim()).filter(Boolean);
    const seen = new Map();
    for (const id of trailers) seen.set(id, (seen.get(id) ?? 0) + 1);
    trunk = { commits: commits.length, red: verdicts.filter((v) => !v).length, redCommits: commits.filter((_, i) => !verdicts[i]).map((c) => c.slice(0, 12)), duplicateLandings: [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`) };
    await weft(["abandon"], { token: obs.token, cwd: od });
  } else log("observer start failed", { err: observer.error });

  const metrics = {
    repo: REPO,
    remote: REMOTE,
    agents: N,
    pairs: PAIRS,
    stealth: STEALTH,
    startedOk: plan.filter((a) => a.started).length,
    submitted: plan.filter((a) => a.cs).length,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    m1: { peakConcurrentLiveWorkspaces: peakLive, target: "≥ 20" },
    m2: {
      conflictRejections: conflictRejections.length,
      caughtBeforeSubmit: caught.length,
      collisionCatchRate: conflictRejections.length ? Math.round((caught.length / conflictRejections.length) * 1000) / 10 : null,
      roomsOpened,
      roomsVerified,
      roomsFailed,
      resolverGreenRate: roomsOpened ? Math.round((roomsVerified / roomsOpened) * 1000) / 10 : null,
      targets: "catch ≥ 90%, resolver green ≥ 60%",
    },
    m3: { trunkCommits: trunk.commits, trunkRedCommits: trunk.red, trunkRedRate: trunk.commits ? Math.round((trunk.red / trunk.commits) * 10000) / 100 : null, redCommits: trunk.redCommits, target: "< 0.5%" },
    integrity: { duplicateLandings: trunk.duplicateLandings.length, examples: trunk.duplicateLandings.slice(0, 10), target: 0 },
    queue: { landed, batches: batches.length, checksRun, checksPerLanded: landed ? Math.round((checksRun / landed) * 100) / 100 : null, laneRebases: batches.reduce((n, e) => n + (e.data.laneRebases ?? 0), 0), flaky: batches.reduce((n, e) => n + (e.data.flaky?.length ?? 0), 0) },
  };
  writeFileSync(join(OUT, "swarm-metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
};

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "swarm failed", err: String(err?.stack ?? err) }));
  process.exit(1);
});
