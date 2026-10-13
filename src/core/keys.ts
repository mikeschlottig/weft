// D6 (PRD M1 "JWT rotation"): EdDSA (Ed25519) agent tokens with key ids, a public JWKS, rotation with a
// one-key overlap, and private keys encrypted at rest. WebCrypto only — runs unchanged in Workers and Node.
//
// Lifecycle: `current` signs; `previous` still verifies (tokens live ≤ 1 h, rotation is weekly), so a rotation
// never logs anyone out. HS256 tokens from before the first EdDSA key verify only until `hs256Until`.

import { unauthenticated } from "./errors.ts";
import { verifyJwt as verifyHs256 } from "./jwt.ts";
import type { AgentClaims } from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

export interface PublicKeyRecord {
  kid: string;
  createdAt: number; // ms
  publicJwk: JsonWebKey;
  state: "current" | "previous";
}
export interface KeyRecord extends PublicKeyRecord {
  privateJwk: JsonWebKey;
}
/** At rest: the private JWK sealed with AES-GCM under a key derived (HKDF) from the deployment secret. */
export interface SealedKeyRecord extends PublicKeyRecord {
  sealed: string; // b64url(iv || ciphertext)
}

/** Default and maximum agent token lifetime (spec §12: exp ≤ 1 h). Longer lifetimes are an audited admin grant. */
export const AGENT_TOKEN_TTL_S = 3600;
export const MAX_LONG_LIVED_TTL_S = 24 * 3600;
export const ROTATE_AFTER_MS = 7 * 86_400_000;

const sealingKey = async (secret: string): Promise<CryptoKey> => {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("weft/jwks/v1"), info: enc.encode("private-jwk-seal") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export const seal = async (rec: KeyRecord, secret: string): Promise<SealedKeyRecord> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(rec.kid) }, await sealingKey(secret), enc.encode(JSON.stringify(rec.privateJwk))));
  const both = new Uint8Array(iv.length + ct.length);
  both.set(iv);
  both.set(ct, iv.length);
  return { kid: rec.kid, createdAt: rec.createdAt, publicJwk: rec.publicJwk, state: rec.state, sealed: b64url(both) };
};

export const unseal = async (rec: SealedKeyRecord, secret: string): Promise<KeyRecord> => {
  const both = b64urlDecode(rec.sealed);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: both.slice(0, 12), additionalData: enc.encode(rec.kid) }, await sealingKey(secret), both.slice(12));
  return { kid: rec.kid, createdAt: rec.createdAt, publicJwk: rec.publicJwk, state: rec.state, privateJwk: JSON.parse(dec.decode(pt)) as JsonWebKey };
};

/** A fresh Ed25519 key. The kid is the RFC 7638 thumbprint (sha-256 of the canonical public JWK), truncated. */
export const newKey = async (nowMs: number): Promise<KeyRecord> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const thumb = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x }))));
  const kid = `ed-${b64url(thumb).slice(0, 16)}`;
  const clean = (j: JsonWebKey): JsonWebKey => ({ kty: j.kty, crv: j.crv, x: j.x, ...(j.d ? { d: j.d } : {}) });
  return { kid, createdAt: nowMs, publicJwk: clean(pub), privateJwk: clean(priv), state: "current" };
};

/** The public JWKS document (`/.well-known/jwks.json`). */
export const jwks = (keys: readonly PublicKeyRecord[]): { keys: (JsonWebKey & { kid: string; use: string; alg: string })[] } => ({
  keys: keys.map((k) => ({ kty: k.publicJwk.kty ?? "OKP", crv: k.publicJwk.crv ?? "Ed25519", x: k.publicJwk.x ?? "", kid: k.kid, use: "sig", alg: "EdDSA" })),
});

export const signEdDsa = async (claims: AgentClaims, key: KeyRecord): Promise<string> => {
  const head = b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.kid })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const k = await crypto.subtle.importKey("jwk", { ...key.privateJwk, kty: "OKP", crv: "Ed25519" }, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
};

export const tokenHeader = (token: string): { alg?: string; kid?: string } => {
  const head = token.split(".")[0];
  if (!head) throw unauthenticated("malformed token");
  try {
    return JSON.parse(dec.decode(b64urlDecode(head))) as { alg?: string; kid?: string };
  } catch (err: unknown) {
    throw unauthenticated(`malformed token header (${String(err)})`);
  }
};

/**
 * Verify an agent token. EdDSA tokens must name a kid present in `keys`; HS256 tokens are accepted only while
 * `hs256AllowedUntilSec` is in the future (the migration window for tokens minted before the first EdDSA key).
 */
