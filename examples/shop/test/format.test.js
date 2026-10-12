import { test } from "node:test";
import assert from "node:assert/strict";
import { pad } from "../src/util/format.js";

test("pad left-pads with zeros", () => {
  assert.equal(pad(7, 3), "007");
});
