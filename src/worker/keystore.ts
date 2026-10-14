// D6: the agent-token key store (D1 `signing_keys`) — mint, verify, rotate, publish.
// Verification keys are cached per isolate for 30 s; an unknown kid forces a re-read, so a rotation is
// visible on the next request everywhere (D1 is consistent), with no KV propagation window.

import { WeftError } from "../core/errors.ts";
import { type KeyRecord, type PublicKeyRecord, type SealedKeyRecord, ROTATE_AFTER_MS, newKey, seal, signEdDsa, tokenHeader, unseal, verifyToken } from "../core/keys.ts";
import type { AgentClaims } from "../core/types.ts";

interface Row {
  kid: string;
  state: "current" | "previous" | "retired";
  created_at: number;
  public_jwk: string;
  sealed_private: string;
}

const CACHE_MS = 30_000;
let cache: { at: number; keys: SealedKeyRecord[]; hs256Until: number } | null = null;

const read = async (env: Env): Promise<{ keys: SealedKeyRecord[]; hs256Until: number }> => {
  const rows = await env.DB.prepare("SELECT kid, state, created_at, public_jwk, sealed_private FROM signing_keys WHERE state IN ('current', 'previous') ORDER BY created_at DESC").all<Row>();
  const hs = await env.DB.prepare("SELECT v FROM settings WHERE k = 'hs256_until'").first<{ v: string }>();
  const keys = rows.results.map((r) => ({ kid: r.kid, state: r.state as "current" | "previous", createdAt: r.created_at, publicJwk: JSON.parse(r.public_jwk) as JsonWebKey, sealed: r.sealed_private }));
  // No row yet means no EdDSA key was ever created: HS256 is still the live scheme.
  return { keys, hs256Until: hs ? Number(hs.v) : Number.MAX_SAFE_INTEGER };
};

const keyset = async (env: Env, force = false): Promise<{ keys: SealedKeyRecord[]; hs256Until: number }> => {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const fresh = await read(env);
  cache = { at: Date.now(), ...fresh };
  return fresh;
};

/** First EdDSA key, created exactly once (the unique partial index makes concurrent bootstraps converge). */
const ensureCurrent = async (env: Env): Promise<KeyRecord> => {
  let ks = await keyset(env);
  let cur = ks.keys.find((k) => k.state === "current");
  if (!cur) {
    const fresh = await newKey(Date.now());
    const sealed = await seal(fresh, env.JWT_SIGNING_SECRET);
    // Tokens minted before this moment were HS256 with up to a 7-day lifetime: honour them for 7 more days.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO signing_keys (kid, state, created_at, public_jwk, sealed_private) SELECT ?, 'current', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM signing_keys WHERE state = 'current')").bind(sealed.kid, sealed.createdAt, JSON.stringify(sealed.publicJwk), sealed.sealed),
      env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('hs256_until', ?)").bind(String(Math.floor(Date.now() / 1000) + 7 * 86_400)),
    ]);
    ks = await keyset(env, true);
    cur = ks.keys.find((k) => k.state === "current");
    if (!cur) throw new WeftError("INTERNAL", "signing key bootstrap failed");
  }
  return unseal(cur, env.JWT_SIGNING_SECRET);
};

export const publicKeys = async (env: Env): Promise<PublicKeyRecord[]> => {
  await ensureCurrent(env);
  return (await keyset(env)).keys.map(({ sealed: _s, ...pub }) => pub);
};

export const keyStatus = async (env: Env): Promise<{ keys: { kid: string; state: string; createdAt: string }[]; hs256AcceptedUntil: string | null; nextRotationDue: string | null }> => {
  const ks = await keyset(env, true);
  const cur = ks.keys.find((k) => k.state === "current");
  return {
    keys: ks.keys.map((k) => ({ kid: k.kid, state: k.state, createdAt: new Date(k.createdAt).toISOString() })),
    hs256AcceptedUntil: ks.hs256Until === Number.MAX_SAFE_INTEGER ? null : new Date(ks.hs256Until * 1000).toISOString(),
    nextRotationDue: cur ? new Date(cur.createdAt + ROTATE_AFTER_MS).toISOString() : null,
  };
};

