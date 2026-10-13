// Tier E (build plan V-0.03): fixes for the verified 2026-10-13 review findings — pure-core parts.
// The runner parts (flake guard, non-monotonic bisection) are in runner.test.ts.
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { WeftError, infraFailure } from "../src/core/errors.ts";
import { forecast, reconcileDiff, scoreRisk } from "../src/core/forecast.ts";
import { entropy, highEntropyTokens, scanAddedLines } from "../src/core/rubric.ts";
import type { Provenance, RepoConfig, Workspace } from "../src/core/types.ts";

const CONFIG: RepoConfig = {
  checkCommand: "node --test",
  batchSize: 4,
  reviewThreshold: 60,
  sensitiveGlobs: ["src/auth/**"],
  unionGlobs: ["CHANGELOG.md"],
  leaseTtlSeconds: 1800,
  batchWindowMs: 2500,
  judge: { enabled: true, model: "@cf/cloudflare/clef", holdOnSecurity: 0.7, holdOnAlignment: 1.0 },
};

const prov = (over: Partial<Provenance> = {}): Provenance => ({
  agentId: "agt_a",
  agentName: "atlas",
  model: "m",
  task: "t",
  intentGlobs: ["src/billing/**"],
  filesTouched: ["src/billing/invoice.js"],
  linesAdded: 4,
  linesDeleted: 1,
  checkpoints: 0,
  forkHead: "a".repeat(40),
  promptSha256: null,
  toolCalls: null,
  costUsd: null,
  ...over,
});

test("E3 reconcileDiff: an honest claim re-scores identically and is not held", () => {
  const claimed = prov();
  const r = reconcileDiff(CONFIG, claimed, { files: ["src/billing/invoice.js"], added: 4, deleted: 1 }, 0, 0);
  assert.equal(r.underReported, false);
  assert.equal(r.hold, null);
  assert.equal(r.risk.score, scoreRisk(CONFIG, claimed, 0, 0).score);
  assert.deepEqual(r.prov.claimed, { filesTouched: ["src/billing/invoice.js"], linesAdded: 4, linesDeleted: 1 });
});

test("E3 reconcileDiff: hidden files or far more lines than claimed → held as under-reported", () => {
  const hidden = reconcileDiff(CONFIG, prov(), { files: ["src/billing/invoice.js", "src/auth/session.js"], added: 4, deleted: 1 }, 0, 0);
  assert.equal(hidden.underReported, true);
  assert.deepEqual(hidden.hidden, ["src/auth/session.js"]);
  assert.match(hidden.hold ?? "", /under-reported.*src\/auth\/session\.js/);
  assert.equal(hidden.risk.sensitive, true, "the authoritative diff exposes the sensitive path the claim hid");
  const big = reconcileDiff(CONFIG, prov(), { files: ["src/billing/invoice.js"], added: 900, deleted: 0 }, 0, 0);
  assert.equal(big.underReported, true);
  assert.match(big.hold ?? "", /900 changed lines vs 5 claimed/);
});

test("E3 reconcileDiff: small honest drift is tolerated (≤ 1.5× + 20 lines)", () => {
  const r = reconcileDiff(CONFIG, prov({ linesAdded: 10, linesDeleted: 0 }), { files: ["src/billing/invoice.js"], added: 30, deleted: 4 }, 0, 0);
  assert.equal(r.underReported, false);
});

test("E5 forecast: past the listing cap a shared prefix counts as a file overlap", () => {
  const peer: Workspace = {
    id: "ws-2", repo: "r", agentId: "agt_b", agentName: "birch", model: "m", task: "other", status: "active", forkRepo: "f", forkRemote: "x", branch: "weft/ws-2", baseCommit: "b".repeat(40),
    intent: { globs: ["src/billing/**"], mode: "soft", expiresAt: new Date(Date.now() + 60_000).toISOString() }, touched: [], touchedSymbols: {}, changesetId: null, rejections: 0, forkTokenId: null, createdAt: "", updatedAt: "",
  } as unknown as Workspace;
  const self = { wsId: "ws-1", globs: ["src/billing/**"], touched: [] };
  const normal = forecast([peer], self, [], CONFIG, Date.now());
  assert.equal(normal.overlaps[0]?.strength, "prefix");
  assert.equal(normal.risk, "low");
  const truncated = forecast([peer], self, [], CONFIG, Date.now(), { truncated: true });
  assert.equal(truncated.overlaps[0]?.strength, "files");
  assert.equal(truncated.risk, "medium");
  assert.match(truncated.advice, /truncated/);
});

test("E7 secret scan: high-entropy tokens are flagged; SHAs, integrity hashes, lockfiles and identifiers are not", () => {
  assert.ok(entropy("aaaa") === 0);
  const key = "Zq8vN3xT1pLm7RkW4bYc9HdF2sJg6AeU";
  assert.deepEqual(highEntropyTokens(`const k = "${key}";`), [key]);
  assert.deepEqual(highEntropyTokens(`commit ${"0123456789abcdef".repeat(2)}cafebabe`), []);
  assert.deepEqual(highEntropyTokens(`"integrity": "sha512-Zq8vN3xT1pLm7RkW4bYc9HdF2sJg6AeUZq8vN3xT1pLm7RkW4b=="`), []);
  assert.deepEqual(highEntropyTokens("const thisIsAVeryLongVariableNameWithoutDigits = 1;"), []);
  const diff = [
    "+++ b/src/config.js",
    `+export const upstream = "${key}";`,
    "+++ b/package-lock.json",
    `+  "resolved": "${key}",`,
  ].join("\n");
  assert.deepEqual(scanAddedLines(diff), ["high_entropy_string in src/config.js"]);
});

