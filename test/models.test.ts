// Gemma 4 default + chat-model judge path (models.ts, rubric.ts chat helpers, judge.ts transport choice).
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEF, CLEF_FLASH, DEFAULT_LLM, GEMMA_4, KIMI_K2_CODE, chatExtras, isClef } from "../src/core/models.ts";
import { RESOLVER_MODEL } from "../src/core/resolve.ts";
import { JUDGE_JSON_SCHEMA, JUDGE_QUESTIONS, chatJudgeToAnswers, judgeChatMessages, parseJudge } from "../src/core/rubric.ts";
import { judgeChangeset } from "../src/worker/judge.ts";
import type { DiffStats } from "../src/core/types.ts";

const STATS: DiffStats = { files: ["src/a.ts", "test/a.test.ts"], testFiles: ["test/a.test.ts"], sourceFiles: ["src/a.ts"], added: 10, deleted: 2, truncated: false, diffText: "+x", secretFindings: [] };
const INPUT = { task: "add a", intentGlobs: ["src/**", "test/**"], message: "feat: a", stats: STATS };

test("models: Gemma 4 is the default for judge and resolver; CLEF detection", () => {
  assert.equal(DEFAULT_LLM, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(RESOLVER_MODEL, GEMMA_4);
  assert.ok(isClef(CLEF) && isClef(CLEF_FLASH));
  assert.ok(!isClef(GEMMA_4) && !isClef(KIMI_K2_CODE));
  assert.deepEqual(chatExtras(GEMMA_4), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(chatExtras(KIMI_K2_CODE), {});
});

test("rubric: chat judge prompt carries every question id and the schema requires them all", () => {
  const [sys] = judgeChatMessages("{}");
  for (const id of Object.keys(JUDGE_QUESTIONS)) assert.match(sys?.content ?? "", new RegExp(`- ${id} `));
  assert.deepEqual([...JUDGE_JSON_SCHEMA.required].sort(), Object.keys(JUDGE_QUESTIONS).sort());
});

test("rubric: chatJudgeToAnswers reads JSON-mode objects, chat text with fences, and clamps", () => {
  const obj = { intent_alignment: 3, test_adequacy: 2, maintainability: 5, scope_creep: 0.1, security_concern: -1, correctness_risk: "LOW" };
  const fromObject = parseJudge(GEMMA_4, chatJudgeToAnswers({ response: obj }));
  assert.equal(fromObject.intentAlignment, 3);
  assert.equal(fromObject.maintainability, 2); // clamped to the 0..2 scale
  assert.equal(fromObject.securityConcern, 0); // clamped to 0..1
  assert.equal(fromObject.correctnessRisk, "low");
  const text = 'Here you go:\n```json\n{"intent_alignment": 1, "test_adequacy": 0, "maintainability": 1, "scope_creep": 0.8, "security_concern": 0.05, "correctness_risk": "high", "note": "a } in a string"}\n```';
  const fromText = parseJudge(GEMMA_4, chatJudgeToAnswers({ choices: [{ message: { content: text } }] }));
  assert.equal(fromText.intentAlignment, 1);
  assert.equal(fromText.scopeCreep, 0.8);
  assert.equal(fromText.correctnessRisk, "high");
  assert.throws(() => chatJudgeToAnswers({ response: "no json here" }), /no JSON object/);
});

test("judge: chat models get messages + JSON mode; CLEF gets the System One shape", async () => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const ai = {
    run: async (model: string, input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ model, input });
      return isClef(model)
        ? { answers: { intent_alignment: { score: 2 }, test_adequacy: 2, maintainability: 1, scope_creep: { noul: 0 }, security_concern: 0, correctness_risk: { choice: "low" } } }
        : { choices: [{ message: { content: '{"intent_alignment":3,"test_adequacy":3,"maintainability":2,"scope_creep":0,"security_concern":0,"correctness_risk":"low"}' } }] };
    },
  };
  const g = await judgeChangeset(ai, GEMMA_4, INPUT);
  assert.equal(g.error, null);
  assert.equal(g.intentAlignment, 3);
  assert.ok(Array.isArray(calls[0]?.input.messages));
  assert.equal((calls[0]?.input.response_format as { type: string }).type, "json_schema");
  const c = await judgeChangeset(ai, CLEF_FLASH, INPUT);
  assert.equal(c.intentAlignment, 2);
  assert.equal(calls[1]?.input.model, "clef-flash");
  assert.ok("questions" in (calls[1]?.input ?? {}));
});

test("judge: a malformed chat reply is retried, then reported as an error (never a crash)", async () => {
  let n = 0;
  const bad = { run: async (): Promise<unknown> => { n += 1; return { response: "I think it is fine." }; } };
  const r = await judgeChangeset(bad, GEMMA_4, INPUT);
  assert.equal(n, 3);
  assert.match(r.error ?? "", /no JSON object/);
  let m = 0;
  const flaky = { run: async (): Promise<unknown> => (++m === 1 ? { response: "oops" } : { response: { intent_alignment: 2, test_adequacy: 1, maintainability: 1, scope_creep: 0, security_concern: 0, correctness_risk: "medium" } }) };
  const ok = await judgeChangeset(flaky, GEMMA_4, INPUT);
  assert.equal(ok.error, null);
  assert.equal(ok.correctnessRisk, "medium");
});
