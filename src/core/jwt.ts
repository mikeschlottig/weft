// HS256 JWTs with WebCrypto — runs unchanged in Workers and Node ≥ 20.
import { unauthenticated } from "./errors.ts";
import type { AgentClaims } from "./types.ts";

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

const key = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export const signJwt = async (claims: AgentClaims, secret: string): Promise<string> => {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
};

export const verifyJwt = async (token: string, secret: string, nowSec: number): Promise<AgentClaims> => {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthenticated("malformed token");
  const [head, body, sig] = parts as [string, string, string];
  const ok = await crypto.subtle.verify("HMAC", await key(secret), b64urlDecode(sig), enc.encode(`${head}.${body}`));
  if (!ok) throw unauthenticated("bad token signature");
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as AgentClaims;
  if (typeof claims.exp !== "number" || claims.exp < nowSec) throw unauthenticated("token expired");
  return claims;
};
