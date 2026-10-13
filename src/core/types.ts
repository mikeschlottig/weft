// Weft domain types — shared by the Worker, the merge-runner Container and the CLI.
// Ported from prototype/cli/src/types/index.ts (the reference implementation).

export type IntentMode = "soft" | "exclusive";
export type WorkspaceStatus = "provisioning" | "active" | "conflicted" | "submitted" | "landed" | "abandoned";
export type ChangesetStatus = "queued" | "needs_review" | "validating" | "landed" | "rejected" | "reverted";
export type RejectionReason = "conflict" | "check_failed" | "policy" | "judge_hold" | "dependency" | "recipe_failed" | "human" | "infra";

/** FR-47: lagging outcome labels used to calibrate the judge (FR-48). */
export interface OutcomeLabel {
  label: "reverted" | "hotfixed" | "human_rejected";
  at: string;
  by: string | null;
  ref: string | null; // e.g. the hotfix changeset or revert commit
}

export interface AgentClaims {
  sub: string; // agent id
  name: string;
  model: string;
  /** `review`: a human (via Cloudflare Access) who may approve/reject but not administer. */
  role: "agent" | "admin" | "review";
  iat: number;
  exp: number;
  /** Token id (D6): recorded for long-lived grants. */
  jti?: string;
}

export interface Intent {
  globs: string[];
  mode: IntentMode;
  task: string;
  createdAt: string;
  expiresAt: string;
}

export interface Workspace {
  id: string;
  repo: string;
  agentId: string;
  agentName: string;
  model: string;
  task: string;
  branch: string;
  forkRepo: string;
  forkRemote: string;
  forkTokenId: string | null;
  baseCommit: string;
  status: WorkspaceStatus;
  intent: Intent;
  touched: string[];
  /** FR-08: per touched file, the declarations the agent changed (from the CLI's tree-sitter pass). */
  touchedSymbols?: Record<string, string[]>;
  /** FR-27: this workspace is stacked on a not-yet-landed changeset (forked from that changeset's fork). */
  after?: string | null;
  createdAt: string;
  updatedAt: string;
  changesetId: string | null;
  rejections: number;
}

export interface ConflictPeer {
  changesetId: string | null;
  agentId: string | null;
  agentName: string | null;
  workspaceId: string | null;
  commit: string | null;
  files: string[];
}

export interface Rejection {
  reason: RejectionReason;
  detail: string;
  files: string[];
  conflictsWith: ConflictPeer[];
  logKey: string | null;
}

export interface Provenance {
  agentId: string;
  agentName: string;
  model: string;
  task: string;
  intentGlobs: string[];
  filesTouched: string[];
  linesAdded: number;
  linesDeleted: number;
  checkpoints: number;
  forkHead: string;
  promptSha256: string | null;
  toolCalls: number | null;
  costUsd: number | null;
  /** E3: what the agent claimed at submit, kept when the runner's authoritative diff replaced it. */
  claimed?: { filesTouched: string[]; linesAdded: number; linesDeleted: number } | null;
}

export interface RiskFactor {
  name: string;
  weight: number;
  detail: string;
}

export interface Changeset {
  id: string;
  repo: string;
  wsId: string;
  agentId: string;
  message: string;
  headCommit: string;
  baseCommit: string;
  status: ChangesetStatus;
  riskScore: number;
  risk: RiskFactor[];
  provenance: Provenance;
  enqueuedAt: string;
  updatedAt: string;
  batchId: string | null;
  landedCommit: string | null;
  approvedBy: string | null;
  rejection: Rejection | null;
  resolves: string | null;
  scorecard: Scorecard | null;
  attempts: number;
  /** E4: platform failures while validating (separate from `attempts`, which count the changeset's own failures). */
  infraAttempts?: number;
  /** FR-27: parent changeset; this one is speculated on top of it and rejected if it is rejected. */
  after?: string | null;
  /** FR-25: replayed on the current trunk at landing instead of merging the fork's text. */
  recipe?: RecipeRef | null;
  outcome?: OutcomeLabel | null;
}

