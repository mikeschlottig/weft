// The single retry primitive (house standard: ≥3 attempts, exponential backoff + jitter).
import { toWeftError } from "./errors.ts";

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  retryable?: (err: unknown) => boolean;
}

export const withRetry = async <T>(fn: (attempt: number) => Promise<T>, o: RetryOpts = {}): Promise<T> => {
  const attempts = Math.max(3, o.attempts ?? 3);
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      last = err;
      if (attempt === attempts || (o.retryable && !o.retryable(err))) break;
      const cap = Math.min(o.maxMs ?? 8_000, (o.baseMs ?? 200) * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, cap / 2 + Math.random() * (cap / 2)));
    }
  }
  throw toWeftError(last);
};

/** Git options that take their value as the next argument (`git -C dir fetch`, `git -c k=v push`). */
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/**
 * The git subcommand in an argument list, skipping global options (`--git-dir=…`, `-c k=v`, `-C dir`).
 * Retry decisions key on it: `git --git-dir=x fetch` is a network operation like `git fetch`.
 */
export const gitSubcommand = (args: readonly string[]): string | null => {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (GIT_OPTS_WITH_VALUE.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
};
