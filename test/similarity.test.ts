// FR-09 similarity helpers (src/core/similarity.ts). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { cosine, parseEmbedding } from "../src/core/similarity.ts";

test("similarity: cosine basics and embedding output shapes", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 2], [1]), 0);
  assert.deepEqual(parseEmbedding({ data: [[0.1, 0.2]], shape: [1, 2] }), [0.1, 0.2]);
  assert.deepEqual(parseEmbedding({ result: { data: [[0.3]] } }), [0.3]);
  assert.deepEqual(parseEmbedding({ embeddings: [[0.4]] }), [0.4]);
  assert.equal(parseEmbedding({ nope: true }), null);
});
