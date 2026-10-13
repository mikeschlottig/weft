// D7: the limits dashboard. Every limit here is a documented platform limit (with its source) or a Weft
// configuration value; usage is measured, never estimated. Rows are sorted by how close they are to the limit.

export interface LimitRow {
  area: "artifacts" | "durable-object" | "queue" | "containers" | "weft";
  name: string;
  used: number | null; // null = not measurable from inside the Worker (stated, not guessed)
  limit: number;
  unit: string;
  pct: number | null;
  status: "ok" | "watch" | "near" | "unknown";
  source: string;
  note?: string;
}

export const DOCUMENTED = {
  artifactsControlPlanePer10s: { limit: 2_000, source: "developers.cloudflare.com/artifacts/platform/limits — per namespace" },
  artifactsGitPer10s: { limit: 2_000, source: "developers.cloudflare.com/artifacts/platform/limits — per repo" },
  artifactsRepoBytes: { limit: 1_000_000_000, source: "developers.cloudflare.com/artifacts/platform/limits — 1 GB per repo" },
  artifactsBlobBytes: { limit: 32_000_000, source: "developers.cloudflare.com/artifacts/platform/limits — 32 MB per file" },
  doSqliteBytes: { limit: 10_000_000_000, source: "developers.cloudflare.com changelog 2025-04-07 — SQLite in Durable Objects GA, 10 GB per object" },
  mergeRunnerInstances: { limit: 10, source: "wrangler.jsonc containers[MergeRunner].max_instances" },
  eventsRetained: { limit: 20_000, source: "Weft E6 retention (coordinator alarm)" },
  trunkListingCap: { limit: 5_000, source: "Weft listFiles cap (E5: prefix fallback past it)" },
} as const;

const statusOf = (pct: number | null): LimitRow["status"] => (pct === null ? "unknown" : pct >= 80 ? "near" : pct >= 50 ? "watch" : "ok");

export const row = (area: LimitRow["area"], name: string, used: number | null, limit: number, unit: string, source: string, note?: string): LimitRow => {
  const pct = used === null ? null : Math.round((used / limit) * 1000) / 10;
  return { area, name, used, limit, unit, pct, status: statusOf(pct), source, ...(note ? { note } : {}) };
};

export interface RepoUsage {
  repo: string;
  shard: number;
  sqliteBytes: number;
  events: number;
  workspacesLive: number;
  forksTotal: number;
  queued: number;
  validating: number;
  lanesInFlight: number;
  lanesConfigured: number;
  trunkFiles: number;
  trunkTruncated: boolean;
  artifactsCalls10s: number;
}

/** Rows for one repo, most constrained first. */
export const assessRepo = (u: RepoUsage): LimitRow[] =>
  [
    row("artifacts", "control-plane calls (this coordinator, last 10 s)", u.artifactsCalls10s, DOCUMENTED.artifactsControlPlanePer10s.limit, "req/10 s", DOCUMENTED.artifactsControlPlanePer10s.source, `namespace shard ${u.shard}; other repos on the shard share this budget`),
    row("artifacts", "repo size", null, DOCUMENTED.artifactsRepoBytes.limit, "bytes", DOCUMENTED.artifactsRepoBytes.source, "the Artifacts binding does not report repo size"),
    row("durable-object", "coordinator SQLite", u.sqliteBytes, DOCUMENTED.doSqliteBytes.limit, "bytes", DOCUMENTED.doSqliteBytes.source),
    row("durable-object", "events retained", u.events, DOCUMENTED.eventsRetained.limit, "rows", DOCUMENTED.eventsRetained.source, "older events are pruned, not an error"),
    row("containers", "merge lanes in flight", u.lanesInFlight, u.lanesConfigured, "lanes", "repo config `lanes` (each lane is a merge-runner instance)"),
    row("weft", "trunk files listed", u.trunkFiles, DOCUMENTED.trunkListingCap.limit, "files", DOCUMENTED.trunkListingCap.source, u.trunkTruncated ? "truncated: forecasts use prefix overlap" : undefined),
    row("queue", "queued + validating changesets", u.queued + u.validating, 500, "changesets", "kick() scans the first 500 queued changesets"),
  ].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
