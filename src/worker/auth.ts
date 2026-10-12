// Principals: agents (HS256 JWT minted by POST /v1/agents) and the admin token (humans, M0).
// M1 replaces the admin token with Cloudflare Access for humans (spec §12).

import { forbidden, unauthenticated } from "../core/errors.ts";
import { verifyJwt } from "../core/jwt.ts";
import type { AgentClaims } from "../core/types.ts";

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

export const authenticate = async (req: Request, env: Env): Promise<AgentClaims> => {
  const tok = bearer(req);
  if (!tok) throw unauthenticated("missing bearer token");
  const nowSec = Math.floor(Date.now() / 1000);
  if (env.ADMIN_TOKEN && timingSafeEqual(tok, env.ADMIN_TOKEN)) return { ...ADMIN, iat: nowSec, exp: nowSec + 60 };
  return verifyJwt(tok, env.JWT_SIGNING_SECRET, nowSec);
};

export const optionalAuth = async (req: Request, env: Env): Promise<AgentClaims | null> => (bearer(req) ? authenticate(req, env) : null);

export const requireAdmin = (c: AgentClaims): void => {
  if (c.role !== "admin") throw forbidden("this action needs the admin token");
};
