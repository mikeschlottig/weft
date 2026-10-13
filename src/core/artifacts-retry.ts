// Retry classification for Artifacts errors. Cloudflare-free so it is unit-testable under plain Node.

const RETRYABLE = new Set(["INTERNAL_ERROR", "UPSTREAM_UNAVAILABLE", "CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);

export const codeOf = (err: unknown): string | null =>
  typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string" ? (err as { code: string }).code : null;

export const isRetryableArtifactsError = (err: unknown): boolean => {
  const c = codeOf(err);
  return c === null || RETRYABLE.has(c);
};

/** For a repo Weft created moments ago, NOT_FOUND is read-after-create lag, not absence: retry it.
 *  Seen live 2026-10-12: `fork()` returned, then `createToken` on the fork 200 ms later threw
 *  "Repository not found" and the workspace was abandoned with zero retries. */
export const isRetryableFreshArtifactsError = (err: unknown): boolean => {
  const c = codeOf(err);
  return isRetryableArtifactsError(err) || c === "NOT_FOUND" || (err instanceof Error && /repository not found/i.test(err.message));
};

/** True when the error means the named repo does not exist (raw Artifacts error or a converted WeftError). */
export const isRepoNotFound = (err: unknown): boolean =>
  codeOf(err) === "NOT_FOUND" || (err instanceof Error && /repository not found/i.test(err.message));
