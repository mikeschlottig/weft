// MergeQueue Workflow — one instance per batch (spec §9). Steps are idempotent; tokens are minted
// inside the steps that use them so they never land in persisted step output.
//
//   claim → prepare (authoritative diffs) → judge each (CLEF rubric; may hold for review)
//         → speculate + check + bisect (Container) → push with lease → verify → land

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { WeftError, decodeFromRpc } from "../core/errors.ts";
import { holdReason, preCheckGates } from "../core/rubric.ts";
import type { BatchClaim, DiffStats, GateResult, JudgeAnswers, Rejection } from "../core/types.ts";

type Claim = BatchClaim & { pre: Record<string, { gates: GateResult[]; judge: JudgeAnswers | null; behind: number; rejections: number }> };
import { headOf, headerToken, mintToken } from "./artifacts.ts";
import { judgeChangeset } from "./judge.ts";
import { runner, type SpecInput } from "./runner-client.ts";

interface Params {
  repo: string;
  batchId: string;
}

const STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
const LONG = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" } as const;

/** RPC/runner errors: retryable ones throw (Workflows retries); fatal ones stop retries. */
const rpc = async <T>(fn: () => Promise<unknown>): Promise<T> => {
  try {
    // DO RPC results carry a Disposable marker; step outputs must be plain JSON.
    return JSON.parse(JSON.stringify(await fn())) as T;
  } catch (err: unknown) {
    const e = err instanceof WeftError ? err : decodeFromRpc(err);
    if (!e.retryable) throw new NonRetryableError(`${e.code}: ${e.message}`);
    throw e;
  }
};

const forkTokens = async (env: Env, claim: BatchClaim, ids: string[]): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const m of claim.members.filter((x) => ids.includes(x.id))) out[m.id] = headerToken((await mintToken(env, m.forkRepo, "read", 1800)).plaintext);
  return out;
};

const specInput = async (env: Env, claim: BatchClaim, ids: string[]): Promise<SpecInput> => {
  const toks = await forkTokens(env, claim, ids);
  const trunkRead = headerToken((await mintToken(env, claim.trunkRepo, "read", 1800)).plaintext);
  return {
    trunk: { remote: claim.trunkRemote, token: trunkRead },
    trunkHead: claim.trunkHead,
    claimTime: claim.claimTime,
    checkCommand: claim.config.checkCommand,
    unionGlobs: claim.config.unionGlobs,
    drivers: claim.config.drivers ?? [],
    recipes: Object.fromEntries(Object.entries(claim.config.recipes ?? {}).map(([k, v]) => [k, { command: v.command }])),
    members: claim.members.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, forkToken: toks[m.id] ?? "" })),
  };
};

