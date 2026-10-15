// Unit tests for the Cloudflare-free core: forecast, risk, WQS rubric, JWT.
// Run: node --test test/   (Node ≥ 23.6 runs TypeScript directly)
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingOverlaps, forecast, scoreRisk } from "../src/core/forecast.ts";
import { matches, prefixesOverlap } from "../src/core/glob.ts";
import { signJwt, verifyJwt } from "../src/core/jwt.ts";
import { checkGate, classifyFiles, composeScorecard, holdReason, parseJudge, preCheckGates, processGates, scanAddedLines } from "../src/core/rubric.ts";
import type { DiffStats, JudgeAnswers, RepoConfig, Workspace } from "../src/core/types.ts";

const CONFIG: RepoConfig = {
  checkCommand: "node --test",
  batchSize: 4,
  reviewThreshold: 60,
  sensitiveGlobs: ["src/auth/**"],
  unionGlobs: ["CHANGELOG.md"],
  leaseTtlSeconds: 1800,
  batchWindowMs: 2500,
  judge: { enabled: true, model: "@cf/cloudflare/clef", holdOnSecurity: 0.7, holdOnAlignment: 1.0 },
};
const NOW = Date.parse("2026-10-12T20:00:00Z");
const ws = (id: string, globs: string[], touched: string[], mode: "soft" | "exclusive" = "soft"): Workspace => ({
  id, repo: "shop", agentId: `agt_${id}`, agentName: id, model: "m", task: `task ${id}`, branch: `weft/${id}`, forkRepo: `shop--${id}`, forkRemote: "", forkTokenId: null,
  baseCommit: "0".repeat(40), status: "active", intent: { globs, mode, task: "t", createdAt: "", expiresAt: "2026-10-12T21:00:00Z" }, touched,
  createdAt: "", updatedAt: "", changesetId: null, rejections: 0,
});
const FILES = ["src/billing/invoice.js", "src/util/format.js", "src/auth/session.js", "CHANGELOG.md"];

// Secret-scan fixtures are assembled at runtime so no credential-shaped literal is stored in the repo.
const fakeAwsKey = (tail: string): string => ["AK", "IA", tail].join("");

test("glob: ** spans directories, literal paths claim subtrees", () => {
  assert.ok(matches("src/billing/a/b.js", ["src/billing/**"]));
  assert.ok(matches("src/auth/session.js", ["src/auth"]));
  assert.ok(!matches("src/authz/x.js", ["src/auth"]));
  assert.deepEqual(prefixesOverlap(["src/**"], ["src/new/**"]), ["src/** ~ src/new/**"]);
});

test("forecast: touched > files > prefix > none, union files never count", () => {
  const atlas = ws("atlas", ["src/billing/**"], ["src/billing/invoice.js", "CHANGELOG.md"]);
  assert.equal(forecast([atlas], { wsId: null, globs: ["src/billing/**"], touched: [] }, FILES, CONFIG, NOW).risk, "medium");
  assert.equal(forecast([atlas], { wsId: "c", globs: ["src/billing/**"], touched: ["src/billing/invoice.js"] }, FILES, CONFIG, NOW).risk, "high");
  assert.equal(forecast([atlas], { wsId: "c", globs: ["src/util/**"], touched: ["CHANGELOG.md"] }, FILES, CONFIG, NOW).risk, "none");
  assert.equal(forecast([ws("n", ["src/new/**"], [])], { wsId: null, globs: ["src/**/*.ts"], touched: [] }, FILES, CONFIG, NOW).risk, "low");
});

test("forecast: exclusive leases block overlapping starts; expired leases do not", () => {
  const dune = ws("dune", ["src/auth/**"], [], "exclusive");
  const fc = forecast([dune], { wsId: null, globs: ["src/auth/session.js"], touched: [] }, FILES, CONFIG, NOW);
  assert.equal(blockingOverlaps(fc, "soft").length, 1);
  const expired = { ...dune, intent: { ...dune.intent, expiresAt: "2026-10-12T19:00:00Z" } };
  assert.equal(forecast([expired], { wsId: null, globs: ["src/auth/session.js"], touched: [] }, FILES, CONFIG, NOW).overlaps.length, 0);
});

test("risk: sensitive paths flag review; union files are never out-of-intent", () => {
  const prov = { agentId: "a", agentName: "dune", model: "m", task: "t", intentGlobs: ["src/auth/**"], filesTouched: ["src/auth/session.js", "CHANGELOG.md"], linesAdded: 2, linesDeleted: 1, checkpoints: 1, forkHead: "x", promptSha256: null, toolCalls: null, costUsd: null };
  const r = scoreRisk(CONFIG, prov, 0, 0);
  assert.equal(r.sensitive, true);
  assert.ok(!r.factors.some((f) => f.name === "out_of_intent"));
  assert.equal(r.score, 39);
});