export const verifyToken = async (
  token: string,
  keys: readonly PublicKeyRecord[],
  hs: { secret: string; allowedUntilSec: number },
  nowSec: number,
): Promise<AgentClaims> => {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthenticated("malformed token");
  const header = tokenHeader(token);
  if (header.alg === "HS256") {
    if (nowSec >= hs.allowedUntilSec) throw unauthenticated("HS256 agent tokens were retired by key rotation", "re-register the agent or run `weft agent refresh` with a current token");
    return verifyHs256(token, hs.secret, nowSec);
  }
  if (header.alg !== "EdDSA") throw unauthenticated(`unsupported token algorithm: ${String(header.alg)}`);
  const rec = keys.find((k) => k.kid === header.kid);
  if (!rec) throw unauthenticated(`unknown signing key ${String(header.kid)} (rotated out)`, "run `weft agent refresh` or ask an admin for a new token");
  const [head, body, sig] = parts as [string, string, string];
  const k = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: rec.publicJwk.x ?? "" }, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, k, b64urlDecode(sig), enc.encode(`${head}.${body}`));
  if (!ok) throw unauthenticated("bad token signature");
  const claims = JSON.parse(dec.decode(b64urlDecode(body))) as AgentClaims;
  if (typeof claims.exp !== "number" || claims.exp < nowSec) throw unauthenticated("token expired", "weft agent refresh");
  return claims;
};

/** Clamp a requested agent token lifetime: ≤ 1 h unless an admin explicitly grants a long-lived token (≤ 24 h). */
export const tokenTtl = (requestedHours: number | null, longLived: boolean): { ttlS: number; clamped: boolean; longLived: boolean } => {
  const reqS = requestedHours === null ? AGENT_TOKEN_TTL_S : Math.max(300, Math.round(requestedHours * 3600));
  if (longLived) {
    const ttlS = Math.min(MAX_LONG_LIVED_TTL_S, reqS);
    return { ttlS, clamped: ttlS < reqS, longLived: ttlS > AGENT_TOKEN_TTL_S };
  }
  const ttlS = Math.min(AGENT_TOKEN_TTL_S, reqS);
  return { ttlS, clamped: ttlS < reqS, longLived: false };
};

// ---- Humans through Cloudflare Access (ctx.access.getIdentity())

export interface AccessRoles {
  /** Entries: "user@example.com", "@example.com" (whole domain) or "group:<name>". */
  admins: string[];
  reviewers: string[];
}

const matchesEntry = (entry: string, email: string, groups: readonly string[]): boolean => {
  const e = entry.trim().toLowerCase();
  if (e.startsWith("group:")) return groups.some((g) => g.toLowerCase() === e.slice(6));
  if (e.startsWith("@")) return email.endsWith(e);
  return email === e;
};

/** Map an Access identity to a Weft role (admin > review), or null if the person has no role here. */
export const accessRole = (identity: { email?: string; groups?: unknown }, roles: AccessRoles): "admin" | "review" | null => {
  const email = (identity.email ?? "").toLowerCase();
  if (!email) return null;
  const groups = Array.isArray(identity.groups)
    ? identity.groups.map((g: unknown) => (typeof g === "string" ? g : g && typeof g === "object" && "name" in g ? String((g as { name: unknown }).name) : "")).filter((g) => g.length > 0)
    : [];
  if (roles.admins.some((x) => matchesEntry(x, email, groups))) return "admin";
  if (roles.reviewers.some((x) => matchesEntry(x, email, groups))) return "review";
  return null;
};

// ---- Sealed secrets (D5 mirror credentials): same HKDF-derived AES-GCM key, bound to a purpose label.

export const sealText = async (plain: string, secret: string, purpose: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(purpose) }, await sealingKey(secret), enc.encode(plain)));
  const both = new Uint8Array(iv.length + ct.length);
  both.set(iv);
  both.set(ct, iv.length);
  return b64url(both);
};

export const unsealText = async (sealed: string, secret: string, purpose: string): Promise<string> => {
  const both = b64urlDecode(sealed);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: both.slice(0, 12), additionalData: enc.encode(purpose) }, await sealingKey(secret), both.slice(12)));
};

/** The HTTP auth header git sends to a mirror: GitHub wants Basic x-access-token:<token>; Artifacts wants Bearer. */
export const mirrorAuthHeader = (kind: "github" | "bearer", token: string): string =>
  kind === "github" ? `Authorization: Basic ${btoa(`x-access-token:${token}`)}` : `Authorization: Bearer ${token.split("?expires=")[0] ?? token}`;
