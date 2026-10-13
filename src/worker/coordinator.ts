// RepoCoordinator — one Durable Object per repo; the single place decisions are made (spec §7).
// Port of prototype/cli/src/coordinator.ts: the mkdir lock becomes the DO's single-threaded
// execution, state.json becomes SQLite, events.jsonl becomes the events table + WebSockets.
//
// Concurrency rule: every decision (forecast + lease, enqueue, claim) is computed and written in
// one synchronous block with no await in between. External I/O (Artifacts, Workflows, the runner)
// happens before or after that block, never inside it.

import { DurableObject } from "cloudflare:workers";
import { WeftError, encodeForRpc, invalidState, notFound, toWeftError, usage } from "../core/errors.ts";
import { RECIPE_ARG } from "../core/types.ts";
import { blockingOverlaps, forecast, isLive, isRealOverlap, outOfIntent, scoreRisk } from "../core/forecast.ts";
import { matches } from "../core/glob.ts";
import { checkGate, composeScorecard, processGates } from "../core/rubric.ts";
import type {
  AgentClaims,
  BatchClaim,
  BatchMember,
  Changeset,
  ConflictPeer,
  EventType,
  Forecast,
  GateResult,
  IntentMode,
  JudgeAnswers,
  Provenance,
  Rejection,
  RecipeRef,
  RepoConfig,
  Room,
  RoomAttempt,
  RoomFile,
  RoomPeer,
  Scorecard,
  WeftEvent,
  Workspace,
} from "../core/types.ts";
import { createTrunk, forkName, headOf, headerToken, listFiles, mintToken, provisionFork, repoInfo, revokeToken } from "./artifacts.ts";
import { runner } from "./runner-client.ts";

export const DEFAULT_CONFIG: RepoConfig = {
  checkCommand: null,
  batchSize: 4,
  reviewThreshold: 60,
  sensitiveGlobs: [],
  unionGlobs: ["CHANGELOG.md", "**/CHANGELOG.md"],
  leaseTtlSeconds: 1800,
  batchWindowMs: 2500,
  judge: { enabled: true, model: "@cf/cloudflare/clef", holdOnSecurity: 0.7, holdOnAlignment: 1.0 },
};

const FORK_TOKEN_TTL = 3600;
const TRUNK_READ_TTL = 3600;
const RUNNER_LEASE_MS = 30 * 60_000;
const KICK_DELAY_MS = 2_500;
const MAX_ATTEMPTS = 3;

interface Meta {
  repo: string;
  trunkRemote: string;
  config: RepoConfig;
  seq: number;
  trunkHead: string | null;
  trunkFiles: { head: string; files: string[] } | null;
  activeBatch: { id: string; workflowId: string; since: number } | null;
  paused: string | null;
  createdAt: string;
}

interface BatchRow {
  id: string;
  state: "claimed" | "landed" | "requeued";
  claim: BatchClaim;
  pre: Record<string, { gates: GateResult[]; judge: JudgeAnswers | null; behind: number; rejections: number }>;
}

interface SubmitInput {
  recipe?: RecipeRef | null;
  wsId: string;
  agent: AgentClaims;
  message: string;
  head: string;
  base: string;
  filesTouched: string[];
  linesAdded: number;
  linesDeleted: number;
  checkpoints: number;
  behind: number;
  promptSha256: string | null;
  toolCalls: number | null;
  costUsd: number | null;
  resolves: string | null;
}

interface StoredWorkspace extends Workspace {
  behindAtSubmit: number;
  alertKeys: string[];
  expiredNotified: boolean;
}

const now = (): string => new Date().toISOString();
const plusSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const pad = (n: number): string => String(n).padStart(4, "0");

