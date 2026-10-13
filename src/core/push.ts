// Parsing for Artifacts `cf.artifacts.repo.pushed` events (FR-05). Pure; unit-tested.

/** The event as documented (queues/event-subscriptions/events-schemas, `pushed`); parsed defensively. */
interface PushedEvent {
  type?: string;
  source?: { type?: string; namespace?: string; repoName?: string };
  payload?: { ref?: string; before?: string; after?: string };
}

export const parsePushed = (raw: unknown): { repoName: string; ref: string; after: string } | null => {
  const e = (raw ?? {}) as PushedEvent & { payload?: PushedEvent["payload"] & PushedEvent };
  // Accept both the full event and an envelope whose payload is the event.
  const ev: PushedEvent = e.source ? e : ((e.payload as PushedEvent | undefined) ?? {});
  const repoName = ev.source?.repoName;
  const ref = ev.payload?.ref;
  const after = ev.payload?.after;
  if (!repoName || !ref || !after || !/^[0-9a-f]{40}$/.test(after)) return null;
  return { repoName, ref, after };
};

/** Fork repos are named `<trunk>--<wsId>` (long names keep the `<trunk>--` prefix before a hash suffix). */
export const trunkOf = (repoName: string): string | null => {
  const i = repoName.indexOf("--");
  return i > 0 ? repoName.slice(0, i) : null;
};
