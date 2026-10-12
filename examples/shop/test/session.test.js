import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpired } from "../src/auth/session.js";

test("fresh sessions are not expired", () => {
  assert.equal(isExpired(0, 60), false);
});
