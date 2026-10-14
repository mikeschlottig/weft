// Contest evaluator access policy (src/core/evaluator.ts).
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVAL_HARD_EXPIRY, evalAgentMay, evalExpiry, evaluatorMay, filterEvalConfig, isEvalName, isGithubHttps } from "../src/core/evaluator.ts";

test("evaluator: eval-* names only", () => {
  assert.ok(isEvalName("eval-shop-1"));
  assert.ok(!isEvalName("shop-10141259"));
  assert.ok(!isEvalName("eval-"));
  assert.ok(!isEvalName("eval-../x"));
  assert.ok(!isEvalName(undefined));
});

test("evaluator: reads always; writes only on eval-* repos; admin commands from the allow-list only", () => {
  assert.equal(evaluatorMay("read", "snapshot", "shop-10141259").allow, true);
  assert.equal(evaluatorMay("agent", "start", "shop-10141259").allow, false);
  assert.equal(evaluatorMay("review", "approve", "shop-10141259").allow, false);
  assert.equal(evaluatorMay("review", "approve", "eval-shop").allow, true);
  for (const cmd of ["init", "agent register"]) assert.equal(evaluatorMay("admin", cmd, undefined).allow, true);
  for (const cmd of ["config", "revert", "queue run"]) assert.equal(evaluatorMay("admin", cmd, "eval-shop").allow, true);
  assert.equal(evaluatorMay("admin", "config", "shop-10141259").allow, false);
  for (const cmd of ["keys rotate", "agent kill", "agent revive", "agent budget", "mirror set", "mirror sync", "similarity", "evaluator token", "keys list", "agent list"]) {
    const d = evaluatorMay("admin", cmd, undefined);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason ?? "", /admin token/);
  }
});

test("evaluator: agents registered for evaluation stay in eval-* repos; other agents are unaffected", () => {
  assert.equal(evalAgentMay("eval-a1", "eval-shop").allow, true);
  assert.equal(evalAgentMay("eval-a1", "shop-10141259").allow, false);
  assert.equal(evalAgentMay("eval-a1", undefined).allow, true); // e.g. token refresh
  assert.equal(evalAgentMay("atlas", "shop-10141259").allow, true);
});

test("evaluator: GitHub HTTPS imports only", () => {
  assert.ok(isGithubHttps("https://github.com/owner/repo"));
  assert.ok(isGithubHttps("https://github.com/owner/repo.git"));
  assert.ok(!isGithubHttps("http://github.com/owner/repo"));
  assert.ok(!isGithubHttps("https://gitlab.com/owner/repo"));
  assert.ok(!isGithubHttps("https://github.com.evil.example/owner/repo"));
  assert.ok(!isGithubHttps("https://user:pw@github.com/owner/repo"));
});

test("evaluator: config keeps the safe subset and reports the rest", () => {
  const f = filterEvalConfig({ checkCommand: "npm test", lanes: 2, recipes: { x: { command: "rm -rf /" } }, drivers: [], judge: { enabled: false } });
  assert.deepEqual(Object.keys(f.patch).sort(), ["checkCommand", "lanes"]);
  assert.deepEqual(f.dropped.sort(), ["drivers", "judge", "recipes"]);
});

test("evaluator: token expiry is clamped to [now + 1 h, hard expiry]", () => {
  const now = Date.parse("2026-10-14T23:00:00Z");
  assert.equal(evalExpiry(now, null), EVAL_HARD_EXPIRY);
  assert.equal(evalExpiry(now, "2027-01-01T00:00:00Z"), EVAL_HARD_EXPIRY);
  assert.equal(evalExpiry(now, "2026-10-14T23:10:00Z"), now + 3_600_000);
  assert.equal(evalExpiry(now, "garbage"), EVAL_HARD_EXPIRY);
});
