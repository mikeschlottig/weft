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
  server = spawn(process.execPath, ["container/server.ts"], { env: { ...process.env, PORT: String(PORT), WEFT_RUNNER_ROOT: join(root, "runner"), WEFT_RUNNER_ALLOW_LOCAL_MIRROR: "1" }, stdio: "ignore" });
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

test("runner drivers v2: json-merge merges different keys, still conflicts on the same key; sorted-lines never conflicts", async () => {
  const trunk = join(root, `trunk-drv-${Math.random().toString(36).slice(2)}.git`);
  sh(["init", "-q", "--bare", "-b", "main", trunk]);
  const work = mkdtempSync(join(root, "d-"));
  sh(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "package.json"), `{\n  "name": "shop",\n  "version": "1.0.0",\n  "dependencies": {\n    "a": "1.0.0"\n  }\n}\n`);
  writeFileSync(join(work, "ALLOWLIST"), "alpha\nmike\n");
  sh(["add", "-A"], work);
  sh(["commit", "-q", "-m", "init"], work);
  sh(["push", "-q", trunk, "main"], work);
  const base = sh(["rev-parse", "HEAD"], work);
  const mk = (id: string, files: Record<string, string>) => {
    const fork = join(root, `fork-drv-${id}-${Math.random().toString(36).slice(2)}.git`);
    sh(["init", "-q", "--bare", "-b", "main", fork]);
    sh(["checkout", "-q", "-B", `weft/${id}`, base], work);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(work, p), c);
    sh(["commit", "-q", "-am", id], work);
    sh(["push", "-q", fork, `weft/${id}`], work);
    return { remote: fork, branch: `weft/${id}`, head: sh(["rev-parse", "HEAD"], work) };
  };
  const pj = (deps: string, version = "1.0.0") => `{\n  "name": "shop",\n  "version": "${version}",\n  "dependencies": {\n${deps}\n  }\n}\n`;
  const x = mk("x", { "package.json": pj(`    "a": "1.0.0",\n    "b": "2.0.0"`), ALLOWLIST: "alpha\nmike\nzed\n" });
  const y = mk("y", { "package.json": pj(`    "a": "1.0.0",\n    "c": "3.0.0"`), ALLOWLIST: "alpha\nbeta\nmike\n" });
  const z = mk("z", { "package.json": pj(`    "a": "1.0.0"`, "2.0.0") });
  const w = mk("w", { "package.json": pj(`    "a": "1.0.0"`, "3.0.0") });
  const drivers = [{ glob: "package.json", driver: "json-merge" }, { glob: "ALLOWLIST", driver: "sorted-lines" }];
  const r = await call<{ applied: { id: string; tree: string }[]; rejected: { id: string; rejection: { reason: string } }[] }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_300, checkCommand: null, unionGlobs: [], drivers,
    members: [member("x", x, base, ["package.json", "ALLOWLIST"]), member("y", y, base, ["package.json", "ALLOWLIST"]), member("z", z, base, ["package.json"]), member("w", w, base, ["package.json"])],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["x", "y", "z"]);
  assert.deepEqual(r.rejected.map((q) => [q.id, q.rejection.reason]), [["w", "conflict"]], "version 2.0.0 vs 3.0.0 is a real conflict");
  const tip = r.applied[r.applied.length - 1]?.tree ?? "";
  const runnerRepo = join(root, "runner");
  const gitDir = join(runnerRepo, spawnSync("ls", [runnerRepo], { encoding: "utf8" }).stdout.split("\n").find((d) => d && spawnSync("git", ["--git-dir", join(runnerRepo, d), "cat-file", "-e", tip], {}).status === 0) ?? "");
  const show = (p: string) => spawnSync("git", ["--git-dir", gitDir, "show", `${tip}:${p}`], { encoding: "utf8" }).stdout;
  assert.deepEqual(JSON.parse(show("package.json")).dependencies, { a: "1.0.0", b: "2.0.0", c: "3.0.0" });
  assert.equal(JSON.parse(show("package.json")).version, "2.0.0");
  assert.equal(show("ALLOWLIST"), "alpha\nbeta\nmike\nzed\n");
});

