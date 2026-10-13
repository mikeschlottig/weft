// FR-05 push events (src/core/push.ts). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePushed, trunkOf } from "../src/core/push.ts";

const ev = { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "weft-dev", repoName: "shop--ws-0004-cedar" }, payload: { ref: "refs/heads/weft/ws-0004-cedar", before: "a".repeat(40), after: "b".repeat(40) } };

test("push: parses the documented event and an envelope around it", () => {
  assert.deepEqual(parsePushed(ev), { repoName: "shop--ws-0004-cedar", ref: "refs/heads/weft/ws-0004-cedar", after: "b".repeat(40) });
  assert.deepEqual(parsePushed({ payload: ev }), parsePushed(ev));
  assert.equal(parsePushed({ source: { repoName: "x" }, payload: { ref: "r", after: "nope" } }), null);
});

test("push: trunk of a fork name, null for the trunk itself", () => {
  assert.equal(trunkOf("shop--ws-0004-cedar"), "shop");
  assert.equal(trunkOf("shop-live1--ws-0012-a-very-long-agent-name-1234-1a2b3c4d"), "shop-live1");
  assert.equal(trunkOf("shop"), null);
});
