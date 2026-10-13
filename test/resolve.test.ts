// Conflict Room resolver parsing (src/core/resolve.ts). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasConflictMarkers, parseProposal, resolverMessages, responseText } from "../src/core/resolve.ts";
import type { Room } from "../src/core/types.ts";

const room: Room = {
  id: "r-0001", repo: "shop", csId: "cs-0021", wsId: "ws-0004-cedar", agentId: "agt_c", agentName: "cedar",
  task: "add volume discount", intentGlobs: ["src/billing/**"], files: ["src/billing/invoice.js"],
  peers: [{ changesetId: "cs-0019", agentName: "atlas", task: "add sales tax", files: ["src/billing/invoice.js"] }],
  status: "proposing", trunkHead: "a".repeat(40), hunks: [], attempts: [], verified: null, resubmittedAs: null, error: null,
  createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
};

test("resolve: parses FILE blocks and the rationale", () => {
  const text = "=== FILE: src/billing/invoice.js ===\nexport const a = 1;\n=== END FILE ===\n=== FILE: test/discount.test.js ===\nok\n=== END FILE ===\nRATIONALE: discount before tax.";
  const p = parseProposal(text, ["src/billing/invoice.js", "test/discount.test.js"]);
  assert.deepEqual(p.files.map((f) => f.path), ["src/billing/invoice.js", "test/discount.test.js"]);
  assert.equal(p.files[0]?.content, "export const a = 1;\n");
  assert.equal(p.rationale, "discount before tax.");
});

test("resolve: refuses paths outside the room and empty proposals", () => {
  assert.throws(() => parseProposal("=== FILE: src/auth/session.js ===\nx\n=== END FILE ===", ["src/billing/invoice.js"]), /outside the room/);
  assert.throws(() => parseProposal("I could not do it.", ["src/billing/invoice.js"]), /no FILE blocks/);
  assert.throws(() => parseProposal("=== FILE: src/billing/invoice.js ===\nx", ["src/billing/invoice.js"]), /unterminated/);
});

test("resolve: reads both Workers AI output shapes", () => {
  assert.equal(responseText({ response: "a" }), "a");
  assert.equal(responseText({ choices: [{ message: { content: "b" } }] }), "b");
  assert.throws(() => responseText({ nope: 1 }), /unrecognized/);
});

test("resolve: conflict marker detection and retry prompt carries the check log", () => {
  assert.equal(hasConflictMarkers("a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n"), true);
  assert.equal(hasConflictMarkers("const s = '=======';\n"), false);
  const msgs = resolverMessages(room, [{ path: "src/billing/invoice.js", conflicted: true, base: "b", ours: "o", theirs: "t", merged: "m", truncated: false }], {
    attempt: { n: 1, model: "m", files: ["src/billing/invoice.js"], rationale: "", candidate: "c", checkPassed: false, markersLeft: [], logKey: null, error: null, ms: 1 },
    log: "not ok 1 - expected 180, got 194.4",
  });
  assert.match(msgs[1]?.content ?? "", /check FAILED/);
  assert.match(msgs[1]?.content ?? "", /expected 180/);
  assert.match(msgs[0]?.content ?? "", /src\/billing\/invoice\.js/);
});
