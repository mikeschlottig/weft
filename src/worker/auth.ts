// Principals (spec §12, D6):
//  - agents: EdDSA JWTs (kid → /.well-known/jwks.json), ≤ 1 h, minted by POST /v1/agents or refreshed;
//  - humans: Cloudflare Access in front of the Worker → ctx.access.getIdentity() → role from KV `access/roles`;
//  - the admin token: break-glass for operators and scripts (constant-time compare).

import { forbidden, unauthenticated } from "../core/errors.ts";
import { type AccessRoles, accessRole } from "../core/keys.ts";
import type { AgentClaims } from "../core/types.ts";
import { verifyAgentToken } from "./keystore.ts";

const ADMIN: Omit<AgentClaims, "iat" | "exp"> = { sub: "admin", name: "admin", model: "human", role: "admin" };

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const bearer = (req: Request): string | null => {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  // Browsers cannot set headers on WebSockets: the token rides in Sec-WebSocket-Protocol ("weft", "<token>").
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) {
    const parts = proto.split(",").map((s) => s.trim());
    const tok = parts.find((p) => p !== "weft");
    if (tok) return tok;
  }
  return null;
};

const NO_ROLES: AccessRoles = { admins: [], reviewers: [] };
let rolesCache: { at: number; roles: AccessRoles } | null = null;
const accessRoles = async (env: Env): Promise<AccessRoles> => {
  if (rolesCache && Date.now() - rolesCache.at < 30_000) return rolesCache.roles;
  const raw = await env.CONFIG.get<Partial<AccessRoles>>("access/roles", "json");
  const roles = { admins: raw?.admins ?? [], reviewers: raw?.reviewers ?? [] };
  rolesCache = { at: Date.now(), roles: raw ? roles : NO_ROLES };
  return rolesCache.roles;
};

/** A human authenticated by Cloudflare Access, mapped to a Weft role. Null when Access did not run. */
export const accessPrincipal = async (env: Env, exec: ExecutionContext | undefined): Promise<AgentClaims | null> => {
  const access = (exec as (ExecutionContext & { access?: CloudflareAccessContext }) | undefined)?.access;
  if (!access) return null;
  const id = await access.getIdentity();
  if (!id?.email) throw unauthenticated("Cloudflare Access identity has no email");
  const role = accessRole(id, await accessRoles(env));
  if (!role) throw forbidden(`${id.email} is signed in through Access but has no Weft role (ask an admin to add it to access/roles)`);
  const nowSec = Math.floor(Date.now() / 1000);
  return { sub: `human:${id.email.toLowerCase()}`, name: id.email.toLowerCase(), model: "human", role, iat: nowSec, exp: nowSec + 300 };
};

export const authenticate = async (req: Request, env: Env, exec?: ExecutionContext): Promise<AgentClaims> => {
  const tok = bearer(req);
  if (!tok) {
    const human = await accessPrincipal(env, exec);
    if (human) return human;
    throw unauthenticated("missing bearer token");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (env.ADMIN_TOKEN && timingSafeEqual(tok, env.ADMIN_TOKEN)) return { ...ADMIN, iat: nowSec, exp: nowSec + 60 };
  return verifyAgentToken(env, tok, nowSec);
};

export const optionalAuth = async (req: Request, env: Env, exec?: ExecutionContext): Promise<AgentClaims | null> => {
  if (bearer(req)) return authenticate(req, env, exec);
  return accessPrincipal(env, exec);
};

export const requireAdmin = (c: AgentClaims): void => {
  if (c.role !== "admin") throw forbidden("this action needs the admin token or an Access admin");
};

/** Approve/reject: admins and Access reviewers. */
export const requireReviewer = (c: AgentClaims): void => {
  if (c.role !== "admin" && c.role !== "review") throw forbidden("this action needs a reviewer (Cloudflare Access) or the admin token");
};
