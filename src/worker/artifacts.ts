// The ONLY module that touches env.ARTIFACTS (spec §8). Every call retries with backoff + jitter.
// Types come from `wrangler types` (worker-configuration.d.ts), verified 2026-10-12.

import { WeftError } from "../core/errors.ts";
import { codeOf, isRepoNotFound, isRetryableArtifactsError, isRetryableFreshArtifactsError } from "../core/artifacts-retry.ts";
import { withRetry } from "../core/retry.ts";

const FRESH = { retryable: isRetryableFreshArtifactsError, attempts: 5, baseMs: 300 } as const;

// ---- D7: namespace sharding. Shard k is the Artifacts binding ARTIFACTS (k = 0) or ARTIFACTS_S<k>, each bound to
// its own namespace (Artifacts limits control-plane calls per namespace: 2,000 requests / 10 s). A repo and all of
// its forks live in one shard, chosen at `init` (stable hash, recorded in D1 `repos.shard` and the coordinator's
// meta). Repos created before sharding are shard 0. Callers register the shard before any Artifacts call.

const shardOfRepo = new Map<string, number>();

/** Fork names are `<trunk>--<ws>` (trunk names are ≤ 41 chars, so the prefix survives fork-name hashing). */
export const trunkName = (name: string): string => name.split("--")[0] ?? name;

export const registerShard = (repo: string, shard: number): void => {
  shardOfRepo.set(trunkName(repo), shard);
};

/** Shards this deployment has bindings for (ARTIFACTS_SHARDS, default 1). */
export const shardCount = (env: Env): number => Math.max(1, Math.min(8, Number((env as unknown as { ARTIFACTS_SHARDS?: string }).ARTIFACTS_SHARDS ?? "1") || 1));

/** Stable placement for a new repo (FNV-1a of the name). */
export const pickShard = (repo: string, shards: number): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < repo.length; i += 1) {
    h ^= repo.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % Math.max(1, shards);
};

export const namespaceBinding = (env: Env, shard: number): Artifacts => {
  const b = shard === 0 ? env.ARTIFACTS : (env as unknown as Record<string, Artifacts | undefined>)[`ARTIFACTS_S${shard}`];
  if (!b) throw new WeftError("INTERNAL", `no Artifacts binding for shard ${shard} (ARTIFACTS_S${shard})`);
  return b;
};

// D7 limits dashboard: control-plane calls per trunk in this isolate over the last 10 s (a coordinator's own
// calls run in its isolate, so for the coordinator this is its true rate; retries are counted, they are calls).
const callLog = new Map<string, number[]>();
export const artifactsCalls10s = (repo: string): number => {
  const t = Date.now() - 10_000;
  const xs = (callLog.get(trunkName(repo)) ?? []).filter((x) => x > t);
  callLog.set(trunkName(repo), xs);
  return xs.length;
};

const ns = (env: Env, name: string): Artifacts => {
  const t = trunkName(name);
  const xs = callLog.get(t) ?? [];
  xs.push(Date.now());
  if (xs.length > 4_000) xs.splice(0, xs.length - 4_000);
  callLog.set(t, xs);
  return namespaceBinding(env, shardOfRepo.get(t) ?? 0);
};

/** Look up (and register) a repo's shard from D1 when this isolate has not seen it. Unknown → 0 (legacy). */
export const resolveShard = async (env: Env, repo: string): Promise<number> => {
  const t = trunkName(repo);
  const known = shardOfRepo.get(t);
  if (known !== undefined) return known;
  const row = await env.DB.prepare("SELECT shard FROM repos WHERE id = ?").bind(t).first<{ shard: number | null }>();
  const shard = row?.shard ?? 0;
  shardOfRepo.set(t, shard);
  return shard;
};

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
  call(`create ${repo}`, () => ns(env, repo).create(repo, { setDefaultBranch: "main", description }));

/** FR-39: import an external git remote (public HTTPS) as the trunk repo. */
export const importTrunk = (env: Env, repo: string, url: string, branch: string | undefined, description: string): Promise<ArtifactsCreateRepoResult> =>
  call(`import ${url} -> ${repo}`, () => ns(env, repo).import({ source: { url, ...(branch ? { branch } : {}) }, target: { name: repo, opts: { description } } }));

/** An import is asynchronous: `get()` throws IMPORT_IN_PROGRESS until it is ready. Wait (≈ 60 s budget). */
export const awaitImported = async (env: Env, name: string): Promise<ArtifactsRepoInfo> => {
  for (let i = 1; ; i += 1) {
    try {
      using r = await ns(env, name).get(name);
      return await r.info();
    } catch (err: unknown) {
      const c = codeOf(err);
      if (c !== "IMPORT_IN_PROGRESS" && c !== "NOT_FOUND" && c !== null) throw wrap(err, `import ${name}`);
      if (i >= 30) throw new WeftError("UPSTREAM_ARTIFACTS", `import of ${name} did not finish in time`, { retryable: true, hint: "retry `weft init --import` in a minute" });
      await new Promise((res) => setTimeout(res, Math.min(4_000, 500 * i) * (0.75 + Math.random() * 0.5)));
    }
  }
};

