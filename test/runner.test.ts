// merge-runner integration test: the real container server under Node, real git, local bare repos as
// "remotes" (spec §14 Container row). Covers FR-28 re-admission and the Conflict Room verify path.
// Run: node --test test/
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const root = mkdtempSync(join(tmpdir(), "weft-runner-test-"));
let server: ChildProcess;

const sh = (args: string[], cwd?: string): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const call = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!j.ok) throw new Error(`${path}: ${j.error?.code} ${j.error?.message}`);
  return j.data as T;
};

/** trunk (bare) with f.txt + status.txt, and one fork per changeset, each with a commit on its branch. */
const setup = (changes: Record<string, Record<string, string>>) => {
  const trunk = join(root, `trunk-${Math.random().toString(36).slice(2)}.git`);
  sh(["init", "-q", "--bare", "-b", "main", trunk]);
  const work = mkdtempSync(join(root, "w-"));
  sh(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "f.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(work, "status.txt"), "ok\n");
  sh(["add", "-A"], work);
  sh(["commit", "-q", "-m", "init"], work);
  sh(["push", "-q", trunk, "main"], work);
  const base = sh(["rev-parse", "HEAD"], work);
  const heads: Record<string, { remote: string; branch: string; head: string }> = {};
  for (const [id, files] of Object.entries(changes)) {
    const fork = join(root, `fork-${id}-${Math.random().toString(36).slice(2)}.git`);
    sh(["init", "-q", "--bare", "-b", "main", fork]);
    sh(["checkout", "-q", "-B", `weft/${id}`, base], work);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(work, p), c);
    sh(["commit", "-q", "-am", `change ${id}`], work);
    sh(["push", "-q", fork, `weft/${id}`], work);
    heads[id] = { remote: fork, branch: `weft/${id}`, head: sh(["rev-parse", "HEAD"], work) };
  }
  return { trunk, base, heads };
};
const member = (id: string, h: { remote: string; branch: string; head: string }, base: string, files: string[]) => ({
  id, wsId: `ws-${id}`, forkRepo: id, forkRemote: h.remote, forkToken: "", branch: h.branch, headCommit: h.head, baseCommit: base,
  message: `change ${id}`, trailers: [`Weft-Changeset: ${id}`], filesTouched: files, agentId: `agt_${id}`, agentName: id, task: id, intentGlobs: ["**"],
});

before(async () => {
  server = spawn(process.execPath, ["container/server.ts"], { env: { ...process.env, PORT: String(PORT), WEFT_RUNNER_ROOT: join(root, "runner") }, stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("runner did not start");
});
after(() => {
  server.kill();
  rmSync(root, { recursive: true, force: true });
});

test("runner FR-28: a changeset that only conflicted with a check culprit is re-admitted and lands", async () => {
  const { trunk, base, heads } = setup({
    x: { "f.txt": "line1\nX-edit\nline3\n", "status.txt": "broken\n" }, // conflicts with y AND breaks the check
    y: { "f.txt": "line1\nY-edit\nline3\n" },
  });
  const r = await call<{ applied: { id: string }[]; rejected: { id: string; rejection: { reason: string } }[]; readmitted?: string[]; bisectSteps: number }>("/speculate", {
    trunk: { remote: trunk, token: "" },
    trunkHead: base,
    claimTime: 1_790_000_000,
    checkCommand: "grep -q '^ok$' status.txt",
    unionGlobs: [],
    members: [member("x", heads.x!, base, ["f.txt", "status.txt"]), member("y", heads.y!, base, ["f.txt"])],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["y"]);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.rejection.reason]), [["x", "check_failed"]]);
  assert.deepEqual(r.readmitted, ["y"]);
});