test("runner FR-25: a recipe is replayed on the new trunk, so it also rewrites code that landed meanwhile", async () => {
  const RENAME = `files=$(grep -rlw -- "$1" src || true); [ -z "$files" ] || perl -pi -e 's/\\b\\Q$ENV{WEFT_ARG_1}\\E\\b/$ENV{WEFT_ARG_2}/g' $files`;
  const trunk = join(root, `trunk-rcp-${Math.random().toString(36).slice(2)}.git`);
  sh(["init", "-q", "--bare", "-b", "main", trunk]);
  const work = mkdtempSync(join(root, "r-"));
  sh(["init", "-q", "-b", "main", work]);
  spawnSync("mkdir", ["-p", join(work, "src")]);
  writeFileSync(join(work, "src", "invoice.js"), "export function total(items) {\n  return items.length;\n}\n");
  sh(["add", "-A"], work);
  sh(["commit", "-q", "-m", "init"], work);
  sh(["push", "-q", trunk, "main"], work);
  const base = sh(["rev-parse", "HEAD"], work);
  const mk = (id: string, files: Record<string, string>) => {
    const fork = join(root, `fork-rcp-${id}-${Math.random().toString(36).slice(2)}.git`);
    sh(["init", "-q", "--bare", "-b", "main", fork]);
    sh(["checkout", "-q", "-B", `weft/${id}`, base], work);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(work, p), c);
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", id], work);
    sh(["push", "-q", fork, `weft/${id}`], work);
    return { remote: fork, branch: `weft/${id}`, head: sh(["rev-parse", "HEAD"], work) };
  };
  // b: a NEW call site of total(); a: the rename done by text on the old base (would miss b's call).
  const b = mk("b", { "src/report.js": 'import { total } from "./invoice.js";\nexport const report = (xs) => total(xs);\n' });
  const a = mk("a", { "src/invoice.js": "export function invoiceTotal(items) {\n  return items.length;\n}\n" });
  // Passes on trunk; would FAIL if the rename were text-merged (report.js would import a missing `total`).
  const check = `[ ! -f src/report.js ] || node --input-type=module -e "import('./src/report.js').then((m) => process.exit(m.report([1, 2]) === 2 ? 0 : 1), (e) => { console.error(e.message); process.exit(1); })"`;
  const res = await call<{ applied: { id: string; tree: string }[]; rejected: { id: string; rejection: { reason: string; detail: string } }[]; tip: string }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_400, checkCommand: check, unionGlobs: [], recipes: { rename: { command: RENAME } },
    members: [member("b", b, base, ["src/report.js"]), { ...member("a", a, base, ["src/invoice.js"]), recipe: { name: "rename", args: ["total", "invoiceTotal"] } }],
  });
  assert.deepEqual(res.applied.map((x) => x.id), ["b", "a"], JSON.stringify(res.rejected));
  const g = join(root, "runner", spawnSync("ls", [join(root, "runner")], { encoding: "utf8" }).stdout.split("\n").find((d) => d && spawnSync("git", ["--git-dir", join(root, "runner", d), "cat-file", "-e", res.tip]).status === 0) ?? "");
  const show = (p: string) => spawnSync("git", ["--git-dir", g, "show", `${res.tip}:${p}`], { encoding: "utf8" }).stdout;
  assert.match(show("src/report.js"), /invoiceTotal\(xs\)/, "b's new call site was renamed by the replayed recipe");
  assert.match(spawnSync("git", ["--git-dir", g, "log", "-1", "--format=%B", res.tip], { encoding: "utf8" }).stdout, /Weft-Recipe: rename total invoiceTotal/);
  const bad = await call<{ rejected: { id: string; rejection: { reason: string } }[] }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_401, checkCommand: null, unionGlobs: [], recipes: { rename: { command: RENAME } },
    members: [{ ...member("a", a, base, ["src/invoice.js"]), recipe: { name: "rename", args: ["total;rm -rf /", "x"] } }],
  });
  assert.equal(bad.rejected[0]?.rejection.reason, "recipe_failed", "unsafe arguments are refused, never executed");
});

test("runner FR-33/34: trunk commits are SSH-signed, deterministic across rebuilds, and carry provenance notes", async () => {
  const keyDir = mkdtempSync(join(root, "key-"));
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "queue@weft.dev", "-f", join(keyDir, "k")]);
  const { readFileSync } = await import("node:fs");
  const key = readFileSync(join(keyDir, "k"), "utf8");
  const pub = readFileSync(join(keyDir, "k.pub"), "utf8").trim();
  const { trunk, base, heads } = setup({ s: { "f.txt": "line1\nS\nline3\n" } });
  const input = { trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_500, checkCommand: null, unionGlobs: [], signingKey: key, members: [member("s", heads.s!, base, ["f.txt"])] };
  const a = await call<{ tip: string }>("/speculate", input);
  const b = await call<{ tip: string }>("/speculate", input);
  assert.equal(a.tip, b.tip, "signed speculation is byte-identical on rebuild");
  const r = await call<{ pushed: boolean; notesPushed: boolean }>("/push", {
    trunk: { remote: trunk, token: "", writeToken: "" }, expectedOld: base, tip: a.tip, rebuild: input,
    notes: [{ commit: a.tip, text: "weft-provenance v1\nchangeset: s\n" }],
  });
  assert.equal(r.pushed, true);
  assert.equal(r.notesPushed, true);
  writeFileSync(join(keyDir, "allowed"), `queue@weft.dev namespaces="git" ${pub}\n`);
  const v = spawnSync("git", ["--git-dir", trunk, "-c", `gpg.ssh.allowedSignersFile=${join(keyDir, "allowed")}`, "verify-commit", a.tip], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stderr, /Good "git" signature for queue@weft\.dev/);
  assert.match(sh(["--git-dir", trunk, "notes", "--ref=weft", "show", a.tip]), /changeset: s/);
});