/** current → previous, previous → retired, a new current. Atomic (one D1 batch). */
export const rotateKeys = async (env: Env, actor: string): Promise<{ current: string; previous: string | null; retired: string | null; by: string }> => {
  await ensureCurrent(env);
  const ks = await keyset(env, true);
  const cur = ks.keys.find((k) => k.state === "current");
  const prev = ks.keys.find((k) => k.state === "previous");
  const fresh = await seal(await newKey(Date.now()), env.JWT_SIGNING_SECRET);
  await env.DB.batch([
    env.DB.prepare("UPDATE signing_keys SET state = 'retired' WHERE state = 'previous'"),
    env.DB.prepare("UPDATE signing_keys SET state = 'previous' WHERE state = 'current'"),
    env.DB.prepare("INSERT INTO signing_keys (kid, state, created_at, public_jwk, sealed_private) VALUES (?, 'current', ?, ?, ?)").bind(fresh.kid, fresh.createdAt, JSON.stringify(fresh.publicJwk), fresh.sealed),
  ]);
  cache = null;
  console.log(JSON.stringify({ level: "info", msg: "signing keys rotated", current: fresh.kid, previous: cur?.kid ?? null, retired: prev?.kid ?? null, by: actor }));
  return { current: fresh.kid, previous: cur?.kid ?? null, retired: prev?.kid ?? null, by: actor };
};

/** Cron: rotate when the current key is older than ROTATE_AFTER_MS. */
export const rotateIfDue = async (env: Env): Promise<boolean> => {
  const ks = await keyset(env, true);
  const cur = ks.keys.find((k) => k.state === "current");
  if (cur && Date.now() - cur.createdAt < ROTATE_AFTER_MS) return false;
  await rotateKeys(env, "weft-cron");
  return true;
};

/** Mint an EdDSA agent token and record the grant (who, how long, by which route). */
export const mintAgentToken = async (
  env: Env,
  agent: { id: string; name: string; model: string },
  ttlS: number,
  grant: { by: string; via: string; longLived: boolean },
): Promise<{ token: string; expiresAt: string; kid: string; jti: string }> => {
  const key = await ensureCurrent(env);
  const iat = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const claims: AgentClaims = { sub: agent.id, name: agent.name, model: agent.model, role: "agent", iat, exp: iat + ttlS, jti };
  const token = await signEdDsa(claims, key);
  await env.DB.prepare("INSERT INTO token_grants (jti, agent_id, ttl_s, long_lived, kid, granted_by, via, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(jti, agent.id, ttlS, grant.longLived ? 1 : 0, key.kid, grant.by, grant.via, Date.now())
    .run();
  return { token, expiresAt: new Date((iat + ttlS) * 1000).toISOString(), kid: key.kid, jti };
};

/** Verify any agent token (EdDSA by kid; HS256 during the migration window). Retries once on an unknown kid. */
export const verifyAgentToken = async (env: Env, token: string, nowSec: number): Promise<AgentClaims> => {
  let ks = await keyset(env);
  const kid = tokenHeader(token).kid;
  if (kid && !ks.keys.some((k) => k.kid === kid)) ks = await keyset(env, true);
  try {
    return await verifyToken(token, ks.keys, { secret: env.JWT_SIGNING_SECRET, allowedUntilSec: ks.hs256Until }, nowSec);
  } catch (err: unknown) {
    // A stale per-isolate key set (seen on production right after the first key bootstrap, 2026-10-14) can
    // reject a valid token. Re-read D1 once and verify again; a forged token still fails the second check.
    if (!(err instanceof WeftError) || err.code !== "UNAUTHENTICATED" || !/signature|unknown signing key/.test(err.message)) throw err;
    ks = await keyset(env, true);
    return verifyToken(token, ks.keys, { secret: env.JWT_SIGNING_SECRET, allowedUntilSec: ks.hs256Until }, nowSec);
  }
};
