// The ONLY module that touches env.ARTIFACTS (spec §8). Every call retries with backoff + jitter.
// Types come from `wrangler types` (worker-configuration.d.ts), verified 2026-10-12.

import { WeftError } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";

const RETRYABLE = new Set(["INTERNAL_ERROR", "UPSTREAM_UNAVAILABLE", "CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);

const codeOf = (err: unknown): string | null =>
  typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string" ? (err as { code: string }).code : null;

export const isRetryableArtifactsError = (err: unknown): boolean => {
  const c = codeOf(err);
  return c === null || RETRYABLE.has(c);
};

const wrap = (err: unknown, what: string): WeftError => {
  const c = codeOf(err);
  if (err instanceof WeftError) return err;
  if (c === "NOT_FOUND") return new WeftError("NOT_FOUND", `${what}: not found`);
  if (c === "ALREADY_EXISTS") return new WeftError("ALREADY_EXISTS", `${what}: already exists`);
  return new WeftError("UPSTREAM_ARTIFACTS", `${what}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
};

const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await withRetry(fn, { retryable: isRetryableArtifactsError, baseMs: 300 });
  } catch (err: unknown) {
    throw wrap(err, what);
  }
};

/** Fork names must satisfy Artifacts name rules and stay ≤ 63 chars; long names get a hash suffix.
 *  Synchronous (FNV-1a) so it can run inside the coordinator's no-await decision block. */
export const forkName = (trunk: string, wsId: string): string => {
  const raw = `${trunk}--${wsId}`;
  if (raw.length <= 63) return raw;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${raw.slice(0, 54)}-${h.toString(16).padStart(8, "0")}`;
};

export const headerToken = (plaintext: string): string => plaintext.split("?expires=")[0] ?? plaintext;

export const createTrunk = (env: Env, repo: string, description: string): Promise<ArtifactsCreateRepoResult> =>
  call(`create ${repo}`, () => env.ARTIFACTS.create(repo, { setDefaultBranch: "main", description }));

export const repoInfo = (env: Env, name: string): Promise<ArtifactsRepoInfo> =>
  call(`info ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.info();
  });

export const forkFrom = async (env: Env, trunk: string, name: string, description: string): Promise<{ remote: string }> => {
  try {
    const res = await call(`fork ${trunk} -> ${name}`, async () => {
      using r = await env.ARTIFACTS.get(trunk);
      return r.fork(name, { defaultBranchOnly: true, description });
    });
    return { remote: res.remote };
  } catch (err: unknown) {
    // Idempotent retry: the fork exists from an earlier attempt — reuse it.
    if (err instanceof WeftError && err.code === "ALREADY_EXISTS") return { remote: (await repoInfo(env, name)).remote };
    throw err;
  }
};

export const mintToken = (env: Env, name: string, scope: "read" | "write", ttl: number): Promise<ArtifactsCreateTokenResult> =>
  call(`token ${scope} ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.createToken(scope, ttl);
  });

export const revokeToken = (env: Env, name: string, tokenId: string): Promise<boolean> =>
  call(`revoke ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.revokeToken(tokenId);
  });

export const headOf = (env: Env, name: string, ref = "main"): Promise<string | null> =>
  call(`log ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    const log = await r.log({ ref, limit: 1 });
    return log[0]?.hash ?? null;
  });

export const trunkLog = (env: Env, name: string, limit: number): Promise<ArtifactsCommitMetadata[]> =>
  call(`log ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.log({ ref: "main", limit });
  });

/** Recursive tree walk of a commit, descending only where needed; capped for forecast use. */
export const listFiles = (env: Env, name: string, commit: string, cap = 5_000): Promise<string[]> =>
  call(`tree ${name}@${commit.slice(0, 8)}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    const c = await r.readCommit(commit);
    if (!c) return [];
    const out: string[] = [];
    const stack: { hash: string; prefix: string }[] = [{ hash: c.treeHash, prefix: "" }];
    while (stack.length > 0 && out.length < cap) {
      const next = stack.pop();
      if (!next) break;
      const entries = (await r.readTree(next.hash)) ?? [];
      for (const e of entries) {
        const path = `${next.prefix}${e.name}`;
        if (e.type === "tree") stack.push({ hash: e.hash, prefix: `${path}/` });
        else if (e.type !== "gitlink") out.push(path);
      }
    }
    return out.sort();
  });
