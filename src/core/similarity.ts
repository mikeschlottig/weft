// FR-09 duplicate-intent detection: task embeddings compared inside the repo's coordinator (pure; tested).

export const EMBED_MODEL = "@cf/google/embeddinggemma-300m";
/**
 * Measured 2026-10-12 with embeddinggemma-300m via POST /v1/admin/similarity (10 pairs): same-work paraphrases
 * scored 0.707–0.897; different tasks 0.299–0.613 (incl. related-but-different 0.571, 0.613). 0.68 sits in the gap.
 */
export const DUPLICATE_THRESHOLD = 0.68;

/** Accept the Workers AI embedding shapes seen across models: {data:[[...]]}, {result:{data}}, {embeddings:[[...]]}. */
export const parseEmbedding = (raw: unknown): number[] | null => {
  const r = raw as { data?: unknown; result?: { data?: unknown }; embeddings?: unknown } | null;
  const rows = (r?.data ?? r?.result?.data ?? r?.embeddings) as unknown;
  const first = Array.isArray(rows) ? rows[0] : null;
  return Array.isArray(first) && first.every((x) => typeof x === "number") ? (first as number[]) : null;
};

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};
