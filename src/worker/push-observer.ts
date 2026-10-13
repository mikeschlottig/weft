// PushObserver Workflow — FR-05 push-derived heartbeats (M1). Started by an Artifacts event trigger
// (`cf.artifacts.repo.pushed`, filtered to the Weft namespace, wrangler.jsonc `triggers.events`): one
// instance per push to ANY repo in the namespace, so no per-fork subscription or API token is needed.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { WeftError, decodeFromRpc } from "../core/errors.ts";
import { parsePushed, trunkOf } from "../core/push.ts";

type Observed = { observed?: boolean; ignored?: string; wsId?: string; changed?: number; forecast?: string };

const STEP = { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

export class PushObserver extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<Observed> {
    const push = parsePushed(event.payload);
    if (!push) {
      console.log(JSON.stringify({ level: "warn", msg: "push-observer: unrecognized event", payload: JSON.stringify(event.payload).slice(0, 500) }));
      return { ignored: "unrecognized event" };
    }
    const trunk = trunkOf(push.repoName);
    if (!trunk) return { ignored: "trunk push (the merge queue's own landing is verified by read-back)" };
    if (!push.ref.startsWith("refs/heads/weft/ws-")) return { ignored: `not a workspace branch: ${push.ref}` };
    return step.do("observe", STEP, async (): Promise<Observed> => {
      try {
        return JSON.parse(JSON.stringify(await this.env.REPO.getByName(trunk).pushObserved({ forkRepo: push.repoName, ref: push.ref, after: push.after }))) as Observed;
      } catch (err: unknown) {
        const e = err instanceof WeftError ? err : decodeFromRpc(err);
        if (e.code === "NOT_FOUND") return { ignored: `no coordinator: ${e.message}` };
        if (!e.retryable) throw new NonRetryableError(`${e.code}: ${e.message}`);
        throw e;
      }
    });
  }
}
