// Rejection reasons name the failing test, not package-manager noise (src/core/check-log.ts).
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureExcerpt } from "../src/core/check-log.ts";

// Shape of the live log from eval-is-number-7fc1 cs-0020 (2026-10-15): mocha on stdout, npm install warnings on stderr after it.
const MOCHA_THEN_NPM_WARN = [
  "$ npm install --no-audit --no-fund && npm test",
  "# commit b6fd831a2dd2fffdeb3176b20c2ed94e6ce6351c",
  "",
  "added 178 packages in 12s",
  "",
  "> is-number@7.0.0 test",
  "> mocha",
  "  is a number",
  '    ✓ "5e3" should be a number',
  '    1) "   56\\r\\n  " should be a number',
  "  48 passing (12ms)",
  "  1 failing",
  "",
  '  1) is a number',
  '       "   56\\r\\n  " should be a number:',
  "     AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
  "",
  "npm warn deprecated graceful-fs@3.0.12: please upgrade to graceful-fs 4 for compatibility with current and future versions of Node.js",
  "npm warn deprecated natives@1.1.6: This module relies on Node.js's internals and will break at some point. Do not use it, and update to graceful-fs@4.x.",
  "npm warn deprecated source-map-resolve@0.5.3: See https://github.com/lydell/source-map-resolve#deprecated",
  "npm warn deprecated mkdirp@0.5.1: Legacy versions of mkdirp are no longer supported. Please update to mkdirp 1.x.",
  "",
  "# exit 1",
].join("\n");

test("failureExcerpt: drops npm install warnings so the failing assertion is shown", () => {
  const x = failureExcerpt(MOCHA_THEN_NPM_WARN);
  assert.match(x, /1 failing/);
  assert.match(x, /AssertionError/);
  assert.doesNotMatch(x, /npm warn/);
  assert.doesNotMatch(x, /# exit 1/);
});

test("failureExcerpt: bounded length, newest output kept", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const x = failureExcerpt(long, 100);
  assert.equal(x.length, 100);
  assert.ok(x.startsWith("…"));
  assert.match(x, /line 199$/);
});

test("failureExcerpt: pip noise dropped, pytest failure kept", () => {
  const log = ["Collecting pytest", "Downloading pytest-8.3.4-py3-none-any.whl", "Successfully installed pytest-8.3.4", "FAILED tests/test_calc.py::test_add - assert 3 == 4", "1 failed, 4 passed in 0.12s", "# exit 1"].join("\n");
  const x = failureExcerpt(log);
  assert.match(x, /FAILED tests\/test_calc.py::test_add/);
  assert.doesNotMatch(x, /Collecting|Successfully installed/);
});

test("failureExcerpt: a log of only noise falls back to the plain tail", () => {
  const log = "npm warn deprecated a@1\n# exit 1";
  assert.equal(failureExcerpt(log), log);
});
