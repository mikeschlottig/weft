// Weft domain types — shared by the Worker, the merge-runner Container and the CLI.
// Ported from prototype/cli/src/types/index.ts (the reference implementation).

export type IntentMode = "soft" | "exclusive";
export type WorkspaceStatus = "provisioning" | "active" | "conflicted" | "submitted" | "landed" | "abandoned";
export type ChangesetStatus = "queued" | "needs_review" | "validating" | "landed" | "rejected" | "reverted";
export type RejectionReason = "conflict" | "check_failed" | "policy" | "judge_hold";

export interface AgentClaims {
  sub: string; // agent id
  name: string;
  model: string;
  role: "agent" | "admin";
  iat: number;
  exp: number;
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
}

export interface RepoConfig {
  checkCommand: string | null;
  batchSize: number;
  reviewThreshold: number;
  sensitiveGlobs: string[];
  unionGlobs: string[];
  leaseTtlSeconds: number;
  batchWindowMs: number;
  judge: { enabled: boolean; model: string; holdOnSecurity: number; holdOnAlignment: number };
}

export interface OverlapFinding {
  workspaceId: string;
  agentId: string;
  agentName: string;
  task: string;
  mode: IntentMode;
  strength: "files" | "prefix" | "touched";
  files: string[];
  globs: string[];
}

export interface Forecast {
  risk: "none" | "low" | "medium" | "high";
  overlaps: OverlapFinding[];
  advice: string;
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
  | "queue.trunk_red";

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
}

export interface SpeculationResult {
  tip: string;
  applied: { id: string; commit: string; tree: string }[];
  rejected: { id: string; rejection: Rejection }[];
  checkPassed: Record<string, boolean>; // changeset id -> check passed on its merged prefix
  checksRun: number;
  bisectSteps: number;
  logs: { commit: string; text: string }[];
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
