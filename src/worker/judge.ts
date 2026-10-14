// The rubric judge on Workers AI. Two transports, one answer shape (JudgeAnswers):
//   - chat models (default Gemma 4): chat completions + JSON mode, the six questions in the prompt;
//   - CLEF decision models (System One API). Verified 2026-10-12:
//     env.AI.run("@cf/cloudflare/clef", { model, state, questions }) → { answers, usage }.

import { chatExtras, isClef } from "../core/models.ts";
import { withRetry } from "../core/retry.ts";
import { JUDGE_JSON_SCHEMA, JUDGE_QUESTIONS, chatJudgeToAnswers, judgeChatMessages, judgeState, parseJudge } from "../core/rubric.ts";
import type { DiffStats, JudgeAnswers } from "../core/types.ts";

interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const runClef = (ai: AiLike, model: string, state: string): Promise<unknown> =>
  ai.run(model, { model: model.endsWith("clef-flash") ? "clef-flash" : "clef", state, questions: JUDGE_QUESTIONS });

/** A malformed chat reply is retried like a transport error (the parse runs inside the retry). */
const runChat = async (ai: AiLike, model: string, state: string): Promise<unknown> =>
  chatJudgeToAnswers(
    await ai.run(model, {
      messages: judgeChatMessages(state),
      response_format: { type: "json_schema", json_schema: JUDGE_JSON_SCHEMA },
      max_tokens: 400,
      temperature: 0,
      ...chatExtras(model),
    }),
  );

export const judgeChangeset = async (
  ai: AiLike,
  model: string,
  input: { task: string; intentGlobs: string[]; message: string; stats: DiffStats },
): Promise<JudgeAnswers> => {
  const state = judgeState(input);
  try {
    const raw = await withRetry(() => (isClef(model) ? runClef(ai, model, state) : runChat(ai, model, state)), { attempts: 3, baseMs: 400 });
    const parsed = parseJudge(model, raw);
    const answered = [parsed.intentAlignment, parsed.testAdequacy, parsed.maintainability, parsed.scopeCreep, parsed.securityConcern].filter((v) => v !== null).length;
    if (answered === 0) {
      return { ...parsed, error: `judge returned no parseable answers: ${JSON.stringify(raw).slice(0, 300)}` };
    }
    return parsed;
  } catch (err: unknown) {
    return {
      model,
      intentAlignment: null,
      testAdequacy: null,
      maintainability: null,
      scopeCreep: null,
      securityConcern: null,
      correctnessRisk: null,
      correctnessRiskP: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
