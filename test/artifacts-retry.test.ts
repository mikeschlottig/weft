// Retry classification for Artifacts calls (src/core/artifacts-retry.ts, used by src/worker/artifacts.ts). Regression for the live
// 2026-10-12 race: createToken on a just-forked repo threw "Repository not found" and was not retried.
// Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRepoNotFound, isRetryableArtifactsError, isRetryableFreshArtifactsError } from "../src/core/artifacts-retry.ts";
import { WeftError } from "../src/core/errors.ts";
import { withRetry } from "../src/core/retry.ts";

const coded = (code: string, message = code): Error & { code: string } => Object.assign(new Error(message), { code });

test("artifacts retry: NOT_FOUND is final for existing repos, retryable for fresh ones", () => {
  assert.equal(isRetryableArtifactsError(coded("NOT_FOUND")), false);
  assert.equal(isRetryableFreshArtifactsError(coded("NOT_FOUND")), true);
  assert.equal(isRetryableFreshArtifactsError(coded("SOMETHING", "Repository not found: shop--ws-0005-dune.")), true);
  assert.equal(isRetryableFreshArtifactsError(coded("ALREADY_EXISTS")), false);
  assert.equal(isRetryableFreshArtifactsError(coded("INVALID_NAME")), false);
  assert.equal(isRetryableArtifactsError(coded("FORK_IN_PROGRESS")), true);
});

test("artifacts retry: a fresh fork that appears on the 3rd read succeeds", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw coded("NOT_FOUND", "Repository not found: shop--ws-0005-dune.");
      return "token";
    },
    { retryable: isRetryableFreshArtifactsError, attempts: 5, baseMs: 1 },
  );
  assert.equal(out, "token");
  assert.equal(calls, 3);
});

test("artifacts retry: a vanished fork is recognised after conversion to WeftError (triggers a re-fork)", () => {
  // withRetry converts the raw Artifacts error to WeftError("INTERNAL", <message>), so the code is lost.
  assert.equal(isRepoNotFound(new WeftError("INTERNAL", "Repository not found: shop--ws-0004-atlas.")), true);
  assert.equal(isRepoNotFound(coded("NOT_FOUND", "nope")), true);
  assert.equal(isRepoNotFound(new WeftError("INTERNAL", "upstream timeout")), false);
});
