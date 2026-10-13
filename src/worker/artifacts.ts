// The ONLY module that touches env.ARTIFACTS (spec §8). Every call retries with backoff + jitter.
// Types come from `wrangler types` (worker-configuration.d.ts), verified 2026-10-12.

import { WeftError } from "../core/errors.ts";
import { codeOf, isRepoNotFound, isRetryableArtifactsError, isRetryableFreshArtifactsError } from "../core/artifacts-retry.ts";
import { withRetry } from "../core/retry.ts";

const FRESH = { retryable: isRetryableFreshArtifactsError, attempts: 5, baseMs: 300 } as const;

const wrap = (err: unknown, what: string): WeftError => {
  const c = codeOf(err);
  if (err instanceof WeftError) return err;
  if (c === "NOT_FOUND") return new WeftError("NOT_FOUND", `${what}: not found`);
  if (c === "ALREADY_EXISTS") return new WeftError("ALREADY_EXISTS", `${what}: already exists`);
  return new WeftError("UPSTREAM_ARTIFACTS", `${what}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
};

const call = async <T>(what: string, fn: () => Promise<T>, fresh = false): Promise<T> => {
  try {
    return await withRetry(fn, fresh ? FRESH : { retryable: isRetryableArtifactsError, baseMs: 300 });
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

export const repoInfo = (env: Env, name: string, fresh = false): Promise<ArtifactsRepoInfo> =>
  call(`info ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.info();
  }, fresh);

export const forkFrom = async (env: Env, trunk: string, name: string, description: string, allBranches = false): Promise<{ remote: string }> => {
  try {
    const res = await call(`fork ${trunk} -> ${name}`, async () => {
      using r = await env.ARTIFACTS.get(trunk);
      return r.fork(name, { defaultBranchOnly: !allBranches, description });
    });
    return { remote: res.remote };
  } catch (err: unknown) {
    // Idempotent retry: the fork exists from an earlier attempt — reuse it.
    if (err instanceof WeftError && err.code === "ALREADY_EXISTS") return { remote: (await repoInfo(env, name, true)).remote };
    throw err;
  }
};

/** Fork + write token, verified. Seen live 2026-10-12 with four concurrent forks of one trunk: `fork()`
 *  resolved, yet the fork never existed (still absent minutes later). Retrying reads cannot fix that,
 *  so a fork that is still missing after the fresh-read retries is forked again (3 attempts). */
export const provisionFork = async (
  env: Env,
  trunk: string,
  name: string,
  description: string,
  ttl: number,
  allBranches = false,
): Promise<{ remote: string; token: ArtifactsCreateTokenResult; forkAttempts: number }> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const fork = await forkFrom(env, trunk, name, description, allBranches);
      const token = await mintToken(env, name, "write", ttl, true);
      return { remote: fork.remote, token, forkAttempts: attempt };
    } catch (err: unknown) {
      last = err;
      if (!isRepoNotFound(err)) throw err;
      console.warn(JSON.stringify({ event: "artifacts.fork_vanished", trunk, name, attempt }));
    }
  }
  throw last;
};

/** `fresh`: the repo was created by Weft in this same request — retry NOT_FOUND (read-after-create lag). */
export const mintToken = (env: Env, name: string, scope: "read" | "write", ttl: number, fresh = false): Promise<ArtifactsCreateTokenResult> =>
  call(`token ${scope} ${name}`, async () => {
    using r = await env.ARTIFACTS.get(name);
    return r.createToken(scope, ttl);
  }, fresh);

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
