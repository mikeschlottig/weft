// D6: humans through Cloudflare Access — the Worker's auth module with a stub env and ctx.access.
// Typechecked with tsconfig.worker-tests.json (Worker + Node types). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate, optionalAuth, requireReviewer } from "../src/worker/auth.ts";
test("D6 Access: ctx.access identity → role; role-less users are anonymous on reads, refused on writes", async () => {
  const env = { ADMIN_TOKEN: "admin-secret-token", CONFIG: { get: async () => ({ admins: ["mike@leverageai.network"], reviewers: ["@example.com"] }) } } as unknown as Env;
  const ctxFor = (email: string) => ({ access: { aud: "weft", getIdentity: async () => ({ email }) } }) as unknown as ExecutionContext;
  const req = new Request("https://weft.test/v1/repos/r/snapshot");
  const admin = await authenticate(req, env, ctxFor("Mike@LeverageAI.network"));
  assert.equal(admin.role, "admin");
  assert.equal(admin.sub, "human:mike@leverageai.network");
  const reviewer = await authenticate(req, env, ctxFor("ann@example.com"));
  assert.equal(reviewer.role, "review");
  requireReviewer(reviewer);
  assert.equal(await optionalAuth(req, env, ctxFor("eve@other.org")), null, "no role → anonymous for public reads");
  await assert.rejects(authenticate(req, env, ctxFor("eve@other.org")), /no Weft role/);
  await assert.rejects(authenticate(req, env, undefined), /missing bearer token/);
  const breakGlass = await authenticate(new Request("https://weft.test/x", { headers: { authorization: "Bearer admin-secret-token" } }), env, undefined);
  assert.equal(breakGlass.role, "admin");
});
