// FR-48 calibration sweep (src/core/calibration.ts). Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate, sweep, type LabeledRow } from "../src/core/calibration.ts";

const row = (bad: boolean, intent: number, sec: number, held = false): LabeledRow => ({ bad, held, signals: { intentAlignment: intent, securityConcern: sec } });

test("calibration: the best intent threshold separates bad (low intent) from good", () => {
  const rows = [row(true, 0.5, 0.1), row(true, 0.9, 0.2), row(false, 2.5, 0.1), row(false, 2.8, 0.05), row(false, 1.9, 0.3)];
  const r = sweep(rows, "intentAlignment");
  assert.equal(r.best?.threshold, 0.9);
  assert.equal(r.best?.precision, 1);
  assert.equal(r.best?.recall, 1);
});

test("calibration: high-direction signals and the insufficient-data note", () => {
  const rows = [row(true, 2, 0.9, true), row(false, 2, 0.1), row(false, 2, 0.2)];
  const c = calibrate(rows);
  assert.equal(c.sufficient, false);
  assert.match(c.note, /Only 3 labeled/);
  assert.equal(c.signals.find((s) => s.signal === "securityConcern")?.best?.threshold, 0.9);
  assert.equal(c.autoLandPrecision, 1);
});
