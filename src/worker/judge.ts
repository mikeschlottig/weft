// The rubric judge: Cloudflare CLEF decision model on Workers AI (System One API).
// Verified 2026-10-12: env.AI.run("@cf/cloudflare/clef", { model, state, questions }) → { answers, usage }.

import { withRetry } from "../core/retry.ts";
import { JUDGE_QUESTIONS, judgeState, parseJudge } from "../core/rubric.ts";
import type { DiffStats, JudgeAnswers } from "../core/types.ts";

interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export const judgeChangeset = async (
  ai: AiLike,
  model: string,
  input: { task: string; intentGlobs: string[]; message: string; stats: DiffStats },
): Promise<JudgeAnswers> => {
  const variant = model.endsWith("clef-flash") ? "clef-flash" : "clef";
  try {
    const raw = await withRetry(
      () =>
        ai.run(model, {
          model: variant,
          state: judgeState(input),
          questions: JUDGE_QUESTIONS,
        }),
      { attempts: 3, baseMs: 400 },
    );
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
