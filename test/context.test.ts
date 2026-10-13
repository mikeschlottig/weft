// Context pack Markdown (src/core/context.ts). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContextPack, contextMarkdown } from "../src/core/context.ts";

const pack: ContextPack = {
  workspace: { id: "ws-0004-cedar", status: "active", task: "add volume discount", intent: ["src/billing/**"], mode: "soft", leaseExpiresAt: "2026-10-13T06:00:00Z", expired: true, base: "a".repeat(40), trunkHead: "b".repeat(40), touched: ["src/billing/invoice.js", "test/discount.test.js"], outOfIntent: ["test/discount.test.js"], changeset: "cs-0024" },
  forecast: { risk: "high", advice: "Another agent has already modified the same files." },
  peers: [{ agent: "atlas", workspace: "ws-0002-atlas", task: "add sales tax", mode: "soft", strength: "touched", files: ["src/billing/invoice.js"], theirIntent: ["src/billing/**"], theirTouched: ["src/billing/invoice.js"] }],
  rooms: [{ room: "r-0035", status: "verified", changeset: "cs-0024", files: ["src/billing/invoice.js"], verified: "c".repeat(40) }],
  history: [{ changeset: "cs-0024", status: "rejected", message: "Add 10% volume discount", rejection: { reason: "conflict", files: ["src/billing/invoice.js"], conflictsWith: ["cs-0019 (atlas)"] }, wqs: 52, advice: ["sync before submitting"] }],
  recentLandingsInScope: [{ changeset: "cs-0019", agent: "atlas", model: "claude-opus-5-5", message: "Add 8% sales tax", commit: "d".repeat(40), files: ["src/billing/invoice.js"], wqs: 90, landedAt: "2026-10-13T05:05:41Z", afterMyBase: true }],
  scopeFiles: ["src/billing/invoice.js"],
  conventions: { checkCommand: "node --test", unionMergedFiles: ["CHANGELOG.md"], sensitivePaths: ["src/auth/**"], sensitiveInMyScope: [], reviewThreshold: 60, rubric: "wqs-1" },
  recentEvents: [],
  next: ["weft resume", "weft room accept r-0035"],
  budget: { tokens: 6000, trimmed: [], used: 900 },
};

test("context: markdown names the expired lease, the peer, the verified room and the rule set", () => {
  const md = contextMarkdown(pack, "shop");
  assert.match(md, /^# Weft context — shop · ws-0004-cedar/);
  assert.match(md, /EXPIRED.*weft resume/);
  assert.match(md, /\*\*atlas\*\*.*touched/);
  assert.match(md, /weft room accept r-0035/);
  assert.match(md, /Outside your intent.*test\/discount\.test\.js/);
  assert.match(md, /after you started: sync/);
  assert.match(md, /`node --test`/);
});