test("runner E2 flake guard: a tip that is red once then green lands, is reported flaky, and nobody is blamed", async () => {
  const { trunk, base, heads } = setup({ p: { "f.txt": "line1\nP\nline3\n" }, q: { "status.txt": "ok\n# q\n" } });
  const marker = join(root, `flaky-${Math.random().toString(36).slice(2)}`);
  // Passes on trunk (no f.txt edit) every time; on the merged tip it fails the first time only.
  const check = `if grep -q '^P$' f.txt && [ ! -f '${marker}' ]; then touch '${marker}'; exit 1; fi; exit 0`;
  const r = await call<{ applied: { id: string }[]; rejected: unknown[]; flaky?: string[]; checksRun: number; bisectSteps: number }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_100, checkCommand: check, unionGlobs: [],
    members: [member("p", heads.p!, base, ["f.txt"]), member("q", heads.q!, base, ["status.txt"])],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["p", "q"]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.flaky, ["p", "q"]);
  assert.equal(r.bisectSteps, 0);
  assert.equal(r.checksRun, 3, "trunk + red tip + fresh re-run");
});

test("runner E2: a deterministic red tip still bisects to the culprit (re-run stays red)", async () => {
  const { trunk, base, heads } = setup({ g: { "f.txt": "line1\nG\nline3\n" }, h: { "status.txt": "broken\n" } });
  const r = await call<{ applied: { id: string }[]; rejected: { id: string; rejection: { reason: string } }[]; flaky?: string[] }>("/speculate", {
    trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_200, checkCommand: "grep -q '^ok$' status.txt", unionGlobs: [],
    members: [member("g", heads.g!, base, ["f.txt"]), member("h", heads.h!, base, ["status.txt"])],
  });
  assert.deepEqual(r.applied.map((a) => a.id), ["g"]);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.rejection.reason]), [["h", "check_failed"]]);
  assert.deepEqual(r.flaky, []);
});

test("runner E2: a non-monotonic check (culprit passes on re-run) is CHECK_FLAKY, not a blame", async () => {
  const { trunk, base, heads } = setup({ u: { "f.txt": "line1\nU\nline3\n" }, v: { "status.txt": "ok\n# v\n" } });
  const n = join(root, `count-${Math.random().toString(36).slice(2)}`);
  // Counts runs on any tree that contains U: run 1 (tip) red, run 2 (tip re-run) red, run 3 (bisect probe) red,
  // run 4 (fresh culprit confirmation) green → non-deterministic.
  const check = `grep -q '^U$' f.txt || exit 0; c=$(cat '${n}' 2>/dev/null || echo 0); c=$((c+1)); echo $c > '${n}'; [ $c -ge 4 ]`;
  await assert.rejects(
    call("/speculate", {
      trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_300, checkCommand: check, unionGlobs: [],
      members: [member("u", heads.u!, base, ["f.txt"]), member("v", heads.v!, base, ["status.txt"])],
    }),
    /CHECK_FLAKY/,
  );
});

test("runner D5 mirror: trunk main + provenance notes are force-pushed to the mirror; https-only otherwise", async () => {
  const { trunk, base } = setup({});
  const work = mkdtempSync(join(root, "m-"));
  sh(["clone", "-q", trunk, work]);
  sh(["notes", "--ref=weft", "add", "-m", "weft-provenance v1", base], work);
  sh(["push", "-q", trunk, "refs/notes/weft:refs/notes/weft"], work);
  const target = join(root, `mirror-${Math.random().toString(36).slice(2)}.git`);
  sh(["init", "-q", "--bare", "-b", "main", target]);
  const r = await call<{ pushed: string; notes: boolean; remoteMain: string | null }>("/mirror", { trunk: { remote: trunk, token: "" }, trunkHead: base, target: { url: target, authHeader: "Authorization: Bearer test" } });
  assert.equal(r.pushed, base);
  assert.equal(r.remoteMain, base);
  assert.equal(r.notes, true);
  assert.equal(sh(["--git-dir", target, "rev-parse", "refs/heads/main"]), base);
  assert.match(sh(["--git-dir", target, "notes", "--ref=weft", "show", base]), /weft-provenance v1/);
  await assert.rejects(call("/mirror", { trunk: { remote: trunk, token: "" }, trunkHead: base, target: { url: "https://user:pw@github.com/o/r.git", authHeader: "x" } }), /BAD_MIRROR/);
});

test("runner: a check killed by a signal is CHECK_INTERRUPTED (infra), never a red trunk or a blamed changeset", async () => {
  const { trunk, base, heads } = setup({ k: { "f.txt": "line1\nK\nline3\n" } });
  await assert.rejects(
    call("/speculate", { trunk: { remote: trunk, token: "" }, trunkHead: base, claimTime: 1_790_000_400, checkCommand: "kill -TERM $$", unionGlobs: [], members: [member("k", heads.k!, base, ["f.txt"])] }),
    /CHECK_INTERRUPTED/,
  );
});
