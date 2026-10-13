// MergeQueue Workflow — one instance per batch (spec §9). Steps are idempotent; tokens are minted
// inside the steps that use them so they never land in persisted step output.
//
//   claim → prepare (authoritative diffs) → judge each (CLEF rubric; may hold for review)
//         → speculate + check + bisect (Container) → push with lease → verify → land

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { WeftError, decodeFromRpc, infraFailure } from "../core/errors.ts";
import { holdReason, preCheckGates } from "../core/rubric.ts";
import type { BatchClaim, DiffStats, GateResult, JudgeAnswers, Rejection } from "../core/types.ts";

type Claim = BatchClaim & { pre: Record<string, { gates: GateResult[]; judge: JudgeAnswers | null; behind: number; rejections: number }> };
import { headOf, headerToken, mintToken, resolveShard } from "./artifacts.ts";
import { judgeChangeset } from "./judge.ts";
import { pushMirror } from "./mirror.ts";
import { runner, signingKey, type SpecInput } from "./runner-client.ts";

interface Params {
  repo: string;
  batchId: string;
}

const STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
const LONG = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" } as const;

/** RPC/runner errors: retryable ones throw (Workflows retries); fatal ones stop retries. */
const rpc = async <T>(fn: () => Promise<unknown>): Promise<T> => {
  try {
    // DO RPC results carry a Disposable marker; step outputs must be plain JSON (a void method → null).
    const v: unknown = await fn();
    return (v === undefined ? null : JSON.parse(JSON.stringify(v))) as T;
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
    signingKey: signingKey(env),
    members: claim.members.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, forkToken: toks[m.id] ?? "" })),
  };
};

