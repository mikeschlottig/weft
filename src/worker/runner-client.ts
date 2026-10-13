// merge-runner Container class + typed client. One container instance per repo:
// getContainer(env.MERGE_RUNNER, repo) — which also serializes trunk writes per repo.

import { Container, getContainer } from "@cloudflare/containers";
import { WeftError } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";
import type { BatchMember, DiffStats, RoomFile, SpeculationResult } from "../core/types.ts";

export class MergeRunner extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";
  enableInternet = true; // git talks to *.artifacts.cloudflare.net
}

interface TrunkRef {
  remote: string;
  token: string;
}
interface ForkRef {
  id: string;
  forkRemote: string;
  forkToken: string;
  branch: string;
  headCommit: string;
}
export interface SpecInput {
  trunk: TrunkRef;
  trunkHead: string;
  claimTime: number;
  checkCommand: string | null;
  unionGlobs: string[];
  members: (BatchMember & { forkToken: string })[];
}

const call = async <T>(env: Env, repo: string, path: string, body: unknown): Promise<T> =>
  withRetry(
    async () => {
      const stub = getContainer(env.MERGE_RUNNER, repo);
      const res = await stub.fetch(
        new Request(`http://runner${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
      const text = await res.text();
      let parsed: { ok: boolean; data?: T; error?: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> } };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch (err: unknown) {
        throw new WeftError("UPSTREAM_RUNNER", `runner ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`, { retryable: true, details: { parse: String(err) } });
      }
      if (parsed.ok && parsed.data !== undefined) return parsed.data;
      const e = parsed.error ?? { code: "UPSTREAM_RUNNER", message: `runner ${path} failed with ${res.status}` };
      throw new WeftError(e.code, e.message, { retryable: e.retryable ?? res.status >= 500, details: e.details ?? {} });
    },
    { attempts: 4, baseMs: 1_000, maxMs: 10_000, retryable: (err) => err instanceof WeftError && err.retryable && err.code !== "TRUNK_MOVED" },
  );

export const runner = (env: Env, repo: string) => ({
  prepare: (b: { trunk: TrunkRef; trunkHead: string; members: ForkRef[] }) => call<{ stats: Record<string, DiffStats> }>(env, repo, "/prepare", b),
  speculate: (b: SpecInput) => call<SpeculationResult>(env, repo, "/speculate", b),
  push: (b: { trunk: TrunkRef & { writeToken: string }; expectedOld: string; tip: string; rebuild: SpecInput }) =>
    call<{ pushed: true; tip: string }>(env, repo, "/push", b),
  revert: (b: { trunk: TrunkRef & { writeToken: string }; trunkHead: string; landedCommit: string; message: string; actor: string; claimTime: number }) =>
    call<{ commit: string }>(env, repo, "/revert", b),
  roomPrepare: (b: { trunk: TrunkRef; trunkHead: string; fork: RoomFork; unionGlobs: string[] }) =>
    call<{ trunkHead: string; base: string; clean: boolean; conflicted: string[]; files: RoomFile[] }>(env, repo, "/room-prepare", b),
  roomVerify: (b: {
    trunk: TrunkRef;
    trunkHead: string;
    fork: RoomFork & { writeToken: string };
    roomBranch: string;
    resolutions: { path: string; content: string }[];
    message: string;
    authorName: string;
    authorEmail: string;
    claimTime: number;
    checkCommand: string | null;
    unionGlobs: string[];
  }) =>
    call<{ candidate: string; tree: string; markersLeft: string[]; checkPassed: boolean | null; log: string; pushed: boolean; filesTouched: string[]; added: number; deleted: number }>(env, repo, "/room-verify", b),
  fastForward: (b: { trunk: TrunkRef; fork: { forkRemote: string; writeToken: string; readToken: string; branch: string }; expected: string; to: string; toRef: string }) =>
    call<{ branch: string; head: string }>(env, repo, "/fast-forward", b),
});

interface RoomFork {
  forkRemote: string;
  forkToken: string;
  branch: string;
  headCommit: string;
}
