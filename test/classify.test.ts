// Decision-model classifiers (CLEF-flash): duplicate intent and the Conflict Room pre-screen.
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { DUPLICATE_P, ROOM_SCREEN_FLOOR, decideDuplicates, duplicateRequest, noulAnswers, readRoomScreen, roomScreenRequest } from "../src/core/classify.ts";
import { CLEF, DEFAULT_JUDGE, DEFAULT_LLM, DEFAULT_SECOND_OPINION, GEMMA_4 } from "../src/core/models.ts";
import type { Room, RoomFile } from "../src/core/types.ts";

test("models: CLEF scores, Gemma generates and gives the second opinion", () => {
  assert.equal(DEFAULT_JUDGE, CLEF);
  assert.equal(DEFAULT_SECOND_OPINION, GEMMA_4);
  assert.equal(DEFAULT_LLM, GEMMA_4);
});

test("classify: noulAnswers reads typed objects and bare numbers, clamps, nulls the rest", () => {
  const a = noulAnswers({ answers: { x: { noul: 0.9 }, y: 1.4, z: "nope" } }, ["x", "y", "z", "w"]);
  assert.deepEqual(a, { x: 0.9, y: 1, z: null, w: null });
  assert.deepEqual(noulAnswers(null, ["x"]), { x: null });
});

test("classify: duplicate request asks one noul per candidate, with the tasks in the state", () => {
  const r = duplicateRequest("add volume discount", [{ workspaceId: "ws-1", agentName: "cedar", task: "10% discount over $100" }, { workspaceId: "ws-2", agentName: "atlas", task: "sales tax" }]);
  assert.equal(r.model, "clef-flash");
  assert.deepEqual(Object.keys(r.questions), ["same_t0", "same_t1"]);
  assert.equal(r.questions.same_t0?.type, "noul");
  const st = JSON.parse(r.state) as { new_task: string; live_tasks: { id: string; agent: string }[] };
  assert.equal(st.new_task, "add volume discount");
  assert.equal(st.live_tasks[1]?.agent, "atlas");
});

test("classify: CLEF decides when it answered; embedding threshold is the fallback", () => {
  const cands = [{ id: "a", similarity: 0.61 }, { id: "b", similarity: 0.9 }, { id: "c", similarity: 0.7 }, { id: "d", similarity: 0.58 }];
  const out = decideDuplicates(cands, [0.93, 0.2, null, null], 0.68);
  // a: low similarity but CLEF says same work; b: high similarity but CLEF says different; c: fallback ≥ 0.68; d: fallback < 0.68
  assert.deepEqual(out.map((d) => [d.id, d.decidedBy]), [["a", "clef"], ["c", "embedding"]]);
  assert.ok(DUPLICATE_P === 0.5);
});

const room = { id: "r-1", agentName: "cedar", task: "add volume discount", peers: [{ changesetId: "cs-1", agentName: "atlas", task: "add sales tax", files: ["src/billing/invoice.js"] }] } as unknown as Room;
const files: RoomFile[] = [
  { path: "src/billing/invoice.js", conflicted: true, base: "", ours: "", theirs: "", merged: "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n", truncated: false },
  { path: "test/discount.test.js", conflicted: false, base: null, ours: null, theirs: "t", merged: null, truncated: false },
];

test("classify: room screen carries both intents, the conflict and the proposal; rejects only below the floor", () => {
  const r = roomScreenRequest(room, files, [{ path: "src/billing/invoice.js", content: "z" }]);
  const st = JSON.parse(r.state) as { already_on_trunk: { agent: string }[]; conflicts: { path: string }[]; proposed_resolution: { path: string }[] };
  assert.equal(st.already_on_trunk[0]?.agent, "atlas");
  assert.deepEqual(st.conflicts.map((c) => c.path), ["src/billing/invoice.js"]); // non-conflicted files are not sent
  assert.deepEqual(Object.keys(r.questions).sort(), ["keeps_change", "keeps_trunk"]);
  assert.equal(readRoomScreen("m", { answers: { keeps_change: { noul: 0.95 }, keeps_trunk: { noul: 0.9 } } }).reject, false);
  assert.equal(readRoomScreen("m", { answers: { keeps_change: { noul: 0.95 }, keeps_trunk: { noul: ROOM_SCREEN_FLOOR / 2 } } }).reject, true);
  assert.equal(readRoomScreen("m", {}).reject, false); // no answer → never blocks; the check decides
});
