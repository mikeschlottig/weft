// RoomResolver Workflow — one instance per Conflict Room (FR-24, spec §9.7).
//
//   load → prepare (runner: base/ours/theirs per file) → up to 3 × [propose (Workers AI) → verify (runner:
//   merge commit on current trunk, no markers, repo check)] → verified | failed
//
// The model only proposes. A proposal is offered to the agent only after the runner built it as a merge
// commit (parents: trunk head, the rejected head) and the repo's check passed on that exact tree.
// Tokens are minted inside the steps that use them, so they never land in persisted step output.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { WeftError, decodeFromRpc } from "../core/errors.ts";
import { MAX_ROOM_ATTEMPTS, RESOLVER_MODEL, parseProposal, resolverMessages, responseText } from "../core/resolve.ts";
import type { MergeDriverRule, Room, RoomAttempt, RoomFile } from "../core/types.ts";
import { headOf, headerToken, mintToken } from "./artifacts.ts";
import { runner } from "./runner-client.ts";

interface Params {
  repo: string;
  roomId: string;
}

interface RoomInput {
  room: Room;
  trunkRepo: string;
  trunkRemote: string;
  forkRepo: string;
  forkRemote: string;
  branch: string;
  headCommit: string;
  message: string;
  checkCommand: string | null;
  unionGlobs: string[];
  drivers: MergeDriverRule[];
  workspaceStatus: string;
}

const STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
const AI_STEP = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
const LONG = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" } as const;

const rpc = async <T>(fn: () => Promise<unknown>): Promise<T> => {
  try {
    return JSON.parse(JSON.stringify(await fn())) as T;
  } catch (err: unknown) {
    const e = err instanceof WeftError ? err : decodeFromRpc(err);
    if (!e.retryable) throw new NonRetryableError(`${e.code}: ${e.message}`);
    throw e;
  }
};

