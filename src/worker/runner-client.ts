// merge-runner Container class + typed client. One container instance per repo *lane*:
// getContainer(env.MERGE_RUNNER, "<repo>" | "<repo>#lane-<k>"). Each instance runs one batch at a time;
// lanes run in parallel (E1). Trunk writes stay single-writer through the push's --force-with-lease
// compare-and-swap plus the Workflow's read-back verify, not through container placement.

import { Container, getContainer } from "@cloudflare/containers";
import { WeftError } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";
import type { BatchMember, DiffStats, MergeDriverRule, RoomFile, SpeculationResult } from "../core/types.ts";

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
  drivers: MergeDriverRule[];
  recipes: Record<string, { command: string }>;
  signingKey?: string;
  members: (BatchMember & { forkToken: string })[];
}

/** FR-33: the SSH signing key secret, if configured (optional so an unsigned deployment still works). */
export const signingKey = (env: Env): string | undefined => (env as unknown as { WEFT_SIGNING_KEY?: string }).WEFT_SIGNING_KEY || undefined;

/** Lane 0 keeps the historical per-repo instance name, so rooms/reverts and lane 0 share a warm cache. */
export const runnerKey = (repo: string, lane = 0): string => (lane > 0 ? `${repo}#lane-${lane}` : repo);

const call = async <T>(env: Env, key: string, path: string, body: unknown): Promise<T> =>
  withRetry(
    async () => {
      const stub = getContainer(env.MERGE_RUNNER, key);
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

export const runner = (env: Env, repo: string, lane = 0) => {
  const key = runnerKey(repo, lane);
  return {
    prepare: (b: { trunk: TrunkRef; trunkHead: string; members: ForkRef[] }) => call<{ stats: Record<string, DiffStats> }>(env, key, "/prepare", b),
    speculate: (b: SpecInput) => call<SpeculationResult>(env, key, "/speculate", b),
    push: (b: { trunk: TrunkRef & { writeToken: string }; expectedOld: string; tip: string; rebuild: SpecInput; notes?: { commit: string; text: string }[] }) =>
      call<{ pushed: true; tip: string; notesPushed: boolean }>(env, key, "/push", b),
    revert: (b: { trunk: TrunkRef & { writeToken: string }; trunkHead: string; landedCommit: string; message: string; actor: string; claimTime: number; signingKey?: string }) =>
      call<{ commit: string }>(env, key, "/revert", b),
    roomPrepare: (b: { trunk: TrunkRef; trunkHead: string; fork: RoomFork; unionGlobs: string[]; drivers: MergeDriverRule[] }) =>
      call<{ trunkHead: string; base: string; clean: boolean; conflicted: string[]; files: RoomFile[] }>(env, key, "/room-prepare", b),
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
      drivers: MergeDriverRule[];
    }) =>
      call<{ candidate: string; tree: string; markersLeft: string[]; checkPassed: boolean | null; log: string; pushed: boolean; filesTouched: string[]; added: number; deleted: number }>(env, key, "/room-verify", b),
    notes: (b: { trunk: TrunkRef & { writeToken: string }; notes: { commit: string; text: string }[]; claimTime: number }) =>
      call<{ notesPushed: boolean }>(env, key, "/notes", b),
    fastForward: (b: { trunk: TrunkRef; fork: { forkRemote: string; writeToken: string; readToken: string; branch: string }; expected: string; to: string; toRef: string }) =>
      call<{ branch: string; head: string }>(env, key, "/fast-forward", b),
    mirror: (b: { trunk: TrunkRef; trunkHead: string; target: { url: string; authHeader: string } }) =>
      call<{ pushed: string; notes: boolean; remoteMain: string | null }>(env, key, "/mirror", b),
  };
};

interface RoomFork {
  forkRemote: string;
  forkToken: string;
  branch: string;
  headCommit: string;
}
