// Workers AI model registry — pure, no Cloudflare imports.
//
// Default for every generative role (judge, conflict-room resolver) is Gemma 4 26B A4B: a MoE model
// with 4B active parameters, 256K context, JSON mode, $0.10 / $0.30 per M tokens (verified against
// developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it on 2026-10-14). The earlier models
// stay selectable per repo via `PATCH /v1/repos/:repo/config` (CLI: weft config --judge-model …).

export const GEMMA_4 = "@cf/google/gemma-4-26b-a4b-it";
export const CLEF = "@cf/cloudflare/clef";
export const CLEF_FLASH = "@cf/cloudflare/clef-flash";
export const KIMI_K2_CODE = "@cf/moonshotai/kimi-k2.7-code";

export const DEFAULT_LLM = GEMMA_4;

/** Models the judge can run. CLEF variants use the System One API; the rest use chat completions + JSON mode. */
export const JUDGE_MODELS = [GEMMA_4, CLEF, CLEF_FLASH] as const;
/** Models the Conflict Room resolver can run (chat completions). */
export const RESOLVER_MODELS = [GEMMA_4, KIMI_K2_CODE] as const;

/** CLEF decision models take `{ model, state, questions }`, not chat messages. */
export const isClef = (model: string): boolean => model === CLEF || model === CLEF_FLASH;

/** Gemma 4 thinks by default; for structured, latency-sensitive roles we turn it off. */
export const chatExtras = (model: string): Record<string, unknown> =>
  model === GEMMA_4 ? { chat_template_kwargs: { enable_thinking: false } } : {};