export class MergeQueue extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const { repo, batchId } = event.payload;
    const coord = this.env.REPO.getByName(repo);
    try {
      const claim = await step.do("claim", STEP, () => rpc<Claim | null>(() => coord.claimBatch(batchId)));
      if (!claim || claim.members.length === 0) return { idle: true };

      // 1. authoritative diffs, computed by the runner from the forks themselves
      const prepared = await step.do("prepare", STEP, async () => {
        const toks = await forkTokens(this.env, claim, claim.members.map((m) => m.id));
        const trunkRead = headerToken((await mintToken(this.env, claim.trunkRepo, "read", 1800)).plaintext);
        return rpc<{ stats: Record<string, DiffStats> }>(() =>
          runner(this.env, repo).prepare({
            trunk: { remote: claim.trunkRemote, token: trunkRead },
            trunkHead: claim.trunkHead,
            members: claim.members.map((m) => ({ id: m.id, forkRemote: m.forkRemote, forkToken: toks[m.id] ?? "", branch: m.branch, headCommit: m.headCommit })),
          }),
        );
      });

      // 2. rubric: deterministic gates + CLEF judge; hold rules route to a human before speculation
      const held: string[] = [];
      for (const m of claim.members) {
        const stats: DiffStats | undefined = prepared.stats[m.id];
        if (!stats) continue;
        const res = await step.do(`judge-${m.id}`, STEP, async () => {
          const gates = preCheckGates(stats, m.intentGlobs, claim.config);
          const judge = claim.config.judge.enabled
            ? await judgeChangeset(this.env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> }, claim.config.judge.model, {
                task: m.task,
                intentGlobs: m.intentGlobs,
                message: m.message,
                stats,
              })
            : null;
          const hold = holdReason(gates, judge, claim.config);
          return rpc<{ held: boolean }>(() => coord.recordJudgement(batchId, m.id, gates, judge, hold));
        });
        if (res.held) held.push(m.id);
      }
      const ids = claim.members.map((m) => m.id).filter((id) => !held.includes(id));
      if (ids.length === 0) {
        await step.do("land-empty", STEP, () =>
          rpc<{ idempotent: boolean }>(() => coord.landBatch({ batchId, trunkAfter: null, applied: [], rejected: [], checkPassed: {}, checksRun: 0, bisectSteps: 0, logKeys: {} })),
        );
        return { landed: 0, held: held.length };
      }

      // 3. speculative merge chain + merged-tree check + bisection (in the runner)
      const spec = await step.do("speculate", LONG, async () => {
        const input = await specInput(this.env, claim, ids);
        try {
          const r = await runner(this.env, repo).speculate(input);
          const logKeys: Record<string, string> = {};
          for (const l of r.logs) {
            const key = `logs/${repo}/${batchId}/check-${l.commit.slice(0, 12)}.log`;
            await this.env.BLOBS.put(key, l.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            for (const rej of r.rejected) if (rej.rejection.logKey === `commit:${l.commit}`) logKeys[rej.id] = key;
          }
          return { trunkRed: null as string | null, tip: r.tip, applied: r.applied, rejected: r.rejected, checkPassed: r.checkPassed, checksRun: r.checksRun, bisectSteps: r.bisectSteps, logKeys, readmitted: r.readmitted ?? [] };
        } catch (err: unknown) {
          if (err instanceof WeftError && err.code === "TRUNK_RED") {
            return { trunkRed: String(err.details.log ?? err.message), tip: claim.trunkHead, applied: [], rejected: [] as { id: string; rejection: Rejection }[], checkPassed: {}, checksRun: 1, bisectSteps: 0, logKeys: {}, readmitted: [] as string[] };
          }
          throw err;
        }
      });
      if (spec.trunkRed !== null) {
        const detail = spec.trunkRed;
        await step.do("trunk-red", STEP, () => rpc<null>(() => coord.trunkRed(batchId, detail)));
        return { trunkRed: true };
      }

      // 4. the single trunk write, with a compare-and-swap lease (verified against Artifacts 2026-10-12)
      if (spec.applied.length > 0) {
        const pushed = await step.do("push", STEP, async () => {
          const rebuild = await specInput(this.env, claim, ids);
          const write = headerToken((await mintToken(this.env, claim.trunkRepo, "write", 600)).plaintext);
          try {
            await runner(this.env, repo).push({ trunk: { ...rebuild.trunk, writeToken: write }, expectedOld: claim.trunkHead, tip: spec.tip, rebuild });
            return { moved: false };
          } catch (err: unknown) {
            if (err instanceof WeftError && err.code === "TRUNK_MOVED") return { moved: true };
            throw err;
          }
        });
        if (pushed.moved) {
          await step.do("requeue-moved", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, "trunk moved during validation")));
          return { requeued: "trunk moved" };
        }
        const head = await step.do("verify", STEP, () => headOf(this.env, claim.trunkRepo));
        if (head !== spec.tip) {
          await step.do("requeue-verify", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, `verify: main=${head ?? "none"} expected ${spec.tip}`)));
          return { requeued: "verify mismatch" };
        }
      }

      // 5. record outcomes + scorecards (idempotent on batchId)
      await step.do("land", STEP, () =>
        rpc<{ idempotent: boolean }>(() =>
          coord.landBatch({
            batchId,
            trunkAfter: spec.applied.length > 0 ? spec.tip : null,
            applied: spec.applied.map((a) => ({ id: a.id, commit: a.commit })),
            rejected: spec.rejected,
            checkPassed: spec.checkPassed,
            checksRun: spec.checksRun,
            bisectSteps: spec.bisectSteps,
            logKeys: spec.logKeys,
            readmitted: spec.readmitted,
          }),
        ),
      );
      return { landed: spec.applied.length, rejected: spec.rejected.length, held: held.length, checksRun: spec.checksRun };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      await step.do("requeue-on-failure", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, `workflow failed: ${reason.slice(0, 300)}`)));
      return { failed: reason };
    }
  }
}