test("runner rooms: verify refuses leftover markers, builds a merge commit and runs the check", async () => {
  const { trunk, base, heads } = setup({ a: { "f.txt": "line1\nA\nline3\n" }, b: { "f.txt": "line1\nB\nline3\n" } });
  // land a on trunk
  await call("/speculate", { trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_000, checkCommand: null, unionGlobs: [], members: [member("a", heads.a!, base, ["f.txt"])] });
  const work = mkdtempSync(join(root, "v-"));
  sh(["clone", "-q", heads.a!.remote, work]);
  sh(["fetch", "-q", heads.a!.remote, `${heads.a!.branch}`], work);
  const aHead = heads.a!.head;
  sh(["push", "-q", trunk, `${aHead}:refs/heads/main`, "-f"], work);
  const prep = await call<{ conflicted: string[]; files: { path: string; merged: string | null }[] }>("/room-prepare", {
    trunk: { remote: trunk, token: "" }, trunkHead: aHead, fork: { forkRemote: heads.b!.remote, forkToken: "", branch: heads.b!.branch, headCommit: heads.b!.head }, unionGlobs: [],
  });
  assert.deepEqual(prep.conflicted, ["f.txt"]);
  assert.match(prep.files[0]?.merged ?? "", /<<<<<<< /);
  const verify = (content: string) =>
    call<{ candidate: string; markersLeft: string[]; checkPassed: boolean | null; pushed: boolean }>("/room-verify", {
      trunk: { remote: trunk, token: "" }, trunkHead: aHead,
      fork: { forkRemote: heads.b!.remote, forkToken: "", writeToken: "", branch: heads.b!.branch, headCommit: heads.b!.head },
      roomBranch: "weft/room/r-1", resolutions: [{ path: "f.txt", content }], message: "resolve", authorName: "r", authorEmail: "r@r",
      claimTime: 1_790_000_001, checkCommand: "grep -q 'A and B' f.txt", unionGlobs: [],
    });
  const bad = await verify("line1\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\nline3\n");
  assert.deepEqual(bad.markersLeft, ["f.txt"]);
  assert.equal(bad.pushed, false);
  const red = await verify("line1\nA\nline3\n");
  assert.equal(red.checkPassed, false);
  assert.equal(red.pushed, false);
  const green = await verify("line1\nA and B\nline3\n");
  assert.equal(green.checkPassed, true);
  assert.equal(green.pushed, true);
  assert.equal(sh(["rev-parse", "refs/heads/weft/room/r-1"], heads.b!.remote), green.candidate);
  const parents = sh(["rev-list", "--parents", "-n", "1", green.candidate], heads.b!.remote).split(" ").slice(1);
  assert.deepEqual(parents, [aHead, heads.b!.head]);
});

/** A child fork whose branch is the parent's head plus one more commit (what `weft start --after` produces). */
const stackChild = (parent: { remote: string; branch: string; head: string }, id: string, files: Record<string, string>) => {
  const work = mkdtempSync(join(root, "s-"));
  sh(["clone", "-q", parent.remote, work]);
  sh(["checkout", "-q", "-B", `weft/${id}`, parent.head], work);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(work, p), c);
  sh(["commit", "-q", "-am", `change ${id}`], work);
  const fork = join(root, `fork-${id}-${Math.random().toString(36).slice(2)}.git`);
  sh(["init", "-q", "--bare", "-b", "main", fork]);
  sh(["push", "-q", fork, `weft/${id}`], work);
  return { remote: fork, branch: `weft/${id}`, head: sh(["rev-parse", "HEAD"], work) };
};

test("runner FR-27: a stacked child lands on top of its parent in one batch", async () => {
  const { trunk, base, heads } = setup({ p: { "f.txt": "line1\nP\nline3\n" } });
  const child = stackChild(heads.p!, "c", { "status.txt": "ok\nchild\n" });
  const r = await call<{ applied: { id: string; commit: string }[]; rejected: { id: string }[]; tip: string }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_100, checkCommand: "grep -q '^ok$' status.txt", unionGlobs: [],
    members: [member("p", heads.p!, base, ["f.txt"]), { ...member("c", child, heads.p!.head, ["status.txt"]), after: "p" }],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["p", "c"]);
  assert.deepEqual(r.rejected, []);
});

test("runner FR-27: when the parent fails the check, its stacked child is rejected as a dependency", async () => {
  const { trunk, base, heads } = setup({ p: { "status.txt": "broken\n" }, z: { "f.txt": "line1\nZ\nline3\n" } });
  const child = stackChild(heads.p!, "c", { "f.txt": "line1\nline2\nline3\nchild\n" });
  const r = await call<{ applied: { id: string }[]; rejected: { id: string; rejection: { reason: string } }[] }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_200, checkCommand: "grep -q '^ok$' status.txt", unionGlobs: [],
    members: [member("p", heads.p!, base, ["status.txt"]), { ...member("c", child, heads.p!.head, ["f.txt"]), after: "p" }, member("z", heads.z!, base, ["f.txt"])],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["z"]);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.rejection.reason]).sort(), [["c", "dependency"], ["p", "check_failed"]]);
});
