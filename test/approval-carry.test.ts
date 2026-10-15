// A human approval of a held changeset carries to its Conflict Room resolution for intent holds only
// (src/core/rubric.ts approvalCarries). Hold strings come from the real holdReason, so the rule cannot drift.
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalCarries, holdKind, holdReason, preCheckGates } from "../src/core/rubric.ts";
import type { DiffStats, JudgeAnswers, RepoConfig } from "../src/core/types.ts";

const CONFIG: RepoConfig = {
  checkCommand: "npm test",
  batchSize: 4,
  reviewThreshold: 60,
  sensitiveGlobs: [],
  unionGlobs: [],
  leaseTtlSeconds: 1800,
  batchWindowMs: 2500,
  judge: { enabled: true, model: "@cf/cloudflare/clef", holdOnSecurity: 0.7, holdOnAlignment: 1.0, secondOpinion: "@cf/google/gemma-4-26b-a4b-it", disagreementHold: 1.0 },
};
const stats = (o: Partial<DiffStats>): DiffStats => ({ files: ["index.js"], added: 1, deleted: 1, testFiles: [], sourceFiles: ["index.js"], secretFindings: [], diffText: "", truncated: false, ...o });
const judge = (o: Partial<JudgeAnswers>): JudgeAnswers => ({ model: "@cf/cloudflare/clef", intentAlignment: 2.5, testAdequacy: 2, maintainability: 2, scopeCreep: 0, securityConcern: 0, correctnessRisk: "low", correctnessRiskP: null, error: null, ...o });
const clean = preCheckGates(stats({}), ["index.js"], CONFIG);
const reason = (pre: ReturnType<typeof preCheckGates>, j: JudgeAnswers): string => {
  const r = holdReason(pre, j, CONFIG);
  assert.ok(r, "fixture must produce a hold");
  return r;
};

const DISAGREE = reason(clean, judge({ intentAlignment: 1.75, disagreement: 1.25, second: { model: "@cf/google/gemma-4-26b-a4b-it", intentAlignment: 3, securityConcern: 0, error: null } }));
const ALIGN = reason(clean, judge({ intentAlignment: 0.6 }));
const SECURITY = reason(clean, judge({ securityConcern: 0.9 }));
const SECRET = reason(preCheckGates(stats({ secretFindings: ["aws_access_key in index.js"] }), ["index.js"], CONFIG), judge({}));

const resolution = { agentId: "agt_a3", resolves: "cs-0039" };
const approved = { id: "cs-0039", agentId: "agt_a3", approvedBy: "evaluator:judges" };

test("holdKind: names every holdReason outcome", () => {
  assert.equal(holdKind(DISAGREE), "disagreement");
  assert.equal(holdKind(ALIGN), "alignment");
  assert.equal(holdKind(SECURITY), "security");
  assert.equal(holdKind(SECRET), "secret");
  assert.equal(holdKind("diff under-reported: 3 files not claimed"), "other");
});

test("approvalCarries: an approved original covers intent holds on its resolution (judges approve once)", () => {
  assert.equal(approvalCarries(DISAGREE, resolution, approved), true);
  assert.equal(approvalCarries(ALIGN, resolution, approved), true);
});

test("approvalCarries: new content the human never saw holds again", () => {
  assert.equal(approvalCarries(SECRET, resolution, approved), false);
  assert.equal(approvalCarries(SECURITY, resolution, approved), false);
  assert.equal(approvalCarries("diff under-reported: 3 files not claimed", resolution, approved), false);
});

test("approvalCarries: only the same agent's approved original", () => {
  assert.equal(approvalCarries(DISAGREE, resolution, null), false);
  assert.equal(approvalCarries(DISAGREE, resolution, { ...approved, approvedBy: null }), false);
  assert.equal(approvalCarries(DISAGREE, resolution, { ...approved, agentId: "agt_other" }), false);
  assert.equal(approvalCarries(DISAGREE, { ...resolution, resolves: "cs-0001" }, approved), false);
  assert.equal(approvalCarries(DISAGREE, { ...resolution, resolves: null }, approved), false);
});