export interface RecipeRef {
  name: string;
  args: string[];
}

export const RECIPE_ARG = /^[A-Za-z0-9_.\/@:+=,-]{1,200}$/;

export interface RepoConfig {
  checkCommand: string | null;
  batchSize: number;
  reviewThreshold: number;
  sensitiveGlobs: string[];
  unionGlobs: string[];
  leaseTtlSeconds: number;
  batchWindowMs: number;
  /** Driver registry v2: merge drivers per glob, applied by the merge-runner (and `union` also in workspaces). */
  drivers?: MergeDriverRule[];
  /** FR-25: admin-defined codemods agents may reference by name; args reach the command as $1.. / WEFT_ARG_n, never spliced. */
  recipes?: Record<string, { command: string; description?: string }>;
  /** FR-26: batches validated concurrently when their file scopes are disjoint (default 2). */
  lanes?: number;
  judge: { enabled: boolean; model: string; holdOnSecurity: number; holdOnAlignment: number; secondOpinion?: string | null; disagreementHold?: number };
}

export type MergeDriverName = "union" | "json-merge" | "sorted-lines";
export interface MergeDriverRule {
  glob: string;
  driver: MergeDriverName;
}

export interface OverlapFinding {
  workspaceId: string;
  agentId: string;
  agentName: string;
  task: string;
  mode: IntentMode;
  strength: "files" | "prefix" | "touched" | "symbols-disjoint";
  files: string[];
  globs: string[];
  /** For "touched": the shared symbols ("path#Name") when both sides reported them. For "symbols-disjoint": each side's symbols. */
  symbols?: string[];
}

export interface Forecast {
  risk: "none" | "low" | "medium" | "high";
  overlaps: OverlapFinding[];
  advice: string;
  /** FR-09: live workspaces whose task is semantically close to this one. */
  duplicates?: { workspaceId: string; agentName: string; task: string; similarity: number }[];
}

export type EventType =
  | "repo.created"
  | "repo.configured"
  | "workspace.started"
  | "workspace.lease_refused"
  | "workspace.intent_widened"
  | "workspace.heartbeat"
  | "workspace.alert"
  | "workspace.synced"
  | "workspace.conflicted"
  | "workspace.abandoned"
  | "workspace.expired"
  | "changeset.submitted"
  | "changeset.needs_review"
  | "changeset.approved"
  | "changeset.judged"
  | "changeset.landed"
  | "changeset.rejected"
  | "changeset.reverted"
  | "queue.batch_started"
  | "queue.speculated"
  | "queue.batch_landed"
  | "queue.requeued"
  | "queue.flaky_check"
  | "changeset.rescored"
  | "mirror.pushed"
  | "mirror.failed"
  | "queue.trunk_red"
  | "room.opened"
  | "room.proposed"
  | "room.verified"
  | "room.failed"
  | "room.accepted"
  | "workspace.resumed"
  | "workspace.waiting"
  | "agent.killed"
  | "changeset.outcome";