export class RepoCoordinator extends DurableObject<Env> {
  /** Serializes Artifacts fork calls for this trunk (in-memory; a fresh instance starts with an empty chain). */
  private forkChain: Promise<unknown> = Promise.resolve();
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, status TEXT NOT NULL, agent_id TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS changesets (id TEXT PRIMARY KEY, status TEXT NOT NULL, enqueued_at INTEGER NOT NULL, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS cs_status ON changesets(status, enqueued_at)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, cs_id TEXT NOT NULL, ws_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    });
  }

  // ------------------------------------------------------------ storage helpers

  private metaOrNull(): Meta | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'meta'`).toArray()[0];
    return row ? (JSON.parse(row.v) as Meta) : null;
  }
  private meta(): Meta {
    const m = this.metaOrNull();
    if (!m) throw notFound("repo", "(this coordinator)", "run `weft init <repo>` first");
    return m;
  }
  private saveMeta(m: Meta): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(m));
  }
  private ws(id: string): StoredWorkspace {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM workspaces WHERE id = ?`, id).toArray()[0];
    if (!row) throw notFound("workspace", id);
    return JSON.parse(row.data) as StoredWorkspace;
  }
  private putWs(w: StoredWorkspace): void {
    w.updatedAt = now();
    this.sql.exec(
      `INSERT INTO workspaces (id, status, agent_id, updated_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      w.id,
      w.status,
      w.agentId,
      Date.now(),
      JSON.stringify(w),
    );
  }
  private allWs(limit = 500): StoredWorkspace[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM workspaces ORDER BY updated_at DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => JSON.parse(r.data) as StoredWorkspace);
  }
  private liveWs(): StoredWorkspace[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM workspaces WHERE status IN ('provisioning','active','conflicted','submitted')`)
      .toArray()
      .map((r) => JSON.parse(r.data) as StoredWorkspace);
  }
  private cs(id: string): Changeset {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM changesets WHERE id = ?`, id).toArray()[0];
    if (!row) throw notFound("changeset", id);
    return JSON.parse(row.data) as Changeset;
  }
  private putCs(c: Changeset): void {
    c.updatedAt = now();
    this.sql.exec(
      `INSERT INTO changesets (id, status, enqueued_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      c.id,
      c.status,
      Date.parse(c.enqueuedAt),
      JSON.stringify(c),
    );
  }
  private csByStatus(status: string, limit = 500): Changeset[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM changesets WHERE status = ? ORDER BY enqueued_at ASC LIMIT ?`, status, limit)
      .toArray()
      .map((r) => JSON.parse(r.data) as Changeset);
  }
  private allCs(limit = 500): Changeset[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM changesets ORDER BY enqueued_at DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => JSON.parse(r.data) as Changeset);
  }
  private batch(id: string): BatchRow | null {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM batches WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.data) as BatchRow) : null;
  }
  private putBatch(b: BatchRow): void {
    this.sql.exec(`INSERT INTO batches (id, state, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`, b.id, b.state, JSON.stringify(b));
  }
  private roomOrNull(id: string): Room | null {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM rooms WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.data) as Room) : null;
  }
  private room(id: string): Room {
    const r = this.roomOrNull(id);
    if (!r) throw notFound("room", id, "weft room list");
    return r;
  }
  private putRoom(r: Room): void {
    r.updatedAt = now();
    this.sql.exec(
      `INSERT INTO rooms (id, cs_id, ws_id, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      r.id,
      r.csId,
      r.wsId,
      r.status,
      Date.now(),
      JSON.stringify(r),
    );
  }
  private allRooms(limit = 100): Room[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM rooms ORDER BY updated_at DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => JSON.parse(r.data) as Room);
  }
  private nextSeq(m: Meta): number {
    m.seq += 1;
    return m.seq;
  }

  /** Append an event (same transaction as the state change), then fan out. */
  private emit(m: Meta, type: EventType, actor: string, data: Record<string, unknown>, alsoTo: string[] = []): WeftEvent {
    const ev: WeftEvent = { seq: this.nextSeq(m), at: now(), repo: m.repo, type, actor, data };
    this.sql.exec(`INSERT INTO events (seq, at, type, actor, data) VALUES (?, ?, ?, ?, ?)`, ev.seq, Date.now(), type, actor, JSON.stringify(data));
    const msg = JSON.stringify({ t: "event", event: ev });
    for (const sock of this.ctx.getWebSockets("ui")) this.safeSend(sock, msg);
    for (const tag of alsoTo) for (const sock of this.ctx.getWebSockets(tag)) this.safeSend(sock, msg);
    try {
      this.env.METRICS.writeDataPoint({ blobs: [m.repo, type, actor, String(data.csId ?? ""), String(data.wsId ?? "")], doubles: [Number(data.risk ?? 0), Number(data.wqs ?? 0)], indexes: [m.repo] });
    } catch (err: unknown) {
      console.log(JSON.stringify({ level: "warn", msg: "metrics write failed", err: String(err) }));
    }
    return ev;
  }

  private safeSend(sock: WebSocket, msg: string): void {
    try {
      sock.send(msg);
    } catch (err: unknown) {
      console.log(JSON.stringify({ level: "debug", msg: "ws send failed", err: String(err) }));
    }
  }

  private project(job: Record<string, unknown>): void {
    this.ctx.waitUntil(
      this.env.JOBS.send(job).catch((err: unknown) => console.log(JSON.stringify({ level: "warn", msg: "projection enqueue failed", err: String(err) }))),
    );
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      throw encodeForRpc(toWeftError(err));
    }
  }

  private async trunkFiles(m: Meta): Promise<{ head: string | null; files: string[] }> {
    const head = await headOf(this.env, m.repo);
    if (!head) return { head: null, files: [] };
    if (m.trunkFiles && m.trunkFiles.head === head) return m.trunkFiles;
    const files = await listFiles(this.env, m.repo, head);
    const fresh = this.meta();
    fresh.trunkFiles = { head, files };
    fresh.trunkHead = head;
    this.saveMeta(fresh);
    return { head, files };
  }

  private scheduleKick(delayMs = KICK_DELAY_MS): void {
    this.ctx.waitUntil(
      (async () => {
        const current = await this.ctx.storage.getAlarm();
        const at = Date.now() + delayMs;
        if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      })(),
    );
  }

  // ------------------------------------------------------------ repo lifecycle

  init(input: { repo: string; config: Partial<RepoConfig>; actor: string }): Promise<{ repo: string; remote: string; token: string; config: RepoConfig; adopted: boolean }> {
    return this.guard(async () => {
      if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(input.repo)) throw usage(`invalid repo name: ${input.repo}`, "lowercase letters, digits, . _ - (max 41 chars)");
      if (this.metaOrNull()) throw new WeftError("ALREADY_EXISTS", `repo already exists: ${input.repo}`, { hint: `weft status --repo ${input.repo}` });
      let remote: string;
      let token: string;
      let adopted = false;
      try {
        const created = await createTrunk(this.env, input.repo, `weft trunk for ${input.repo}`);
        remote = created.remote;
        token = created.token;
      } catch (err: unknown) {
        if (!(err instanceof WeftError && err.code === "ALREADY_EXISTS")) throw err;
        remote = (await repoInfo(this.env, input.repo)).remote;
        token = (await mintToken(this.env, input.repo, "write", 3600)).plaintext;
        adopted = true;
      }
      const config: RepoConfig = { ...DEFAULT_CONFIG, ...input.config, judge: { ...DEFAULT_CONFIG.judge, ...(input.config.judge ?? {}) } };
      const m: Meta = { repo: input.repo, trunkRemote: remote, config, seq: 0, trunkHead: null, trunkFiles: null, activeBatch: null, paused: null, createdAt: now() };
      this.emit(m, "repo.created", input.actor, { remote, adopted });
      this.saveMeta(m);
      this.project({ kind: "repo", repo: m.repo, config, createdAt: m.createdAt });
      return { repo: input.repo, remote, token, config, adopted };
    });
  }

  configure(patch: Partial<RepoConfig>, actor: string): Promise<RepoConfig> {
    return this.guard(async () => {
      const m = this.meta();
      m.config = { ...m.config, ...patch, judge: { ...m.config.judge, ...(patch.judge ?? {}) } };
      if (patch.checkCommand !== undefined) m.paused = null;
      this.emit(m, "repo.configured", actor, { patch });
      this.saveMeta(m);
      return m.config;
    });
  }

  // ------------------------------------------------------------ workspaces

  start(input: { agent: AgentClaims; task: string; globs: string[]; mode: IntentMode; ttl: number | null; after?: string | null }) {
    return this.guard(async () => {
      if (input.globs.length === 0) throw usage("an intent needs at least one --touch glob", "e.g. --touch 'src/auth/**'");
      if (!input.task.trim()) throw usage('start needs --task "..."');
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      if (!tf.head) throw invalidState("trunk is empty", "push an initial commit to trunk (weft init --from DIR)");

      // FR-27: a stacked workspace forks the parent changeset's fork, so it starts on top of unlanded work.
      let parent: { cs: Changeset; ws: StoredWorkspace } | null = null;
      if (input.after) {
        const pc = this.cs(input.after);
        if (pc.status === "landed") throw usage(`${pc.id} already landed; start normally — trunk contains it`, "weft start --task ...");
        if (pc.status === "rejected" || pc.status === "reverted") throw invalidState(`${pc.id} is ${pc.status}; you cannot stack on it`);
        parent = { cs: pc, ws: this.ws(pc.wsId) };
      }

      // ---- decision block (no awaits)
      const m = this.meta();
      const live = this.liveWs().filter((o) => !parent || o.id !== parent.ws.id);
      const fc = forecast(live, { wsId: null, globs: input.globs, touched: [] }, tf.files, m.config, Date.now());
      const blocking = blockingOverlaps(fc, input.mode);
      if (blocking.length > 0) {
        this.emit(m, "workspace.lease_refused", input.agent.sub, { agentName: input.agent.name, task: input.task, globs: input.globs, blocking });
        this.saveMeta(m);
        throw new WeftError("LEASE_HELD", "an exclusive intent overlaps the requested scope", {
          retryable: true,
          hint: "narrow --touch, wait for the holder to land, or start in soft mode",
          details: { blocking },
        });
      }
      const wsId = `ws-${pad(this.nextSeq(m))}-${input.agent.name}`.slice(0, 40);
      const ttl = input.ttl ?? m.config.leaseTtlSeconds;
      const ws: StoredWorkspace = {
        id: wsId,
        repo: m.repo,
        agentId: input.agent.sub,
        agentName: input.agent.name,
        model: input.agent.model,
        task: input.task,
        branch: `weft/${wsId}`,
        forkRepo: forkName(m.repo, wsId),
        forkRemote: "",
        forkTokenId: null,
        baseCommit: parent ? parent.cs.headCommit : tf.head,
        after: parent ? parent.cs.id : null,
        status: "provisioning",
        intent: { globs: input.globs, mode: input.mode, task: input.task, createdAt: now(), expiresAt: plusSeconds(ttl) },
        touched: [],
        createdAt: now(),
        updatedAt: now(),
        changesetId: null,
        rejections: 0,
        behindAtSubmit: 0,
        alertKeys: [],
        expiredNotified: false,
      };
      this.putWs(ws);
      this.saveMeta(m);

      // ---- provisioning I/O
      try {
        // Forks of one trunk are issued one at a time (concurrent forks were seen to vanish, see provisionFork).
        const source = parent ? parent.ws.forkRepo : m.repo;
        const prov = this.forkChain.then(() => provisionFork(this.env, source, ws.forkRepo, `weft workspace ${wsId} (${input.agent.name})${parent ? ` stacked on ${parent.cs.id}` : ""}`, FORK_TOKEN_TTL, parent !== null));
        this.forkChain = prov.catch(() => undefined);
        const { token: forkTok, ...fork } = await prov;
        const trunkTok = await mintToken(this.env, m.repo, "read", TRUNK_READ_TTL);
        const m2 = this.meta();
        const live2 = this.ws(wsId);
        live2.forkRemote = fork.remote;
        live2.forkTokenId = forkTok.id;
        live2.status = "active";
        this.putWs(live2);
        this.emit(m2, "workspace.started", input.agent.sub, {
          wsId,
          agentName: input.agent.name,
          model: input.agent.model,
          task: input.task,
          globs: input.globs,
          mode: input.mode,
          forecast: fc.risk,
          peers: fc.overlaps.map((o) => o.agentName),
          after: parent?.cs.id ?? null,
        }, fc.overlaps.map((o) => `agent:${o.agentId}`));
        this.saveMeta(m2);
        return {
          workspace: this.publicWs(live2),
          stackedOn: parent ? { changeset: parent.cs.id, branch: parent.ws.branch, head: parent.cs.headCommit } : null,
          forecast: fc,
          fork: { remote: fork.remote, token: headerToken(forkTok.plaintext), expiresAt: forkTok.expiresAt },
          trunk: { remote: m2.trunkRemote, token: headerToken(trunkTok.plaintext), expiresAt: trunkTok.expiresAt, head: tf.head },
        };
      } catch (err: unknown) {
        const m3 = this.meta();
        const failed = this.ws(wsId);
        failed.status = "abandoned";
        this.putWs(failed);
        this.emit(m3, "workspace.abandoned", "weft", { wsId, reason: `provisioning failed: ${toWeftError(err).message}` });
        this.saveMeta(m3);
        throw err;
      }
    });
  }

  private publicWs(w: StoredWorkspace) {
    return {
      id: w.id,
      repo: w.repo,
      agentId: w.agentId,
      agentName: w.agentName,
      model: w.model,
      task: w.task,
      status: w.status,
      branch: w.branch,
      forkRepo: w.forkRepo,
      baseCommit: w.baseCommit,
      changesetId: w.changesetId,
      intent: w.intent,
      touched: w.touched,
      after: w.after ?? null,
    };
  }

  /** Live workspaces this one should be forecast against (never its own stack parent). */
  private peersOf(w: StoredWorkspace): StoredWorkspace[] {
    return this.liveWs().filter((o) => o.id !== w.id && !(w.after && o.changesetId === w.after));
  }

  private own(wsId: string, agent: AgentClaims): StoredWorkspace {
    const w = this.ws(wsId);
    if (w.agentId !== agent.sub && agent.role !== "admin") throw new WeftError("FORBIDDEN", `workspace ${wsId} belongs to ${w.agentName}`);
    return w;
  }

  tokens(wsId: string, agent: AgentClaims) {
    return this.guard(async () => {
      const m = this.meta();
      const w = this.own(wsId, agent);
      if (w.status === "landed" || w.status === "abandoned") throw invalidState(`workspace ${wsId} is ${w.status}`);
      const forkTok = await mintToken(this.env, w.forkRepo, "write", FORK_TOKEN_TTL);
      const trunkTok = await mintToken(this.env, m.repo, "read", TRUNK_READ_TTL);
      const fresh = this.ws(wsId);
      fresh.forkTokenId = forkTok.id;
      this.putWs(fresh);
      return {
        fork: { remote: w.forkRemote, token: headerToken(forkTok.plaintext), expiresAt: forkTok.expiresAt },
        trunk: { remote: m.trunkRemote, token: headerToken(trunkTok.plaintext), expiresAt: trunkTok.expiresAt },
      };
    });
  }

  heartbeat(input: { wsId: string; agent: AgentClaims; touched: string[]; symbols?: Record<string, string[]> }) {
    return this.guard(async () => {
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      const m = this.meta();
      const w = this.own(input.wsId, input.agent);
      const workable = w.status === "active" || w.status === "conflicted";
      if (workable) {
        w.touched = [...new Set(input.touched)].sort();
        if (input.symbols) w.touchedSymbols = Object.fromEntries(Object.entries(input.symbols).filter(([f]) => w.touched.includes(f)));
        w.intent.expiresAt = plusSeconds(m.config.leaseTtlSeconds);
        w.expiredNotified = false;
      }
      const others = this.peersOf(w);
      const fc = forecast(others, { wsId: w.id, globs: w.intent.globs, touched: w.touched, symbols: w.touchedSymbols }, tf.files, m.config, Date.now());
      const keys = fc.overlaps.filter(isRealOverlap).map((o) => `${o.workspaceId}:${o.strength}:${o.files.join(",")}`);
      const fresh = keys.filter((k) => !w.alertKeys.includes(k));
      w.alertKeys = keys;
      this.putWs(w);
      if (workable) this.emit(m, "workspace.heartbeat", w.agentId, { wsId: w.id, agentName: w.agentName, touched: w.touched.length, symbols: Object.values(w.touchedSymbols ?? {}).reduce((n, xs) => n + xs.length, 0), forecast: fc.risk });
      for (const o of fc.overlaps.filter(isRealOverlap)) {
        if (!fresh.some((k) => k.startsWith(`${o.workspaceId}:`))) continue;
        this.emit(
          m,
          "workspace.alert",
          "weft",
          { wsId: w.id, agentName: w.agentName, peerWs: o.workspaceId, peerAgent: o.agentName, strength: o.strength, files: o.files, symbols: o.symbols ?? [] },
          [`agent:${w.agentId}`, `agent:${o.agentId}`],
        );
      }
      this.saveMeta(m);
      const c = w.changesetId ? this.cs(w.changesetId) : null;
      return {
        workspace: this.publicWs(w),
        intent: w.intent,
        touched: w.touched,
        outOfIntent: outOfIntent(w.touched, w.intent.globs, m.config.unionGlobs),
        forecast: fc,
        trunkHead: tf.head,
        changeset: c ? { id: c.id, status: c.status, riskScore: c.riskScore, rejection: c.rejection, scorecard: c.scorecard } : null,
      };
    });
  }

  widen(input: { wsId: string; agent: AgentClaims; globs: string[] }) {
    return this.guard(async () => {
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      const m = this.meta();
      const w = this.own(input.wsId, input.agent);
      if (w.status !== "active" && w.status !== "conflicted") throw invalidState(`workspace ${w.id} is ${w.status}`);
      const next = [...new Set([...w.intent.globs, ...input.globs])];
      const fc = forecast(this.peersOf(w), { wsId: w.id, globs: next, touched: w.touched }, tf.files, m.config, Date.now());
      const blocking = fc.overlaps.filter((o) => o.mode === "exclusive" && isRealOverlap(o));
      if (blocking.length > 0) throw new WeftError("LEASE_HELD", "widening would overlap an exclusive intent", { retryable: true, details: { blocking } });
      w.intent.globs = next;
      w.intent.expiresAt = plusSeconds(m.config.leaseTtlSeconds);
      this.putWs(w);
      this.emit(m, "workspace.intent_widened", w.agentId, { wsId: w.id, added: input.globs });
      this.saveMeta(m);
      return { globs: next, forecast: fc };
    });
  }

  private peersFor(files: string[], sinceIso: string): ConflictPeer[] {
    const since = Date.parse(sinceIso);
    return this.csByStatus("landed")
      .filter((c) => Date.parse(c.updatedAt) >= since)
      .map((c) => ({
        changesetId: c.id,
        agentId: c.agentId,
        agentName: c.provenance.agentName,
        workspaceId: c.wsId,
        commit: c.landedCommit,
        files: files.filter((f) => c.provenance.filesTouched.includes(f)),
      }))
      .filter((p) => p.files.length > 0);
  }

  syncReport(input: { wsId: string; agent: AgentClaims; action: "merged" | "fast_forward" | "up_to_date" | "conflicted" | "continued" | "aborted"; base: string; conflictedFiles: string[] }) {
    return this.guard(async () => {
      const m = this.meta();
      const w = this.own(input.wsId, input.agent);
      w.intent.expiresAt = plusSeconds(m.config.leaseTtlSeconds);
      let peers: ConflictPeer[] = [];
      if (input.action === "conflicted") {
        w.status = "conflicted";
        peers = this.peersFor(input.conflictedFiles, w.createdAt);
        this.emit(m, "workspace.conflicted", w.agentId, { wsId: w.id, agentName: w.agentName, files: input.conflictedFiles, peers: peers.map((p) => p.changesetId) });
      } else {
        w.status = "active";
        if (input.action !== "aborted") w.baseCommit = input.base;
        if (input.action !== "up_to_date") this.emit(m, "workspace.synced", w.agentId, { wsId: w.id, agentName: w.agentName, action: input.action, base: input.base });
      }
      this.putWs(w);
      this.saveMeta(m);
      return { peers };
    });
  }

  submit(input: SubmitInput) {
    return this.guard(() => this.submitCore(input));
  }

  /** Unwrapped submit, shared by the API route and by accepting a verified Conflict Room proposal. */
  private async submitCore(input: {
    recipe?: RecipeRef | null;
    wsId: string;
    agent: AgentClaims;
    message: string;
    head: string;
    base: string;
    filesTouched: string[];
    linesAdded: number;
    linesDeleted: number;
    checkpoints: number;
    behind: number;
    promptSha256: string | null;
    toolCalls: number | null;
    costUsd: number | null;
    resolves: string | null;
  }): Promise<{ changeset: Changeset }> {
    {
      if (!input.message.trim()) throw usage("submit needs -m <message>");
      if (input.filesTouched.length === 0) throw new WeftError("NOTHING_TO_SUBMIT", "no changes relative to the workspace base", { hint: "edit files first" });
      if (!/^[0-9a-f]{40}$/.test(input.head)) throw usage("head must be a 40-char commit sha");
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      const m = this.meta();
      const w = this.own(input.wsId, input.agent);
      if (w.status === "conflicted") throw invalidState("workspace has an unfinished sync", "resolve, then `weft sync --continue`");
      if (w.status !== "active") throw invalidState(`workspace ${w.id} is ${w.status}`);
      const prov: Provenance = {
        agentId: w.agentId,
        agentName: w.agentName,
        model: w.model,
        task: w.task,
        intentGlobs: w.intent.globs,
        filesTouched: input.filesTouched,
        linesAdded: input.linesAdded,
        linesDeleted: input.linesDeleted,
        checkpoints: input.checkpoints,
        forkHead: input.head,
        promptSha256: input.promptSha256,
        toolCalls: input.toolCalls,
        costUsd: input.costUsd,
      };
      const fc = forecast(this.peersOf(w), { wsId: w.id, globs: w.intent.globs, touched: input.filesTouched, symbols: w.touchedSymbols }, tf.files, m.config, Date.now());
      const overlapping = fc.overlaps.filter(isRealOverlap).length;
      const risk = scoreRisk(m.config, prov, overlapping, input.behind);
      const needsReview = risk.sensitive || risk.score >= m.config.reviewThreshold;
      const id = `cs-${pad(this.nextSeq(m))}`;
      const c: Changeset = {
        id,
        repo: m.repo,
        wsId: w.id,
        agentId: w.agentId,
        message: input.message.trim(),
        headCommit: input.head,
        baseCommit: input.base,
        status: needsReview ? "needs_review" : "queued",
        riskScore: risk.score,
        risk: risk.factors,
        provenance: prov,
        enqueuedAt: now(),
        updatedAt: now(),
        batchId: null,
        landedCommit: null,
        approvedBy: null,
        rejection: null,
        resolves: input.resolves,
        scorecard: null,
        attempts: 0,
        after: w.after ?? null,
        recipe: null,
      };
      if (input.recipe) {
        const def = m.config.recipes?.[input.recipe.name];
        if (!def) throw usage(`unknown recipe: ${input.recipe.name}`, `available: ${Object.keys(m.config.recipes ?? {}).join(", ") || "none (an admin defines recipes in the repo config)"}`);
        const bad = input.recipe.args.find((a) => !RECIPE_ARG.test(a));
        if (bad !== undefined) throw usage(`recipe argument not allowed: ${bad}`, "letters, digits and . _ / @ : + = , - only");
        c.recipe = { name: input.recipe.name, args: input.recipe.args };
      }
      if (c.after) {
        const pc = this.cs(c.after);
        if (pc.status === "rejected" || pc.status === "reverted") throw invalidState(`your stack parent ${pc.id} was ${pc.status}`, "re-stack: weft start --after <new parent> (or start fresh from trunk)");
      }
      this.putCs(c);
      w.status = "submitted";
      w.changesetId = id;
      w.touched = input.filesTouched;
      w.behindAtSubmit = input.behind;
      this.putWs(w);
      this.emit(m, "changeset.submitted", w.agentId, { csId: id, wsId: w.id, agentName: w.agentName, message: c.message, files: input.filesTouched.length, risk: risk.score, status: c.status, after: c.after ?? null });
      if (needsReview) this.emit(m, "changeset.needs_review", "weft", { csId: id, agentName: w.agentName, risk: risk.score, reason: risk.sensitive ? "sensitive path" : "risk threshold" });
      this.saveMeta(m);
      if (!needsReview) this.scheduleKick(m.config.batchWindowMs ?? KICK_DELAY_MS);
      return { changeset: c };
    }
  }

  approve(csId: string, by: string) {
    return this.guard(async () => {
      const m = this.meta();
      const c = this.cs(csId);
      if (c.status !== "needs_review") throw invalidState(`changeset ${csId} is ${c.status}, not needs_review`);
      c.status = "queued";
      c.approvedBy = oneLine(by);
      this.putCs(c);
      this.emit(m, "changeset.approved", by, { csId, agentName: c.provenance.agentName, held: c.scorecard?.hold ?? null });
      this.saveMeta(m);
      this.scheduleKick(m.config.batchWindowMs ?? 500);
      return c;
    });
  }

  abandon(wsId: string, agent: AgentClaims) {
    return this.guard(async () => {
      const m = this.meta();
      const w = this.own(wsId, agent);
      if (w.status === "landed" || w.status === "abandoned") throw invalidState(`workspace ${wsId} is already ${w.status}`);
      if (w.changesetId) {
        const c = this.cs(w.changesetId);
        if (c.status === "queued" || c.status === "needs_review") {
          c.status = "rejected";
          c.rejection = { reason: "policy", detail: "workspace abandoned by its agent", files: [], conflictsWith: [], logKey: null };
          this.putCs(c);
        }
      }
      w.status = "abandoned";
      this.putWs(w);
      this.emit(m, "workspace.abandoned", agent.sub, { wsId, agentName: w.agentName });
      this.saveMeta(m);
      return this.publicWs(w);
    });
  }

  // ------------------------------------------------------------ queue (called by alarm + MergeQueue Workflow)

  queueRun(actor: string) {
    return this.guard(async () => {
      const m = this.meta();
      if (m.paused) throw new WeftError("TRUNK_RED", `queue paused: ${m.paused}`, { hint: "fix or revert trunk, then `weft config --check ...` to resume" });
      if (m.activeBatch) return { started: false, activeBatch: m.activeBatch.id };
      const started = await this.kick(actor);
      return { started: started !== null, batchId: started };
    });
  }

  private async kick(actor: string): Promise<string | null> {
    const m0 = this.meta();
    if (m0.activeBatch || m0.paused) return null;
    if (this.csByStatus("queued", 1).length === 0) return null;
    const head = await headOf(this.env, m0.repo);
    if (!head) return null;

    // ---- decision block
    const m = this.meta();
    if (m.activeBatch || m.paused) return null;
    // FR-27: a stacked changeset is eligible only when its parent has landed or rides earlier in this batch.
    const queued: Changeset[] = [];
    const picked = new Set<string>();
    for (const c of this.csByStatus("queued", 500)) {
      if (queued.length >= m.config.batchSize) break;
      if (c.after && !picked.has(c.after)) {
        const ps = this.cs(c.after).status;
        if (ps !== "landed") continue;
      }
      queued.push(c);
      picked.add(c.id);
    }
    if (queued.length === 0) return null;
    const batchId = `b-${pad(this.nextSeq(m))}`;
    const members: BatchMember[] = queued.map((c) => {
      const w = this.ws(c.wsId);
      return {
        id: c.id,
        wsId: c.wsId,
        forkRepo: w.forkRepo,
        forkRemote: w.forkRemote,
        branch: w.branch,
        headCommit: c.headCommit,
        baseCommit: c.baseCommit,
        message: c.message,
        trailers: this.trailers(c),
        filesTouched: c.provenance.filesTouched,
        agentId: c.agentId,
        agentName: c.provenance.agentName,
        task: c.provenance.task,
        intentGlobs: c.provenance.intentGlobs,
        after: c.after ?? null,
        recipe: c.recipe ?? null,
      };
    });
    const claim: BatchClaim = {
      batchId,
      repo: m.repo,
      trunkRepo: m.repo,
      trunkRemote: m.trunkRemote,
      trunkHead: head,
      claimTime: Math.floor(Date.now() / 1000),
      config: m.config,
      members,
    };
    const pre: BatchRow["pre"] = {};
    for (const c of queued) {
      c.status = "validating";
      c.batchId = batchId;
      this.putCs(c);
      const w = this.ws(c.wsId);
      pre[c.id] = { gates: [], judge: null, behind: w.behindAtSubmit, rejections: w.rejections };
    }
    const workflowId = `${m.repo.replace(/[^a-zA-Z0-9_-]/g, "_")}-${batchId}`;
    this.putBatch({ id: batchId, state: "claimed", claim, pre });
    m.activeBatch = { id: batchId, workflowId, since: Date.now() };
    this.emit(m, "queue.batch_started", actor, { batchId, changesets: members.map((x) => x.id), trunkHead: head });
    this.saveMeta(m);

    try {
      await this.env.MERGE_QUEUE.create({ id: workflowId, params: { repo: m.repo, batchId } });
      return batchId;
    } catch (err: unknown) {
      await this.requeueInternal(batchId, `workflow create failed: ${toWeftError(err).message}`);
      return null;
    }
  }

  private trailers(c: Changeset): string[] {
    const t = [
      `Weft-Changeset: ${c.id}`,
      `Weft-Agent: ${oneLine(c.provenance.agentName)}`,
      `Weft-Agent-Id: ${c.agentId}`,
      `Weft-Model: ${oneLine(c.provenance.model)}`,
      `Weft-Task: ${oneLine(c.provenance.task)}`,
      `Weft-Workspace: ${c.wsId}`,
      `Weft-Fork-Head: ${c.headCommit}`,
      `Weft-Risk: ${c.riskScore}`,
    ];
    if (c.provenance.promptSha256) t.push(`Weft-Prompt-Sha256: ${c.provenance.promptSha256}`);
    if (c.approvedBy) t.push(`Weft-Approved-By: ${c.approvedBy}`);
    if (c.resolves) t.push(`Weft-Resolves: ${c.resolves}`);
    return t;
  }

  claimBatch(batchId: string): Promise<(BatchClaim & { pre: BatchRow["pre"] }) | null> {
    return this.guard(async () => {
      const b = this.batch(batchId);
      if (!b || b.state !== "claimed") return null;
      // Members held for review after an earlier attempt are dropped from the claim.
      const members = b.claim.members.filter((x) => this.cs(x.id).status === "validating");
      return { ...b.claim, members, pre: b.pre };
    });
  }

  /** Store pre-check rubric results; if a hold rule fires, route the changeset to a human. */
  recordJudgement(batchId: string, csId: string, gates: GateResult[], judge: JudgeAnswers | null, hold: string | null) {
    return this.guard(async () => {
      const m = this.meta();
      const b = this.batch(batchId);
      if (!b || b.state !== "claimed") throw invalidState(`batch ${batchId} is not active`);
      const p = b.pre[csId];
      if (!p) throw notFound("changeset in batch", csId);
      p.gates = gates;
      p.judge = judge;
      this.putBatch(b);
      const c = this.cs(csId);
      const card = composeScorecard({ pre: gates, check: checkGate(null, m.config.checkCommand !== null), judge, process: processGates(p.rejections, p.behind), hold, now: now() });
      c.scorecard = card;
      if (hold && c.status === "validating") {
        c.status = "needs_review";
        c.batchId = null;
      }
      this.putCs(c);
      this.emit(m, "changeset.judged", "weft-judge", {
        csId,
        agentName: c.provenance.agentName,
        hold,
        judgeError: judge?.error ?? null,
        intentAlignment: judge?.intentAlignment ?? null,
        securityConcern: judge?.securityConcern ?? null,
      });
      if (hold) this.emit(m, "changeset.needs_review", "weft-judge", { csId, agentName: c.provenance.agentName, reason: hold });
      this.saveMeta(m);
      return { held: hold !== null };
    });
  }

  landBatch(input: {
    batchId: string;
    trunkAfter: string | null;
    applied: { id: string; commit: string }[];
    rejected: { id: string; rejection: Rejection }[];
    checkPassed: Record<string, boolean>;
    checksRun: number;
    bisectSteps: number;
    logKeys: Record<string, string>;
    readmitted?: string[];
  }) {
    return this.guard(async () => {
      const m = this.meta();
      const b = this.batch(input.batchId);
      if (!b) throw notFound("batch", input.batchId);
      if (b.state === "landed") return { idempotent: true };
      const hasCheck = m.config.checkCommand !== null;
      const finalize = (c: Changeset, passed: boolean | null): Scorecard => {
        const p = b.pre[c.id];
        return composeScorecard({
          pre: p?.gates ?? [],
          check: checkGate(passed, hasCheck),
          judge: p?.judge ?? null,
          process: processGates(p?.rejections ?? 0, p?.behind ?? 0),
          hold: null,
          now: now(),
        });
      };
      const landedIds: string[] = [];
      const roomsToStart: string[] = [];
      for (const a of input.applied) {
        const c = this.cs(a.id);
        c.status = "landed";
        c.landedCommit = a.commit;
        c.scorecard = finalize(c, hasCheck ? true : null);
        this.putCs(c);
        const w = this.ws(c.wsId);
        w.status = "landed";
        this.putWs(w);
        landedIds.push(c.id);
        this.emit(m, "changeset.landed", "weft-merge-queue", { csId: c.id, wsId: c.wsId, agentName: c.provenance.agentName, commit: a.commit, wqs: c.scorecard.total }, [`agent:${c.agentId}`]);
        this.project({ kind: "scorecard", repo: m.repo, cs: { id: c.id, agentId: c.agentId, agentName: c.provenance.agentName, model: c.provenance.model, status: c.status, wqs: c.scorecard.total, scorecard: c.scorecard, landedCommit: a.commit } });
      }
      for (const r of input.rejected) {
        const c = this.cs(r.id);
        const rejection = { ...r.rejection, logKey: input.logKeys[r.id] ?? r.rejection.logKey };
        c.status = "rejected";
        c.rejection = rejection;
        c.scorecard = finalize(c, rejection.reason === "check_failed" ? false : (input.checkPassed[c.id] ?? null));
        this.putCs(c);
        const w = this.ws(c.wsId);
        w.status = "active";
        w.rejections += 1;
        this.putWs(w);
        this.emit(m, "changeset.rejected", "weft-merge-queue", {
          csId: c.id,
          wsId: c.wsId,
          agentName: c.provenance.agentName,
          reason: rejection.reason,
          files: rejection.files,
          conflictsWith: rejection.conflictsWith.map((p) => p.changesetId),
          wqs: c.scorecard.total,
        }, [`agent:${c.agentId}`]);
        this.project({ kind: "scorecard", repo: m.repo, cs: { id: c.id, agentId: c.agentId, agentName: c.provenance.agentName, model: c.provenance.model, status: c.status, wqs: c.scorecard.total, scorecard: c.scorecard, landedCommit: null } });
        if (rejection.reason === "conflict") roomsToStart.push(this.openRoom(m, c, rejection).id);
      }
      // FR-27: children (queued or held) of a rejected parent cannot land: reject them with the reason.
      const rejectedIds = new Set(input.rejected.map((r) => r.id));
      let frontier = [...rejectedIds];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const child of this.allCs(2000).filter((c) => c.after && frontier.includes(c.after) && (c.status === "queued" || c.status === "needs_review"))) {
          child.status = "rejected";
          child.rejection = { reason: "dependency", detail: `stack parent ${child.after} was rejected`, files: [], conflictsWith: [], logKey: null };
          this.putCs(child);
          const cw = this.ws(child.wsId);
          cw.status = "active";
          cw.rejections += 1;
          this.putWs(cw);
          this.emit(m, "changeset.rejected", "weft-merge-queue", { csId: child.id, wsId: child.wsId, agentName: child.provenance.agentName, reason: "dependency", files: [], conflictsWith: [child.after], wqs: null }, [`agent:${child.agentId}`]);
          next.push(child.id);
        }
        frontier = next;
      }
      // Anything still validating in this batch (e.g. dropped by a rebuild) goes back to the queue.
      for (const x of b.claim.members) {
        const c = this.cs(x.id);
        if (c.status === "validating" && c.batchId === b.id) {
          c.status = "queued";
          c.batchId = null;
          this.putCs(c);
        }
      }
      b.state = "landed";
      this.putBatch(b);
      if (input.trunkAfter) m.trunkHead = input.trunkAfter;
      m.activeBatch = null;
      this.emit(m, "queue.batch_landed", "weft-merge-queue", {
        batchId: b.id,
        landed: landedIds,
        rejected: input.rejected.map((r) => r.id),
        checksRun: input.checksRun,
        bisectSteps: input.bisectSteps,
        readmitted: input.readmitted ?? [],
        trunkHead: input.trunkAfter ?? b.claim.trunkHead,
      });
      this.saveMeta(m);
      // Landed forks no longer need write access.
      this.ctx.waitUntil(
        Promise.all(
          landedIds.map(async (id) => {
            const w = this.ws(this.cs(id).wsId);
            if (w.forkTokenId) await revokeToken(this.env, w.forkRepo, w.forkTokenId).catch((err: unknown) => console.log(JSON.stringify({ level: "warn", msg: "revoke failed", err: String(err) })));
          }),
        ),
      );
      for (const roomId of roomsToStart) this.startResolver(m.repo, roomId);
      this.scheduleKick(500);
      return { idempotent: false };
    });
  }

  private async requeueInternal(batchId: string, reason: string, countsAsFailure = true): Promise<void> {
    const m = this.meta();
    const b = this.batch(batchId);
    if (b && b.state === "claimed") {
      for (const x of b.claim.members) {
        const c = this.cs(x.id);
        if (c.status !== "validating") continue;
        c.attempts = (c.attempts ?? 0) + (countsAsFailure ? 1 : 0);
        c.batchId = null;
        if (c.attempts >= MAX_ATTEMPTS) {
          // A deterministic failure must not loop forever: hand the changeset back with the reason.
          c.status = "rejected";
          c.rejection = { reason: "policy", detail: `merge runner failed ${c.attempts} times: ${reason.slice(0, 400)}`, files: [], conflictsWith: [], logKey: null };
          const w = this.ws(c.wsId);
          w.status = "active";
          w.rejections += 1;
          this.putWs(w);
          this.emit(m, "changeset.rejected", "weft-merge-queue", { csId: c.id, wsId: c.wsId, agentName: c.provenance.agentName, reason: "policy", files: [], conflictsWith: [], wqs: null }, [`agent:${c.agentId}`]);
        } else {
          c.status = "queued";
        }
        this.putCs(c);
      }
      b.state = "requeued";
      this.putBatch(b);
    }
    if (m.activeBatch?.id === batchId) m.activeBatch = null;
    this.emit(m, "queue.requeued", "weft-merge-queue", { batchId, reason });
    this.saveMeta(m);
    this.scheduleKick(15_000);
  }

  requeueBatch(batchId: string, reason: string) {
    return this.guard(() => this.requeueInternal(batchId, reason, !/trunk moved|verify:/.test(reason)));
  }

  trunkRed(batchId: string, detail: string) {
    return this.guard(async () => {
      await this.requeueInternal(batchId, "trunk is red", false);
      const m = this.meta();
      m.paused = `check fails on trunk ${m.trunkHead ?? ""}`.trim();
      this.emit(m, "queue.trunk_red", "weft-merge-queue", { batchId, detail: detail.slice(-1500) });
      this.saveMeta(m);
    });
  }

  revert(csId: string, actor: string) {
    return this.guard(async () => {
      const m0 = this.meta();
      if (m0.activeBatch) throw new WeftError("QUEUE_BUSY", "a batch is landing; retry the revert shortly", { retryable: true });
      const c0 = this.cs(csId);
      if (c0.status !== "landed" || !c0.landedCommit) throw invalidState(`changeset ${csId} is ${c0.status}, not landed`);
      const head = await headOf(this.env, m0.repo);
      if (!head) throw invalidState("trunk is empty");
      const read = await mintToken(this.env, m0.repo, "read", 600);
      const write = await mintToken(this.env, m0.repo, "write", 600);
      const subject = c0.message.split("\n")[0] ?? c0.id;
      const res = await runner(this.env, m0.repo).revert({
        trunk: { remote: m0.trunkRemote, token: headerToken(read.plaintext), writeToken: headerToken(write.plaintext) },
        trunkHead: head,
        landedCommit: c0.landedCommit,
        message: `Revert "${subject}"\n\nWeft-Reverts: ${c0.id}\nWeft-Reverted-By: ${oneLine(actor)}\n`,
        actor: oneLine(actor),
        claimTime: Math.floor(Date.now() / 1000),
      });
      const verify = await headOf(this.env, m0.repo);
      if (verify !== res.commit) throw new WeftError("TRUNK_MOVED", `revert verify failed: main=${verify}`, { retryable: true });
      const m = this.meta();
      const c = this.cs(csId);
      c.status = "reverted";
      this.putCs(c);
      m.trunkHead = res.commit;
      this.emit(m, "changeset.reverted", actor, { csId, revertCommit: res.commit, agentName: c.provenance.agentName });
      this.saveMeta(m);
      this.project({ kind: "outcome", repo: m.repo, csId, outcome: "reverted" });
      return { csId, revertCommit: res.commit };
    });
  }

  // ------------------------------------------------------------ context preservation (context packs, FR-16 resume)

  /**
   * A token-budgeted context pack for one workspace: what the agent is doing, what it may touch, who else is
   * near it, what recently landed in its scope, what went wrong before, and the house rules. It is meant to be
   * pasted into an agent's prompt at the start of every session, so work survives a crash or a new model.
   */
  contextPack(wsId: string, agent: AgentClaims, budgetTokens = 6000) {
    return this.guard(async () => {
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      const m = this.meta();
      const w = this.own(wsId, agent);
      const nowMs = Date.now();
      const scope = tf.files.filter((f) => matches(f, w.intent.globs));
      const others = this.liveWs().filter((o) => o.id !== w.id);
      const fc = forecast(others, { wsId: w.id, globs: w.intent.globs, touched: w.touched }, tf.files, m.config, nowMs);
      const peers = fc.overlaps.map((o) => {
        const pw = others.find((x) => x.id === o.workspaceId);
        return { agent: o.agentName, workspace: o.workspaceId, task: o.task, mode: o.mode, strength: o.strength, files: o.files, theirIntent: pw?.intent.globs ?? o.globs, theirTouched: pw?.touched ?? [] };
      });
      const inScope = (files: string[]) => files.filter((f) => scope.includes(f) || matches(f, w.intent.globs));
      const landed = this.csByStatus("landed", 2000)
        .filter((c) => inScope(c.provenance.filesTouched).length > 0)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 12)
        .map((c) => ({ changeset: c.id, agent: c.provenance.agentName, model: c.provenance.model, message: c.message, commit: c.landedCommit, files: inScope(c.provenance.filesTouched), wqs: c.scorecard?.total ?? null, landedAt: c.updatedAt, afterMyBase: Date.parse(c.updatedAt) > Date.parse(w.createdAt) }));
      const mine = this.allCs(2000).filter((c) => c.wsId === w.id);
      const history = mine.map((c) => ({ changeset: c.id, status: c.status, message: c.message, rejection: c.rejection ? { reason: c.rejection.reason, files: c.rejection.files, conflictsWith: c.rejection.conflictsWith.map((p) => `${p.changesetId} (${p.agentName})`) } : null, wqs: c.scorecard?.total ?? null, advice: c.scorecard?.advice ?? [] }));
      const rooms = this.allRooms(200).filter((r) => r.wsId === w.id).map((r) => ({ room: r.id, status: r.status, changeset: r.csId, files: r.files, verified: r.verified?.candidate ?? null }));
      const recent = this.sql
        .exec<{ seq: number; at: number; type: string; data: string }>(`SELECT seq, at, type, data FROM events ORDER BY seq DESC LIMIT 400`)
        .toArray()
        .map((r) => ({ seq: r.seq, at: new Date(r.at).toISOString(), type: r.type, data: JSON.parse(r.data) as Record<string, unknown> }))
        .filter((e) => e.data.wsId === w.id || e.data.peerWs === w.id)
        .slice(0, 20)
        .map((e) => ({ at: e.at, type: e.type, csId: e.data.csId ?? null, detail: e.data.reason ?? e.data.forecast ?? e.data.message ?? null }));
      const conventions = {
        checkCommand: m.config.checkCommand,
        unionMergedFiles: m.config.unionGlobs,
        sensitivePaths: m.config.sensitiveGlobs,
        sensitiveInMyScope: scope.filter((f) => matches(f, m.config.sensitiveGlobs)),
        reviewThreshold: m.config.reviewThreshold,
        rubric: "wqs-1: check on merged tree 25 · tests with source 10 · stay in intent 5 · ≤400 lines 5 · no secrets 5 · judge 40 · first try + fresh base 10",
      };
      const expired = Date.parse(w.intent.expiresAt) <= nowMs;
      const next: string[] = [];
      if (expired) next.push("weft resume  # your lease expired; re-acquire the intent");
      if (rooms.some((r) => r.status === "verified")) next.push(`weft room accept ${rooms.find((r) => r.status === "verified")?.room ?? ""}`);
      if (landed.some((l) => l.afterMyBase)) next.push("weft sync  # trunk changed files in your scope since you started");
      if (peers.some((p) => p.strength === "touched")) next.push("coordinate: another agent already edited the same files");
      if (w.status === "active") next.push("weft status · weft checkpoint · weft submit -m \"...\"");

      // Budget: drop the least important detail first until the pack fits (≈ 4 chars per token).
      const pack = {
        workspace: { id: w.id, status: w.status, task: w.task, intent: w.intent.globs, mode: w.intent.mode, leaseExpiresAt: w.intent.expiresAt, expired, base: w.baseCommit, trunkHead: tf.head, touched: w.touched, outOfIntent: outOfIntent(w.touched, w.intent.globs, m.config.unionGlobs), changeset: w.changesetId },
        forecast: { risk: fc.risk, advice: fc.advice },
        peers,
        rooms,
        history,
        recentLandingsInScope: landed,
        scopeFiles: scope.slice(0, 400),
        conventions,
        recentEvents: recent,
        next,
        budget: { tokens: budgetTokens, trimmed: [] as string[] },
      };
      const size = () => Math.ceil(JSON.stringify(pack).length / 4);
      const trims: [string, () => void][] = [
        ["recentEvents", () => (pack.recentEvents = pack.recentEvents.slice(0, 5))],
        ["scopeFiles", () => (pack.scopeFiles = pack.scopeFiles.slice(0, 40))],
        ["recentLandingsInScope", () => (pack.recentLandingsInScope = pack.recentLandingsInScope.slice(0, 4))],
        ["history", () => (pack.history = pack.history.slice(-3))],
        ["scopeFiles", () => (pack.scopeFiles = [])],
        ["recentEvents", () => (pack.recentEvents = [])],
      ];
      for (const [name, trim] of trims) {
        if (size() <= budgetTokens) break;
        trim();
        pack.budget.trimmed.push(name);
      }
      return { ...pack, budget: { ...pack.budget, used: size() } };
    });
  }

  /** FR-16: re-acquire an expired workspace's intent if the scope is free, re-forecast, renew the lease. */
  resume(wsId: string, agent: AgentClaims) {
    return this.guard(async () => {
      const m0 = this.meta();
      const tf = await this.trunkFiles(m0);
      const m = this.meta();
      const w = this.own(wsId, agent);
      if (w.status !== "active" && w.status !== "conflicted") throw invalidState(`workspace ${w.id} is ${w.status}; only an active or conflicted workspace can be resumed`, w.status === "submitted" ? `weft show ${w.changesetId ?? ""}` : "weft start  # begin a new workspace");
      const others = this.liveWs().filter((o) => o.id !== w.id);
      const fc = forecast(others, { wsId: w.id, globs: w.intent.globs, touched: w.touched }, tf.files, m.config, Date.now());
      const blocking = blockingOverlaps(fc, w.intent.mode);
      if (blocking.length > 0) {
        throw new WeftError("LEASE_HELD", "another agent holds an exclusive intent over your scope", { retryable: true, hint: "wait for it to land, or narrow your scope with a new workspace", details: { blocking } });
      }
      const wasExpired = Date.parse(w.intent.expiresAt) <= Date.now();
      w.intent.expiresAt = plusSeconds(m.config.leaseTtlSeconds);
      w.expiredNotified = false;
      this.putWs(w);
      this.emit(m, "workspace.resumed", agent.sub, { wsId: w.id, agentName: w.agentName, wasExpired, forecast: fc.risk, peers: fc.overlaps.map((o) => o.agentName) }, fc.overlaps.map((o) => `agent:${o.agentId}`));
      this.saveMeta(m);
      const forkTok = await mintToken(this.env, w.forkRepo, "write", FORK_TOKEN_TTL);
      const trunkTok = await mintToken(this.env, m.repo, "read", TRUNK_READ_TTL);
      const fresh = this.ws(w.id);
      fresh.forkTokenId = forkTok.id;
      this.putWs(fresh);
      return {
        workspace: this.publicWs(fresh),
        wasExpired,
        forecast: fc,
        fork: { remote: fresh.forkRemote, token: headerToken(forkTok.plaintext), expiresAt: forkTok.expiresAt },
        trunk: { remote: m.trunkRemote, token: headerToken(trunkTok.plaintext), expiresAt: trunkTok.expiresAt, head: tf.head },
      };
    });
  }

  // ------------------------------------------------------------ Conflict Rooms (FR-24)

  /** Called inside landBatch's transaction for each conflict rejection. */
  private openRoom(m: Meta, c: Changeset, rejection: Rejection): Room {
    const peers: RoomPeer[] = (rejection.conflictsWith.length > 0 ? rejection.conflictsWith : this.peersFor(rejection.files, c.enqueuedAt)).map((p) => {
      const pc = p.changesetId ? this.sql.exec<{ data: string }>(`SELECT data FROM changesets WHERE id = ?`, p.changesetId).toArray()[0] : undefined;
      const task = pc ? (JSON.parse(pc.data) as Changeset).provenance.task : null;
      return { changesetId: p.changesetId, agentName: p.agentName, task, files: p.files };
    });
    const id = `r-${pad(this.nextSeq(m))}`;
    const room: Room = {
      id,
      repo: m.repo,
      csId: c.id,
      wsId: c.wsId,
      agentId: c.agentId,
      agentName: c.provenance.agentName,
      task: c.provenance.task,
      intentGlobs: c.provenance.intentGlobs,
      files: rejection.files,
      peers,
      status: "open",
      trunkHead: null,
      hunks: [],
      attempts: [],
      verified: null,
      resubmittedAs: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.putRoom(room);
    this.emit(m, "room.opened", "weft", { roomId: id, csId: c.id, wsId: c.wsId, agentName: room.agentName, files: room.files, peers: peers.map((p) => p.agentName) }, [`agent:${c.agentId}`]);
    return room;
  }

  private startResolver(repo: string, roomId: string): void {
    this.ctx.waitUntil(
      this.env.ROOM_RESOLVER.create({ id: `${repo.replace(/[^a-zA-Z0-9_-]/g, "_")}-${roomId}-${Date.now().toString(36)}`, params: { repo, roomId } }).catch((err: unknown) => {
        const msg = toWeftError(err).message;
        console.log(JSON.stringify({ level: "error", msg: "room resolver create failed", repo, roomId, err: msg }));
        const m = this.meta();
        const r = this.room(roomId);
        r.status = "failed";
        r.error = `resolver could not start: ${msg}`;
        this.putRoom(r);
        this.emit(m, "room.failed", "weft", { roomId, csId: r.csId, agentName: r.agentName, reason: r.error }, [`agent:${r.agentId}`]);
        this.saveMeta(m);
      }),
    );
  }

  /** Everything the RoomResolver Workflow needs (no tokens: those are minted inside the steps). */
  roomInput(roomId: string) {
    return this.guard(async () => {
      const m = this.meta();
      const r = this.room(roomId);
      const c = this.cs(r.csId);
      const w = this.ws(r.wsId);
      return {
        room: r,
        trunkRepo: m.repo,
        trunkRemote: m.trunkRemote,
        forkRepo: w.forkRepo,
        forkRemote: w.forkRemote,
        branch: w.branch,
        headCommit: c.headCommit,
        message: c.message,
        checkCommand: m.config.checkCommand,
        unionGlobs: m.config.unionGlobs,
        drivers: m.config.drivers ?? [],
        workspaceStatus: w.status,
      };
    });
  }

  /** Progress reports from the RoomResolver Workflow (idempotent per attempt number). */
  roomUpdate(roomId: string, patch: { status?: Room["status"]; trunkHead?: string; hunks?: RoomFile[]; attempt?: RoomAttempt; verified?: Room["verified"]; error?: string | null }) {
    return this.guard(async () => {
      const m = this.meta();
      const r = this.room(roomId);
      if (r.status === "accepted") return { status: r.status };
      if (patch.trunkHead !== undefined) r.trunkHead = patch.trunkHead;
      if (patch.hunks !== undefined) r.hunks = patch.hunks;
      if (patch.error !== undefined) r.error = patch.error;
      if (patch.attempt) {
        const a = patch.attempt;
        r.attempts = [...r.attempts.filter((x) => x.n !== a.n), a].sort((x, y) => x.n - y.n);
        this.emit(m, "room.proposed", "weft-resolver", {
          roomId,
          csId: r.csId,
          agentName: r.agentName,
          attempt: a.n,
          files: a.files,
          checkPassed: a.checkPassed,
          markersLeft: a.markersLeft,
          error: a.error,
          rationale: a.rationale,
        }, [`agent:${r.agentId}`]);
      }
      if (patch.verified !== undefined) r.verified = patch.verified;
      if (patch.status && patch.status !== r.status) {
        r.status = patch.status;
        if (r.status === "verified") {
          this.emit(m, "room.verified", "weft-resolver", { roomId, csId: r.csId, wsId: r.wsId, agentName: r.agentName, candidate: r.verified?.candidate ?? null, attempts: r.attempts.length }, [`agent:${r.agentId}`]);
        } else if (r.status === "failed") {
          this.emit(m, "room.failed", "weft-resolver", { roomId, csId: r.csId, agentName: r.agentName, reason: r.error ?? "no green proposal" }, [`agent:${r.agentId}`]);
        }
      }
      this.putRoom(r);
      this.saveMeta(m);
      return { status: r.status };
    });
  }

  /** The losing agent accepts a verified proposal: fast-forward its branch, then resubmit with Weft-Resolves. */
  roomAccept(roomId: string, agent: AgentClaims) {
    return this.guard(async () => {
      const m0 = this.meta();
      const r0 = this.room(roomId);
      if (r0.status !== "verified" || !r0.verified) throw invalidState(`room ${roomId} is ${r0.status}; only a verified proposal can be accepted`, r0.status === "failed" ? "resolve by hand: `weft sync`, fix, `weft submit --resolves " + r0.csId + "`" : "wait for the resolver (`weft room show " + roomId + "`)");
      const w0 = this.own(r0.wsId, agent);
      if (w0.status !== "active") throw invalidState(`workspace ${w0.id} is ${w0.status}`);
      const c0 = this.cs(r0.csId);
      const v = r0.verified;
      const write = await mintToken(this.env, w0.forkRepo, "write", 600);
      const read = await mintToken(this.env, w0.forkRepo, "read", 600);
      const trunkRead = await mintToken(this.env, m0.repo, "read", 600);
      await runner(this.env, m0.repo).fastForward({
        trunk: { remote: m0.trunkRemote, token: headerToken(trunkRead.plaintext) },
        fork: { forkRemote: w0.forkRemote, writeToken: headerToken(write.plaintext), readToken: headerToken(read.plaintext), branch: w0.branch },
        expected: c0.headCommit,
        to: v.candidate,
        toRef: v.branch,
      });
      const res = await this.submitCore({
        wsId: w0.id,
        agent,
        message: `${c0.message} (resolved in ${roomId})`,
        head: v.candidate,
        base: r0.trunkHead ?? c0.baseCommit,
        filesTouched: v.filesTouched,
        linesAdded: v.added,
        linesDeleted: v.deleted,
        checkpoints: 0,
        behind: 0,
        promptSha256: c0.provenance.promptSha256,
        toolCalls: c0.provenance.toolCalls,
        costUsd: c0.provenance.costUsd,
        resolves: r0.csId,
      });
      const m = this.meta();
      const r = this.room(roomId);
      r.status = "accepted";
      r.resubmittedAs = res.changeset.id;
      this.putRoom(r);
      const w = this.ws(w0.id);
      w.baseCommit = r.trunkHead ?? w.baseCommit;
      this.putWs(w);
      this.emit(m, "room.accepted", agent.sub, { roomId, csId: r.csId, resubmittedAs: res.changeset.id, agentName: r.agentName }, [`agent:${r.agentId}`]);
      this.saveMeta(m);
      return { room: r, changeset: res.changeset, branch: w.branch, head: v.candidate, base: w.baseCommit };
    });
  }

  rooms() {
    return this.guard(async () =>
      this.allRooms(200).map((r) => ({
        id: r.id,
        csId: r.csId,
        agentName: r.agentName,
        task: r.task,
        files: r.files,
        peers: r.peers.map((p) => p.agentName),
        status: r.status,
        attempts: r.attempts.length,
        checkPassed: r.attempts[r.attempts.length - 1]?.checkPassed ?? null,
        resubmittedAs: r.resubmittedAs,
        updatedAt: r.updatedAt,
      })),
    );
  }

  roomShow(roomId: string) {
    return this.guard(async () => this.room(roomId));
  }

  // ------------------------------------------------------------ read models

  show(csId: string) {
    return this.guard(async () => this.cs(csId));
  }

  queue() {
    return this.guard(async () => {
      const m = this.meta();
      const rows = ["needs_review", "queued", "validating"].flatMap((s) => this.csByStatus(s, 200));
      return {
        repo: m.repo,
        paused: m.paused,
        activeBatch: m.activeBatch,
        queue: rows.map((c) => ({ id: c.id, status: c.status, agent: c.provenance.agentName, risk: c.riskScore, files: c.provenance.filesTouched.length, message: c.message, hold: c.scorecard?.hold ?? null })),
      };
    });
  }

  events(since: number, limit = 500) {
    return this.guard(async () => {
      const m = this.meta();
      return this.sql
        .exec<{ seq: number; at: number; type: string; actor: string; data: string }>(`SELECT seq, at, type, actor, data FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`, since, limit)
        .toArray()
        .map((r) => ({ seq: r.seq, at: new Date(r.at).toISOString(), repo: m.repo, type: r.type as EventType, actor: r.actor, data: JSON.parse(r.data) as Record<string, unknown> }));
    });
  }

  who(path: string) {
    return this.guard(async () => {
      const intents = this.liveWs()
        .filter((w) => isLive(w, Date.now()))
        .filter((w) => w.touched.includes(path) || matches(path, w.intent.globs))
        .map((w) => ({ workspaceId: w.id, agentName: w.agentName, task: w.task, mode: w.intent.mode, strength: w.touched.includes(path) ? "touched" : "files" }));
      const recent = this.allCs(500)
        .filter((c) => c.status === "landed" && c.provenance.filesTouched.includes(path))
        .slice(0, 5)
        .map((c) => ({ changeset: c.id, agentName: c.provenance.agentName, model: c.provenance.model, message: c.message, commit: c.landedCommit }));
      return { path, intents, recent };
    });
  }

  leaderboard() {
    return this.guard(async () => {
      const rows = this.allCs(2000).filter((c) => c.status !== "queued" && c.status !== "validating");
      const agg = (key: (c: Changeset) => string) => {
        const map = new Map<string, { key: string; submitted: number; landed: number; rejected: number; reverted: number; held: number; wqs: number[]; alignment: number[]; firstTry: number }>();
        for (const c of rows) {
          const k = key(c);
          const e = map.get(k) ?? { key: k, submitted: 0, landed: 0, rejected: 0, reverted: 0, held: 0, wqs: [], alignment: [], firstTry: 0 };
          e.submitted += 1;
          if (c.status === "landed") e.landed += 1;
          if (c.status === "rejected") e.rejected += 1;
          if (c.status === "reverted") e.reverted += 1;
          if (c.scorecard?.hold) e.held += 1;
          if (typeof c.scorecard?.total === "number") e.wqs.push(c.scorecard.total);
          const ia = c.scorecard?.judge?.intentAlignment;
          if (typeof ia === "number") e.alignment.push(ia);
          if (c.scorecard?.process.find((g) => g.name === "first_try")?.pass && c.status === "landed") e.firstTry += 1;
          map.set(k, e);
        }
        const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
        return [...map.values()]
          .map((e) => ({ key: e.key, submitted: e.submitted, landed: e.landed, rejected: e.rejected, reverted: e.reverted, held: e.held, meanWqs: mean(e.wqs), meanIntentAlignment: mean(e.alignment), landRate: e.submitted ? Math.round((100 * e.landed) / e.submitted) : 0, firstTryRate: e.landed ? Math.round((100 * e.firstTry) / e.landed) : 0 }))
          .sort((a, b) => (b.meanWqs ?? -1) - (a.meanWqs ?? -1));
      };
      return { byAgent: agg((c) => c.provenance.agentName), byModel: agg((c) => c.provenance.model), rubric: "wqs-1" };
    });
  }

  snapshot() {
    return this.guard(async () => {
      const m = this.meta();
      const events = this.sql
        .exec<{ seq: number; at: number; type: string; actor: string; data: string }>(`SELECT seq, at, type, actor, data FROM events ORDER BY seq DESC LIMIT 80`)
        .toArray()
        .map((r) => ({ seq: r.seq, at: new Date(r.at).toISOString(), type: r.type, actor: r.actor, data: JSON.parse(r.data) as Record<string, unknown> }));
      const activeBatch = m.activeBatch ? this.batch(m.activeBatch.id) : null;
      const lastBatchRow = this.sql.exec<{ data: string }>(`SELECT data FROM batches ORDER BY rowid DESC LIMIT 1`).toArray()[0];
      const lastBatch = lastBatchRow ? (JSON.parse(lastBatchRow.data) as BatchRow) : null;
      const b = activeBatch ?? lastBatch;
      return {
        repo: m.repo,
        trunkRemote: m.trunkRemote,
        trunkHead: m.trunkHead,
        config: m.config,
        paused: m.paused,
        workspaces: this.allWs(100).filter((w) => w.status !== "abandoned").map((w) => this.publicWs(w)),
        changesets: this.allCs(100).map((c) => ({ ...c, scorecard: c.scorecard })),
        batch: b ? { id: b.id, state: b.state, trunkHead: b.claim.trunkHead, members: b.claim.members.map((x) => x.id) } : null,
        rooms: this.allRooms(50),
        events,
        seq: m.seq,
      };
    });
  }

  // ------------------------------------------------------------ WebSockets + alarm

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const role = request.headers.get("x-weft-ws-role") ?? "ui";
    const agentId = request.headers.get("x-weft-agent-id");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, role === "agent" && agentId ? [`agent:${agentId}`] : ["ui"]);
    const protocol = request.headers.get("Sec-WebSocket-Protocol");
    const headers = new Headers();
    if (protocol?.split(",").map((s) => s.trim()).includes("weft")) headers.set("Sec-WebSocket-Protocol", "weft");
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const msg = JSON.parse(message) as { t?: string; since?: number };
      if (msg.t === "subscribe") {
        const evs = await this.events(msg.since ?? 0, 200);
        for (const ev of evs) ws.send(JSON.stringify({ t: "event", event: ev }));
      }
    } catch (err: unknown) {
      ws.send(JSON.stringify({ t: "error", message: `bad message: ${String(err)}` }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async alarm(): Promise<void> {
    const m = this.metaOrNull();
    if (!m) return;
    // Stale runner lease: a Workflow that never reported back.
    if (m.activeBatch && Date.now() - m.activeBatch.since > RUNNER_LEASE_MS) {
      await this.requeueInternal(m.activeBatch.id, "runner lease expired", false);
    }
    const m2 = this.meta();
    let changed = false;
    for (const w of this.liveWs()) {
      if ((w.status === "active" || w.status === "conflicted") && !w.expiredNotified && Date.parse(w.intent.expiresAt) <= Date.now()) {
        w.expiredNotified = true;
        this.putWs(w);
        this.emit(m2, "workspace.expired", "weft", { wsId: w.id, agentName: w.agentName });
        changed = true;
      }
    }
    if (changed) this.saveMeta(m2);
    try {
      await this.kick("weft-alarm");
    } catch (err: unknown) {
      console.log(JSON.stringify({ level: "error", msg: "kick failed", err: toWeftError(err).message }));
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    const next = this.liveWs()
      .filter((w) => (w.status === "active" || w.status === "conflicted") && !w.expiredNotified)
      .map((w) => Date.parse(w.intent.expiresAt));
    const soonest = next.length ? Math.min(...next) : null;
    const m3 = this.meta();
    const pending = this.csByStatus("queued", 1).length > 0 && !m3.paused;
    const at = pending ? Date.now() + 20_000 : soonest;
    if (at !== null) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1_000));
  }
}