export class RoomResolver extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const { repo, roomId } = event.payload;
    const coord = this.env.REPO.getByName(repo);
    try {
      const input = await step.do("load", STEP, () => rpc<RoomInput>(() => coord.roomInput(roomId)));
      if (input.room.status === "accepted" || input.room.status === "verified") return { skipped: input.room.status };

      const prep = await step.do("prepare", LONG, async () => {
        const trunkHead = await headOf(this.env, input.trunkRepo);
        if (!trunkHead) throw new NonRetryableError("trunk is empty");
        const trunkRead = headerToken((await mintToken(this.env, input.trunkRepo, "read", 1800)).plaintext);
        const forkRead = headerToken((await mintToken(this.env, input.forkRepo, "read", 1800)).plaintext);
        const r = await runner(this.env, repo).roomPrepare({
          trunk: { remote: input.trunkRemote, token: trunkRead },
          trunkHead,
          fork: { forkRemote: input.forkRemote, forkToken: forkRead, branch: input.branch, headCommit: input.headCommit },
          unionGlobs: input.unionGlobs,
          drivers: input.drivers,
        });
        await rpc(() => coord.roomUpdate(roomId, { status: "proposing", trunkHead: r.trunkHead, hunks: r.files }));
        return { trunkHead: r.trunkHead, clean: r.clean, files: r.files };
      });

      const room: Room = { ...input.room, trunkHead: prep.trunkHead, hunks: prep.files };
      const allowed = prep.files.map((f: RoomFile) => f.path);
      let previous: { attempt: RoomAttempt; log: string } | null = null;

      for (let n = 1; n <= MAX_ROOM_ATTEMPTS; n += 1) {
        const proposal = await step.do(`propose-${n}`, AI_STEP, async () => {
          const started = Date.now();
          const raw = await (this.env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> }).run(RESOLVER_MODEL, {
            messages: resolverMessages(room, prep.files, previous),
            max_tokens: 16_000,
            temperature: 0.1,
          });
          try {
            const p = parseProposal(responseText(raw), allowed);
            return { ok: true as const, files: p.files, rationale: p.rationale, ms: Date.now() - started, error: null };
          } catch (err: unknown) {
            // A malformed answer is a failed attempt (fed back to the next one), not a step failure.
            return { ok: false as const, files: [] as { path: string; content: string }[], rationale: "", ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
          }
        });

        const attempt = await step.do(`verify-${n}`, LONG, async (): Promise<{ attempt: RoomAttempt; log: string; verified: Room["verified"] }> => {
          const base: RoomAttempt = { n, model: RESOLVER_MODEL, files: proposal.files.map((f) => f.path), rationale: proposal.rationale, candidate: null, checkPassed: false, markersLeft: [], logKey: null, error: proposal.error, ms: proposal.ms };
          if (!proposal.ok) {
            await rpc(() => coord.roomUpdate(roomId, { status: "proposing", attempt: base }));
            return { attempt: base, log: `the proposal could not be parsed: ${proposal.error ?? ""}`, verified: null };
          }
          await rpc(() => coord.roomUpdate(roomId, { status: "verifying" }));
          const trunkRead = headerToken((await mintToken(this.env, input.trunkRepo, "read", 1800)).plaintext);
          const forkRead = headerToken((await mintToken(this.env, input.forkRepo, "read", 1800)).plaintext);
          const forkWrite = headerToken((await mintToken(this.env, input.forkRepo, "write", 600)).plaintext);
          const roomBranch = `weft/room/${roomId}`;
          const v = await runner(this.env, repo).roomVerify({
            trunk: { remote: input.trunkRemote, token: trunkRead },
            trunkHead: prep.trunkHead,
            fork: { forkRemote: input.forkRemote, forkToken: forkRead, writeToken: forkWrite, branch: input.branch, headCommit: input.headCommit },
            roomBranch,
            resolutions: proposal.files,
            message: `Resolve ${input.room.csId} against trunk (${roomId})\n\n${proposal.rationale}\n\nWeft-Room: ${roomId}\nWeft-Resolver-Model: ${RESOLVER_MODEL}\n`,
            authorName: "weft-resolver",
            authorEmail: "resolver@weft.dev",
            claimTime: Math.floor(Date.parse(input.room.createdAt) / 1000) + n,
            checkCommand: input.checkCommand,
            unionGlobs: input.unionGlobs,
            drivers: input.drivers,
          });
          let logKey: string | null = null;
          if (v.log) {
            logKey = `logs/${repo}/rooms/${roomId}/attempt-${n}.log`;
            await this.env.BLOBS.put(logKey, v.log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
          }
          const a: RoomAttempt = { ...base, candidate: v.candidate, checkPassed: v.markersLeft.length > 0 ? false : v.checkPassed, markersLeft: v.markersLeft, logKey };
          const green = v.pushed && a.checkPassed !== false;
          const verified = green ? { candidate: v.candidate, branch: roomBranch, filesTouched: v.filesTouched, added: v.added, deleted: v.deleted } : null;
          await rpc(() => coord.roomUpdate(roomId, { attempt: a, ...(verified ? { status: "verified" as const, verified } : {}) }));
          return { attempt: a, log: v.log, verified };
        });

        if (attempt.verified) return { verified: true, attempts: n, candidate: attempt.verified.candidate };
        previous = { attempt: attempt.attempt, log: attempt.log };
      }

      await step.do("fail", STEP, () => rpc<{ status: string }>(() => coord.roomUpdate(roomId, { status: "failed", error: `no proposal passed the check in ${MAX_ROOM_ATTEMPTS} attempts` })));
      return { verified: false, attempts: MAX_ROOM_ATTEMPTS };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      await step.do("fail-on-error", STEP, () => rpc<{ status: string }>(() => coord.roomUpdate(roomId, { status: "failed", error: `resolver error: ${reason.slice(0, 300)}` })));
      return { failed: reason };
    }
  }
}