export class MergeQueue extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const { repo, batchId } = event.payload;
    const coord = this.env.REPO.getByName(repo);
    let landed: Parameters<typeof coord.landBatch>[0] | null = null;
    try {
      await resolveShard(this.env, repo); // D7: Artifacts calls below go to this repo's namespace shard
      const claim = await step.do("claim", STEP, () => rpc<Claim | null>(() => coord.claimBatch(batchId)));
      if (!claim || claim.members.length === 0) return { idle: true };
      const lane = claim.lane ?? 0; // E1: this batch's own merge-runner instance

      // 1. authoritative diffs, computed by the runner from the forks themselves
      const prepared = await step.do("prepare", STEP, async () => {
        const toks = await forkTokens(this.env, claim, claim.members.map((m) => m.id));
        const trunkRead = headerToken((await mintToken(this.env, claim.trunkRepo, "read", 1800)).plaintext);
        return rpc<{ stats: Record<string, DiffStats> }>(() =>
          runner(this.env, repo, lane).prepare({
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
          const ai = this.env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> };
          const jin = { task: m.task, intentGlobs: m.intentGlobs, message: m.message, stats };
          const primary = claim.config.judge.enabled ? await judgeChangeset(ai, claim.config.judge.model, jin) : null;
          // FR-48: an independent second opinion (default clef-flash; JEV-compatible System One API).
          const secondModel = claim.config.judge.enabled ? (claim.config.judge.secondOpinion === undefined ? "@cf/cloudflare/clef-flash" : claim.config.judge.secondOpinion) : null;
          const second = primary && secondModel ? await judgeChangeset(ai, secondModel, jin) : null;
          const judge = primary
            ? {
                ...primary,
                second: second ? { model: second.model, intentAlignment: second.intentAlignment, securityConcern: second.securityConcern, error: second.error } : null,
                disagreement:
                  second && primary.intentAlignment !== null && second.intentAlignment !== null ? Math.round(Math.abs(primary.intentAlignment - second.intentAlignment) * 100) / 100 : null,
              }
            : null;
          const hold = holdReason(gates, judge, claim.config);
          return rpc<{ held: boolean }>(() => coord.recordJudgement(batchId, m.id, gates, judge, hold, { files: stats.files, added: stats.added, deleted: stats.deleted }));
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
        const startedAt = Date.now();
        try {
          const r = await runner(this.env, repo, lane).speculate(input);
          const endedAt = Date.now();
          const logKeys: Record<string, string> = {};
          for (const l of r.logs) {
            const key = `logs/${repo}/${batchId}/check-${l.commit.slice(0, 12)}.log`;
            await this.env.BLOBS.put(key, l.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            for (const rej of r.rejected) if (rej.rejection.logKey === `commit:${l.commit}`) logKeys[rej.id] = key;
          }
          return { trunkRed: null as string | null, tip: r.tip, applied: r.applied, rejected: r.rejected, checkPassed: r.checkPassed, checksRun: r.checksRun, bisectSteps: r.bisectSteps, logKeys, readmitted: r.readmitted ?? [], flaky: r.flaky ?? [], alreadyLanded: r.alreadyLanded ?? [], speculation: { lane, startedAt, endedAt } };
        } catch (err: unknown) {
          if (err instanceof WeftError && err.code === "TRUNK_RED") {
            return { trunkRed: String(err.details.log ?? err.message), tip: claim.trunkHead, applied: [], rejected: [] as { id: string; rejection: Rejection }[], checkPassed: {}, checksRun: 1, bisectSteps: 0, logKeys: {}, readmitted: [] as string[], flaky: [] as string[], alreadyLanded: [] as { id: string; commit: string }[], speculation: { lane, startedAt, endedAt: Date.now() } };
          }
          // A deterministic runner verdict (e.g. CHECK_FLAKY, HEAD_MISSING) must not be retried by Workflows.
          if (err instanceof WeftError && !err.retryable) throw new NonRetryableError(`${err.code}: ${err.message}`);
          throw err;
        }
      });
      if (spec.trunkRed !== null) {
        const detail = spec.trunkRed;
        await step.do("trunk-red", STEP, () => rpc<null>(() => coord.trunkRed(batchId, detail)));
        return { trunkRed: true };
      }

      // 4. the single trunk write, with a compare-and-swap lease (verified against Artifacts 2026-10-12).
      //    FR-26: if another lane landed first (TRUNK_MOVED), re-speculate this lane on the new trunk —
      //    full chain + one check on the new merged tip — and push again, instead of requeueing.
      let final = { trunkHead: claim.trunkHead, tip: spec.tip, applied: spec.applied, rejected: spec.rejected, checkPassed: spec.checkPassed, checksRun: spec.checksRun, bisectSteps: spec.bisectSteps, logKeys: spec.logKeys, readmitted: spec.readmitted, flaky: spec.flaky, alreadyLanded: spec.alreadyLanded };
      let rebases = 0;
      if (final.applied.length > 0) {
        for (let attempt = 1; ; attempt += 1) {
          const at = final;
          const pushed = await step.do(`push-${attempt}`, STEP, async () => {
            const rebuild = { ...(await specInput(this.env, claim, ids)), trunkHead: at.trunkHead };
            const write = headerToken((await mintToken(this.env, claim.trunkRepo, "write", 600)).plaintext);
            try {
              await runner(this.env, repo, lane).push({ trunk: { ...rebuild.trunk, writeToken: write }, expectedOld: at.trunkHead, tip: at.tip, rebuild });
              return { moved: false };
            } catch (err: unknown) {
              if (err instanceof WeftError && err.code === "TRUNK_MOVED") return { moved: true };
              throw err;
            }
          });
          if (!pushed.moved) break;
          if (attempt >= 3) {
            await step.do("requeue-moved", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, "trunk moved during validation")));
            return { requeued: "trunk moved" };
          }
          const respec = await step.do(`rebase-${attempt}`, LONG, async () => {
            const head = await headOf(this.env, claim.trunkRepo);
            if (!head) throw new NonRetryableError("trunk vanished");
            const input = { ...(await specInput(this.env, claim, final.applied.map((a) => a.id))), trunkHead: head };
            try {
              const r = await runner(this.env, repo, lane).speculate(input);
              return { trunkRed: false, head, r };
            } catch (err: unknown) {
              if (err instanceof WeftError && err.code === "TRUNK_RED") return { trunkRed: true, head, r: null };
              throw err;
            }
          });
          if (respec.trunkRed || !respec.r) {
            await step.do("requeue-red-after-move", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, "trunk moved and is red")));
            return { requeued: "trunk moved and is red" };
          }
          rebases += 1;
          const r = respec.r;
          final = {
            trunkHead: respec.head,
            tip: r.tip,
            applied: r.applied,
            rejected: [...final.rejected, ...r.rejected],
            checkPassed: { ...final.checkPassed, ...r.checkPassed },
            checksRun: final.checksRun + r.checksRun,
            bisectSteps: final.bisectSteps + r.bisectSteps,
            logKeys: final.logKeys,
            readmitted: [...final.readmitted, ...(r.readmitted ?? [])],
            flaky: [...new Set([...final.flaky, ...(r.flaky ?? [])])],
            alreadyLanded: [...final.alreadyLanded, ...(r.alreadyLanded ?? []).filter((x) => !final.alreadyLanded.some((y) => y.id === x.id))],
          };
          if (final.applied.length === 0) break;
        }
        if (final.applied.length > 0) {
          const head = await step.do("verify", STEP, () => headOf(this.env, claim.trunkRepo));
          if (head !== final.tip) {
            await step.do("requeue-verify", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, `verify: main=${head ?? "none"} expected ${final.tip}`)));
            return { requeued: "verify mismatch" };
          }
        }
      }

      // From here on the batch IS on trunk: a later failure must record the landing, never requeue (requeueing
      // re-applied 16 already-landed changesets in the 500-agent swarm, 2026-10-13).
      if (final.applied.length > 0 || final.alreadyLanded.length > 0) {
        landed = {
          batchId,
          trunkAfter: final.applied.length > 0 ? final.tip : null,
          applied: [...final.applied.map((a) => ({ id: a.id, commit: a.commit })), ...final.alreadyLanded],
          rejected: final.rejected,
          checkPassed: final.checkPassed,
          checksRun: final.checksRun,
          bisectSteps: final.bisectSteps,
          logKeys: final.logKeys,
          readmitted: final.readmitted,
          laneRebases: rebases,
          flaky: final.flaky,
        };
      }

      // 5. FR-34 provenance bundles in R2 (content-addressed by sha256), linked from trunk by git notes.
      //    Runs after the push because a rebased lane's commits differ from the first speculation.
      if (final.applied.length > 0) {
        const landed = final.applied;
        await step.do("provenance", STEP, async () => {
          const bundles = await rpc<{ csId: string; bundle: Record<string, unknown> }[]>(() => coord.provenanceFor(batchId, landed.map((a) => a.id)));
          const notes: { commit: string; text: string }[] = [];
          for (const b of bundles) {
            const commit = landed.find((a) => a.id === b.csId)?.commit;
            if (!commit) continue;
            const body = JSON.stringify({ ...b.bundle, commit, batchId, laneRebases: rebases }, null, 2);
            const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((x) => x.toString(16).padStart(2, "0")).join("");
            const key = `prov/${repo}/${b.csId}.json`;
            await this.env.BLOBS.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: sha, commit } });
            notes.push({ commit, text: `weft-provenance v1\nchangeset: ${b.csId}\nbundle: r2://${key}\nsha256: ${sha}\nfetch: /v1/repos/${repo}/changesets/${b.csId}/provenance\n` });
          }
          const write = headerToken((await mintToken(this.env, claim.trunkRepo, "write", 600)).plaintext);
          const r = await runner(this.env, repo, lane).notes({ trunk: { remote: claim.trunkRemote, token: write, writeToken: write }, notes, claimTime: claim.claimTime });
          return { notes: notes.length, pushed: r.notesPushed };
        });
      }

      // 6. record outcomes + scorecards (idempotent on batchId)
      await step.do("land", STEP, () =>
        rpc<{ idempotent: boolean }>(() =>
          coord.landBatch({
            batchId,
            trunkAfter: final.applied.length > 0 ? final.tip : null,
            applied: [...final.applied.map((a) => ({ id: a.id, commit: a.commit })), ...final.alreadyLanded],
            rejected: final.rejected,
            checkPassed: final.checkPassed,
            checksRun: final.checksRun,
            bisectSteps: final.bisectSteps,
            logKeys: final.logKeys,
            readmitted: final.readmitted,
            laneRebases: rebases,
            flaky: final.flaky,
            speculation: spec.speculation,
          }),
        ),
      );
      // 7. D5 mirror-out: an exact copy of trunk (main + provenance notes) on the configured remote. Best effort:
      //    a mirror outage is recorded and reported, never allowed to undo or block a landing.
      if (final.applied.length > 0) {
        const tip = final.tip;
        const mirrored = await step.do("mirror", STEP, async () => {
          const r = await pushMirror(this.env, repo, claim.trunkRemote, tip, lane);
          if (r) await rpc<null>(() => coord.mirrorResult({ ok: r.ok, pushed: r.pushed, remoteMain: r.remoteMain, error: r.error }));
          return r ? { ok: r.ok } : null;
        });
        if (mirrored && !mirrored.ok) console.log(JSON.stringify({ level: "warn", msg: "mirror push failed", repo, batchId }));
      }
      return { landed: final.applied.length, rejected: final.rejected.length, held: held.length, checksRun: final.checksRun, laneRebases: rebases };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (landed) {
        // Pushed but not recorded: record it (landBatch is idempotent on batchId). Never requeue a landed batch.
        const input = landed;
        await step.do("land-after-failure", { retries: { limit: 10, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, () => rpc<{ idempotent: boolean }>(() => coord.landBatch(input)));
        return { landed: input.applied.length, recoveredFrom: reason.slice(0, 300) };
      }
      // E4 (review M3): transient infrastructure failures never count against a changeset's attempts.
      const kind = infraFailure(err) ? "infra" : "failure";
      await step.do("requeue-on-failure", STEP, () => rpc<null>(() => coord.requeueBatch(batchId, `workflow failed: ${reason.slice(0, 300)}`, kind)));
      return { failed: reason };
    }
  }
}