test("E4 infraFailure: platform errors are infra, changeset errors are not", () => {
  assert.equal(infraFailure(new WeftError("UPSTREAM_RUNNER", "runner /speculate returned non-JSON (503)", { retryable: true })), true);
  assert.equal(infraFailure(new Error("CHECK_FLAKY: the check is not deterministic on this batch")), true);
  assert.equal(infraFailure(new Error("Container suddenly disconnected")), true);
  assert.equal(infraFailure(new Error("HEAD_MISSING: changeset cs-0003: head abc not on its fork branch")), false);
  assert.equal(infraFailure(new Error(`HEAD_MISSING: head a5034b${"0".repeat(34)} missing`)), false, "a sha containing 503 is not an HTTP 503");
});

// ---- D6 / E8: EdDSA tokens, JWKS, rotation, sealing, TTL policy, Access roles
import { accessRole, jwks, newKey, seal, signEdDsa, tokenTtl, unseal, verifyToken } from "../src/core/keys.ts";
import { signJwt } from "../src/core/jwt.ts";

test("D6 keys: EdDSA tokens verify by kid; tampering, expiry and rotated-out keys are refused", async () => {
  const k1 = await newKey(1_000);
  const claims = { sub: "agt_1", name: "atlas", model: "m", role: "agent" as const, iat: 100, exp: 200, jti: "j1" };
  const tok = await signEdDsa(claims, k1);
  const hs = { secret: "s", allowedUntilSec: 0 };
  assert.deepEqual(await verifyToken(tok, [k1], hs, 150), claims);
  await assert.rejects(verifyToken(tok, [k1], hs, 250), /expired/);
  const [h, b, sig] = tok.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url")}.${sig}`;
  await assert.rejects(verifyToken(forged, [k1], hs, 150), /signature/);
  const k2 = await newKey(2_000);
  await assert.rejects(verifyToken(tok, [k2], hs, 150), /rotated out/);
  assert.equal(b !== undefined, true);
});

test("D6 keys: HS256 tokens verify only inside the migration window", async () => {
  const claims = { sub: "agt_1", name: "atlas", model: "m", role: "agent" as const, iat: 100, exp: 200 };
  const tok = await signJwt(claims, "secret");
  assert.deepEqual(await verifyToken(tok, [], { secret: "secret", allowedUntilSec: 1_000 }, 150), claims);
  await assert.rejects(verifyToken(tok, [], { secret: "secret", allowedUntilSec: 140 }, 150), /retired/);
});

test("D6 keys: private keys are sealed at rest (AES-GCM bound to the kid) and the JWKS carries no private part", async () => {
  const k = await newKey(5);
  const sealed = await seal(k, "deployment-secret");
  assert.equal(JSON.stringify(sealed).includes(String(k.privateJwk.d)), false);
  assert.deepEqual((await unseal(sealed, "deployment-secret")).privateJwk, k.privateJwk);
  await assert.rejects(unseal(sealed, "other-secret"));
  await assert.rejects(unseal({ ...sealed, kid: "ed-other" }, "deployment-secret")); // the kid is authenticated data
  const doc = jwks([k]);
  assert.deepEqual(Object.keys(doc.keys[0] ?? {}).sort(), ["alg", "crv", "kid", "kty", "use", "x"]);
  assert.equal(doc.keys[0]?.alg, "EdDSA");
});

test("E8 tokenTtl: default and max 1 h; long-lived only by explicit grant, ≤ 24 h", () => {
  assert.deepEqual(tokenTtl(null, false), { ttlS: 3600, clamped: false, longLived: false });
  assert.deepEqual(tokenTtl(2, false), { ttlS: 3600, clamped: true, longLived: false });
  assert.deepEqual(tokenTtl(0.5, false), { ttlS: 1800, clamped: false, longLived: false });
  assert.deepEqual(tokenTtl(6, true), { ttlS: 6 * 3600, clamped: false, longLived: true });
  assert.deepEqual(tokenTtl(168, true), { ttlS: 24 * 3600, clamped: true, longLived: true });
});

test("D6 Access roles: email, domain and group entries; admin beats reviewer; unknown → null", () => {
  const roles = { admins: ["mike@leverageai.network", "group:weft-admins"], reviewers: ["@example.com"] };
  assert.equal(accessRole({ email: "Mike@LeverageAI.network" }, roles), "admin");
  assert.equal(accessRole({ email: "x@corp.dev", groups: [{ id: "1", name: "weft-admins" }] }, roles), "admin");
  assert.equal(accessRole({ email: "ann@example.com" }, roles), "review");
  assert.equal(accessRole({ email: "eve@evil.example.com.attacker.io" }, roles), null);
  assert.equal(accessRole({ email: "ann@example.com.evil.io" }, roles), null);
  assert.equal(accessRole({}, roles), null);
});

import { toWeftError } from "../src/core/errors.ts";
test("transient platform errors are retryable UPSTREAM_PLATFORM; constraint errors stay INTERNAL", () => {
  const t = toWeftError(new Error("D1_ERROR: Network connection lost."));
  assert.equal(t.code, "UPSTREAM_PLATFORM");
  assert.equal(t.retryable, true);
  assert.equal(toWeftError(new Error("D1_ERROR: UNIQUE constraint failed: SQLITE_CONSTRAINT")).code, "INTERNAL");
  assert.equal(toWeftError(new Error("D1_ERROR: no such column: shard")).code, "INTERNAL");
});

