import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/billing/invoice.js";

test("total sums price * qty", () => {
  assert.equal(total([{ price: 10, qty: 2 }]), 20);
});