const stats = (o: Partial<DiffStats>): DiffStats => ({ files: [], added: 0, deleted: 0, testFiles: [], sourceFiles: [], secretFindings: [], diffText: "", truncated: false, ...o });
const judge = (o: Partial<JudgeAnswers>): JudgeAnswers => ({ model: "clef", intentAlignment: 3, testAdequacy: 3, maintainability: 2, scopeCreep: 0, securityConcern: 0, correctnessRisk: "low", correctnessRiskP: null, error: null, ...o });

test("rubric: file classes and secret scan only look at added lines", () => {
  const c = classifyFiles(["src/a.js", "test/a.test.js", "README.md", "pkg/x_test.go"]);
  assert.deepEqual(c.testFiles, ["test/a.test.js", "pkg/x_test.go"]);
  assert.deepEqual(c.sourceFiles, ["src/a.js"]);
  const diff = `+++ b/src/cfg.js\n+const k = '${fakeAwsKey("ABCDEFGHIJKLMNOP")}';\n-const old = '${fakeAwsKey("ZZZZZZZZZZZZZZZZ")}';\n`;
  assert.deepEqual(scanAddedLines(diff), ["aws_access_key in src/cfg.js"]);
});

test("rubric: hold rules — secret, security concern, intent alignment", () => {
  const clean = preCheckGates(stats({ files: ["src/a.js", "test/a.test.js"], sourceFiles: ["src/a.js"], testFiles: ["test/a.test.js"], added: 10 }), ["src/**", "test/**"], CONFIG);
  assert.equal(holdReason(clean, judge({}), CONFIG), null);
  const secret = preCheckGates(stats({ files: ["src/a.js"], secretFindings: ["aws_access_key in src/a.js"] }), ["src/**"], CONFIG);
  assert.match(holdReason(secret, judge({}), CONFIG) ?? "", /possible secret/);
  assert.match(holdReason(clean, judge({ securityConcern: 0.8 }), CONFIG) ?? "", /security concern/);
  assert.match(holdReason(clean, judge({ intentAlignment: 0.4 }), CONFIG) ?? "", /intent alignment/);
  assert.equal(holdReason(clean, judge({ error: "down", securityConcern: null }), CONFIG), null);
});

test("rubric: WQS is 100 for a perfect change, null before the check, normalized without a judge", () => {
  const pre = preCheckGates(stats({ files: ["src/a.js", "test/a.test.js"], sourceFiles: ["src/a.js"], testFiles: ["test/a.test.js"], added: 10 }), ["src/**", "test/**"], CONFIG);
  const perfect = composeScorecard({ pre, check: checkGate(true, true), judge: judge({}), process: processGates(0, 0), hold: null, now: "t" });
  assert.equal(perfect.total, 100);
  assert.equal(composeScorecard({ pre, check: checkGate(null, true), judge: judge({}), process: processGates(0, 0), hold: null, now: "t" }).total, null);
  const noJudge = composeScorecard({ pre, check: checkGate(true, true), judge: null, process: processGates(0, 0), hold: null, now: "t" });
  assert.equal(noJudge.total, 100);
  const failed = composeScorecard({ pre, check: checkGate(false, true), judge: judge({}), process: processGates(1, 3), hold: null, now: "t" });
  assert.equal(failed.total, 65);
  assert.ok(failed.advice.some((a) => /check/.test(a)));
});

test("rubric: parseJudge accepts bare numbers and typed objects", () => {
  const a = parseJudge("clef", { answers: { intent_alignment: { score: 2.5 }, test_adequacy: 1.5, maintainability: { score: 1 }, scope_creep: { noul: 0.2 }, security_concern: 0.01, correctness_risk: { choice: "medium", probabilities: { low: 0.3, medium: 0.6, high: 0.1 } } } });
  assert.equal(a.intentAlignment, 2.5);
  assert.equal(a.testAdequacy, 1.5);
  assert.equal(a.scopeCreep, 0.2);
  assert.equal(a.correctnessRisk, "medium");
  assert.equal(a.correctnessRiskP?.medium, 0.6);
});

test("jwt: roundtrip, expiry and tampering", async () => {
  const claims = { sub: "agt_1", name: "atlas", model: "m", role: "agent" as const, iat: 100, exp: 200 };
  const tok = await signJwt(claims, "secret");
  assert.deepEqual(await verifyJwt(tok, "secret", 150), claims);
  await assert.rejects(verifyJwt(tok, "secret", 250), /expired/);
  await assert.rejects(verifyJwt(tok, "other", 150), /signature/);
});

test("gitSubcommand: skips global options so --git-dir fetches still count as network ops (retry)", async () => {
  const { gitSubcommand } = await import("../src/core/retry.ts");
  assert.equal(gitSubcommand(["fetch", "-q", "origin"]), "fetch");
  assert.equal(gitSubcommand(["--git-dir=/tmp/g.git", "fetch", "-q", "https://x"]), "fetch");
  assert.equal(gitSubcommand(["-c", "http.extraHeader=Authorization: Bearer t", "push", "origin"]), "push");
  assert.equal(gitSubcommand(["-C", "/tmp/w", "--work-tree=/tmp/w", "ls-remote", "--heads", "u"]), "ls-remote");
  assert.equal(gitSubcommand(["--version"]), null);
});