export const repoInfo = (env: Env, name: string, fresh = false): Promise<ArtifactsRepoInfo> =>
  call(`info ${name}`, async () => {
    using r = await ns(env, name).get(name);
    return r.info();
  }, fresh);

export const forkFrom = async (env: Env, trunk: string, name: string, description: string, allBranches = false): Promise<{ remote: string }> => {
  try {
    const res = await call(`fork ${trunk} -> ${name}`, async () => {
      using r = await ns(env, trunk).get(trunk);
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
    using r = await ns(env, name).get(name);
    return r.createToken(scope, ttl);
  }, fresh);

export const revokeToken = (env: Env, name: string, tokenId: string): Promise<boolean> =>
  call(`revoke ${name}`, async () => {
    using r = await ns(env, name).get(name);
    return r.revokeToken(tokenId);
  });

/** FR-40 kill switch: revoke every active token on a repo (agents may hold several after refreshes). */
export const revokeAllTokens = (env: Env, name: string): Promise<number> =>
  call(`revoke-all ${name}`, async () => {
    using r = await ns(env, name).get(name);
    const list = await r.listTokens();
    let n = 0;
    for (const t of list.tokens.filter((x) => x.state === "active")) if (await r.revokeToken(t.id)) n += 1;
    return n;
  });

export const headOf = (env: Env, name: string, ref = "main"): Promise<string | null> =>
  call(`log ${name}`, async () => {
    using r = await ns(env, name).get(name);
    const log = await r.log({ ref, limit: 1 });
    return log[0]?.hash ?? null;
  });

export const trunkLog = (env: Env, name: string, limit: number): Promise<ArtifactsCommitMetadata[]> =>
  call(`log ${name}`, async () => {
    using r = await ns(env, name).get(name);
    return r.log({ ref: "main", limit });
  });

/**
 * Paths that differ between two commits of one repo (spec §8.4): walk both root trees together and
 * descend only into entries whose hashes differ. Capped; used for push-derived heartbeats.
 */
export const changedPaths = (env: Env, name: string, from: string, to: string, cap = 2_000): Promise<string[]> =>
  call(`diff ${name} ${from.slice(0, 8)}..${to.slice(0, 8)}`, async () => {
    using r = await ns(env, name).get(name);
    const a = await r.readCommit(from);
    const b = await r.readCommit(to);
    if (!b) return [];
    const out: string[] = [];
    type Entry = { name: string; hash: string; type: string };
    const entries = async (hash: string | null): Promise<Map<string, Entry>> => {
      if (!hash) return new Map();
      const list = ((await r.readTree(hash)) ?? []) as Entry[];
      return new Map(list.map((e) => [e.name, e]));
    };
    const all = async (hash: string, prefix: string): Promise<void> => {
      for (const e of (await entries(hash)).values()) {
        if (out.length >= cap) return;
        if (e.type === "tree") await all(e.hash, `${prefix}${e.name}/`);
        else if (e.type !== "gitlink") out.push(`${prefix}${e.name}`);
      }
    };
    const walk = async (ha: string | null, hb: string | null, prefix: string): Promise<void> => {
      if (ha === hb || out.length >= cap) return;
      const ea = await entries(ha);
      const eb = await entries(hb);
      for (const n of new Set([...ea.keys(), ...eb.keys()])) {
        if (out.length >= cap) return;
        const x = ea.get(n);
        const y = eb.get(n);
        if (x && y && x.hash === y.hash) continue;
        const path = `${prefix}${n}`;
        const xt = x?.type === "tree";
        const yt = y?.type === "tree";
        if (xt || yt) {
          if (xt && yt) await walk(x?.hash ?? null, y?.hash ?? null, `${path}/`);
          else {
            if (xt && x) await all(x.hash, `${path}/`);
            if (yt && y) await all(y.hash, `${path}/`);
            if (!xt && x && x.type !== "gitlink") out.push(path);
            if (!yt && y && y.type !== "gitlink") out.push(path);
          }
        } else out.push(path);
      }
    };
    await walk(a?.treeHash ?? null, b.treeHash, "");
    return [...new Set(out)].sort();
  });

/** Recursive tree walk of a commit, capped for forecast use. `truncated` says the repo has more files than
 *  the cap (E5, review M1): callers must not treat an absent path as "no such file". */
export const listFiles = (env: Env, name: string, commit: string, cap = 5_000): Promise<{ files: string[]; truncated: boolean }> =>
  call(`tree ${name}@${commit.slice(0, 8)}`, async () => {
    using r = await ns(env, name).get(name);
    const c = await r.readCommit(commit);
    if (!c) return { files: [], truncated: false };
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
    return { files: out.slice(0, cap).sort(), truncated: out.length >= cap && (stack.length > 0 || out.length > cap) };
  });