export interface WeftEvent {
  seq: number;
  at: string;
  repo: string;
  type: EventType;
  actor: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------- quality rubric

export interface GateResult {
  name: string;
  pass: boolean;
  points: number;
  max: number;
  detail: string;
}

export interface JudgeAnswers {
  model: string;
  intentAlignment: number | null; // 0..3 (probability-weighted level)
  testAdequacy: number | null; // 0..3
  maintainability: number | null; // 0..2
  scopeCreep: number | null; // P(yes)
  securityConcern: number | null; // P(yes)
  correctnessRisk: "low" | "medium" | "high" | null;
  correctnessRiskP: Record<string, number> | null;
  error: string | null;
  /** FR-48: an independent second judge (default clef-flash); its intent score and the disagreement. */
  second?: { model: string; intentAlignment: number | null; securityConcern: number | null; error: string | null } | null;
  disagreement?: number | null;
}

export interface Scorecard {
  version: "wqs-1";
  total: number | null; // 0..100, null until the check has run
  gates: GateResult[];
  judge: JudgeAnswers | null;
  process: GateResult[];
  hold: string | null;
  advice: string[];
  computedAt: string;
}

export interface DiffStats {
  files: string[];
  added: number;
  deleted: number;
  testFiles: string[];
  sourceFiles: string[];
  secretFindings: string[];
  diffText: string;
  truncated: boolean;
}

// ---------------------------------------------------------------- batch protocol (Workflow <-> DO <-> Container)

export interface BatchMember {
  id: string;
  wsId: string;
  forkRepo: string;
  forkRemote: string;
  branch: string;
  headCommit: string;
  baseCommit: string;
  message: string;
  trailers: string[];
  filesTouched: string[];
  agentId: string;
  agentName: string;
  task: string;
  intentGlobs: string[];
  after?: string | null;
  recipe?: RecipeRef | null;
}

export interface BatchClaim {
  batchId: string;
  repo: string;
  trunkRepo: string;
  trunkRemote: string;
  trunkHead: string;
  claimTime: number; // unix seconds — fixed commit dates make speculation deterministic
  config: RepoConfig;
  members: BatchMember[];
  /** FR-26 / E1: lane slot (0-based). Each lane has its own merge-runner instance, so lanes run concurrently. */
  lane?: number;
}

export interface SpeculationResult {
  tip: string;
  applied: { id: string; commit: string; tree: string }[];
  rejected: { id: string; rejection: Rejection }[];
  checkPassed: Record<string, boolean>; // changeset id -> check passed on its merged prefix
  checksRun: number;
  bisectSteps: number;
  logs: { commit: string; text: string }[];
  readmitted?: string[]; // FR-28: conflict-rejected, then re-admitted after their only peers were culprits
  /** E2 flake guard: the merged tip was red once and green on a fresh re-run (these changesets landed anyway). */
  flaky?: string[];
}

export interface Envelope<T> {
  ok: true;
  command: string;
  data: T;
  hints: string[];
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: { code: string; message: string; retryable: boolean; hint: string | null; details: Record<string, unknown> };
  requestId?: string;
}

// ---------------------------------------------------------------- Conflict Rooms (FR-24)

export type RoomStatus = "open" | "proposing" | "verifying" | "verified" | "failed" | "accepted";

/** One conflicted (or related) file as the resolver sees it. Content is capped by the runner. */
export interface RoomFile {
  path: string;
  conflicted: boolean; // false = another file the losing changeset touched (e.g. its tests)
  base: string | null; // merge base
  ours: string | null; // current trunk
  theirs: string | null; // the losing changeset's head
  merged: string | null; // git merge-file output with conflict markers (conflicted files only)
  truncated: boolean;
}

export interface RoomPeer {
  changesetId: string | null;
  agentName: string | null;
  task: string | null;
  files: string[];
}

export interface RoomAttempt {
  n: number;
  model: string;
  files: string[]; // paths the proposal rewrote
  rationale: string;
  candidate: string | null; // merge commit: parents = trunk head, losing head
  checkPassed: boolean | null; // null = repo has no check command
  markersLeft: string[];
  logKey: string | null;
  error: string | null;
  ms: number;
}

export interface Room {
  id: string;
  repo: string;
  csId: string; // the rejected changeset
  wsId: string;
  agentId: string;
  agentName: string;
  task: string;
  intentGlobs: string[];
  files: string[]; // conflicted files at rejection
  peers: RoomPeer[];
  status: RoomStatus;
  trunkHead: string | null; // trunk the proposal was built on
  hunks: RoomFile[];
  attempts: RoomAttempt[];
  verified: { candidate: string; branch: string; filesTouched: string[]; added: number; deleted: number } | null;
  resubmittedAs: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
