// Weft Quality Score (WQS-1): the rubric every changeset is scored against before it lands.
//
//   gates   (50) deterministic, computed from the authoritative diff and the merged-tree check
//   judge   (40) a typed decision model (Cloudflare CLEF on Workers AI) answering fixed questions
//   process (10) how the agent got there: first-try landing, fresh base
//
// Scores are returned to the agent on every landing/rejection and aggregated per agent and per
// model (leaderboard), so agents and the people tuning them get a stable signal to improve on.
// Outcome labels (landed clean / reverted / rejected by a human) are recorded next to each score
// to calibrate thresholds later (JEV-cookbook style threshold sweeps) — see docs PRD V-0.02.

import { matches } from "./glob.ts";
import type { DiffStats, GateResult, JudgeAnswers, RepoConfig, Scorecard } from "./types.ts";

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/;
const NON_CODE = /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|svg|png|jpe?g|gif|css|html)$|(^|\/)(LICENSE|CHANGELOG|README)[^/]*$/i;

export const classifyFiles = (files: readonly string[]): { testFiles: string[]; sourceFiles: string[] } => ({
  testFiles: files.filter((f) => TEST_FILE.test(f)),
  sourceFiles: files.filter((f) => !TEST_FILE.test(f) && !NON_CODE.test(f)),
});

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "artifacts_token", re: /art_v1_[0-9a-f]{40}/ },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "openai_style_key", re: /\bsk-[A-Za-z0-9_-]{24,}/ },
  { name: "generic_assignment", re: /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i },
];

/** Scan only added lines of a unified diff. Returns finding names with file names, never the secret. */
export const scanAddedLines = (diff: string): string[] => {
  const out = new Set<string>();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const p of SECRET_PATTERNS) if (p.re.test(line)) out.add(`${p.name} in ${file}`);
    }
  }
  return [...out];
};

// ---------------------------------------------------------------- judge (CLEF / System One API)

export const JUDGE_QUESTIONS = {
  intent_alignment: {
    type: "score",
    instructions: "How completely does the code diff implement the stated task, without doing unrelated work?",
    criteria: ["Does not implement the task", "Partially implements the task", "Mostly implements the task", "Fully implements the task"],
  },
  test_adequacy: {
    type: "score",
    instructions: "How well do tests in the diff cover the behavior the diff changes?",
    criteria: ["No tests cover the changed behavior", "Weak or incidental coverage", "Adequate tests for the change", "Thorough tests including edge cases"],
  },
  maintainability: {
    type: "score",
    instructions: "How readable and maintainable is the changed code?",
    criteria: ["Hard to read or maintain", "Acceptable", "Clean and idiomatic"],
  },
  scope_creep: {
    type: "noul",
    instructions: "Does the diff change code that is unrelated to the stated task?",
  },
  security_concern: {
    type: "noul",
    instructions:
      "Does the diff likely introduce a security problem, such as an exposed secret, an injection risk, weakened authentication or authorization, or unsafe deserialization?",
  },
  correctness_risk: {
    type: "choice",
    instructions: "How likely is this change to break existing behavior?",
    criteria: {
      low: "Small, well-contained change that is unlikely to break existing behavior",
      medium: "Touches shared logic; could break callers or edge cases",
      high: "Likely to break existing behavior, or contains an evident bug",
    },
  },
} as const;

export const judgeState = (input: {
  task: string;
  intentGlobs: string[];
  message: string;
  stats: DiffStats;
}): string =>
  JSON.stringify({
    task: input.task,
    declared_scope: input.intentGlobs,
    commit_message: input.message,
    files_changed: input.stats.files,
    test_files_changed: input.stats.testFiles,
    lines_added: input.stats.added,
    lines_deleted: input.stats.deleted,
    diff_truncated: input.stats.truncated,
    diff: input.stats.diffText,
  });

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const pick = (obj: unknown, keys: string[]): unknown => {
  if (typeof obj !== "object" || obj === null) return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Tolerant parser: the documented examples show `answers.<id>.noul` / `.choice`; other fields vary by type. */
export const parseJudge = (model: string, raw: unknown): JudgeAnswers => {
  const answers = pick(raw, ["answers"]) ?? {};
  const get = (id: string): unknown => (answers as Record<string, unknown>)[id];
  const scoreOf = (id: string): number | null => {
    const a = get(id);
    return num(a) ?? num(pick(a, ["score", "value", "expected"]));
  };
  const noulOf = (id: string): number | null => {
    const a = get(id);
    return num(a) ?? num(pick(a, ["noul", "probability", "p", "yes"]));
  };
  const c = get("correctness_risk");
  const choice = pick(c, ["choice", "label", "answer"]);
  const probs = pick(c, ["probabilities", "options", "distribution"]);
  return {
    model,
    intentAlignment: scoreOf("intent_alignment"),
    testAdequacy: scoreOf("test_adequacy"),
    maintainability: scoreOf("maintainability"),
    scopeCreep: noulOf("scope_creep"),
    securityConcern: noulOf("security_concern"),
    correctnessRisk: choice === "low" || choice === "medium" || choice === "high" ? choice : null,
    correctnessRiskP:
      typeof probs === "object" && probs !== null
        ? Object.fromEntries(Object.entries(probs as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number>
        : null,
    error: null,
  };
};

// ---------------------------------------------------------------- scoring

const gate = (name: string, pass: boolean, points: number, max: number, detail: string): GateResult => ({ name, pass, points, max, detail });

export const preCheckGates = (stats: DiffStats, intentGlobs: string[], config: RepoConfig): GateResult[] => {
  const outside = stats.files.filter((f) => !matches(f, intentGlobs) && !matches(f, config.unionGlobs));
  const size = stats.added + stats.deleted;
  const testsOk = stats.sourceFiles.length === 0 || stats.testFiles.length > 0;
  return [
    gate("tests_with_source", testsOk, testsOk ? 10 : 0, 10, testsOk ? `${stats.testFiles.length} test file(s) changed` : `${stats.sourceFiles.length} source file(s) changed with no test changes`),
    gate("in_scope", outside.length === 0, outside.length === 0 ? 5 : 0, 5, outside.length === 0 ? "all files inside declared intent" : `outside intent: ${outside.slice(0, 5).join(", ")}`),
    gate("size_budget", size <= 400, size <= 400 ? 5 : size <= 1000 ? 2 : 0, 5, `${size} changed lines (budget 400)`),
    gate("no_secrets", stats.secretFindings.length === 0, stats.secretFindings.length === 0 ? 5 : 0, 5, stats.secretFindings.length === 0 ? "no secret patterns in added lines" : stats.secretFindings.join("; ")),
  ];
};

export const checkGate = (passed: boolean | null, hasCheck: boolean): GateResult =>
  !hasCheck
    ? gate("check_merged_tree", false, 0, 25, "repo has no check command")
    : passed === null
      ? gate("check_merged_tree", false, 0, 25, "not yet checked")
      : gate("check_merged_tree", passed, passed ? 25 : 0, 25, passed ? "check passed on the speculatively merged tree" : "check failed on the merged tree");

export const processGates = (rejectionsBefore: number, behindAtSubmit: number): GateResult[] => [
  gate("first_try", rejectionsBefore === 0, rejectionsBefore === 0 ? 5 : 0, 5, rejectionsBefore === 0 ? "landed on first submission" : `${rejectionsBefore} earlier rejection(s)`),
  gate("fresh_base", behindAtSubmit === 0, behindAtSubmit === 0 ? 5 : behindAtSubmit <= 2 ? 3 : 0, 5, `${behindAtSubmit} trunk commit(s) behind at submit`),
];

const judgePoints = (j: JudgeAnswers | null): { earned: number; max: number } => {
  if (!j || j.error) return { earned: 0, max: 0 };
  let earned = 0;
  let max = 0;
  const add = (v: number | null, scale: number, weight: number): void => {
    if (v === null) return;
    max += weight;
    earned += weight * Math.max(0, Math.min(1, v / scale));
  };
  add(j.intentAlignment, 3, 15);
  add(j.testAdequacy, 3, 10);
  add(j.maintainability, 2, 5);
  if (j.scopeCreep !== null) {
    max += 5;
    earned += 5 * (1 - j.scopeCreep);
  }
  if (j.securityConcern !== null) {
    max += 5;
    earned += 5 * (1 - j.securityConcern);
  }
  return { earned, max };
};

/** Decide, before speculation, whether a changeset must go to a human instead of the queue. */
export const holdReason = (pre: GateResult[], j: JudgeAnswers | null, config: RepoConfig): string | null => {
  const secrets = pre.find((g) => g.name === "no_secrets");
  if (secrets && !secrets.pass) return `possible secret in added lines (${secrets.detail})`;
  if (j && !j.error) {
    if (j.securityConcern !== null && j.securityConcern >= config.judge.holdOnSecurity) {
      return `judge: security concern p=${j.securityConcern.toFixed(2)} ≥ ${config.judge.holdOnSecurity}`;
    }
    if (j.intentAlignment !== null && j.intentAlignment < config.judge.holdOnAlignment) {
      return `judge: intent alignment ${j.intentAlignment.toFixed(2)}/3 < ${config.judge.holdOnAlignment}`;
    }
  }
  return null;
};

export const adviceFor = (gates: GateResult[], j: JudgeAnswers | null): string[] => {
  const tips: string[] = [];
  for (const g of gates) {
    if (g.pass) continue;
    if (g.name === "tests_with_source") tips.push("Add or update tests alongside source changes.");
    if (g.name === "in_scope") tips.push("Keep edits inside the declared intent, or `weft widen` before editing.");
    if (g.name === "size_budget") tips.push("Split large changes into smaller changesets (budget: 400 changed lines).");
    if (g.name === "no_secrets") tips.push("Remove credentials from the diff; use the platform's secret store.");
    if (g.name === "check_merged_tree") tips.push("Run the repo check locally after `weft sync` before submitting.");
    if (g.name === "first_try") tips.push("Sync and run checks before the first submit to avoid rejections.");
    if (g.name === "fresh_base") tips.push("Run `weft sync` right before `weft submit`.");
  }
  if (j && !j.error) {
    if (j.intentAlignment !== null && j.intentAlignment < 2) tips.push("Judge: the diff only partly implements the task; re-read the task statement.");
    if (j.testAdequacy !== null && j.testAdequacy < 1.5) tips.push("Judge: test coverage of the changed behavior is weak.");
    if (j.scopeCreep !== null && j.scopeCreep > 0.5) tips.push("Judge: the diff appears to include unrelated changes.");
    if (j.correctnessRisk === "high") tips.push("Judge: high risk of breaking existing behavior; add regression tests.");
  }
  return tips;
};

export const composeScorecard = (input: {
  pre: GateResult[];
  check: GateResult;
  judge: JudgeAnswers | null;
  process: GateResult[];
  hold: string | null;
  now: string;
}): Scorecard => {
  const gates = [input.check, ...input.pre];
  const det = [...gates, ...input.process];
  const jp = judgePoints(input.judge);
  const earned = det.reduce((s, g) => s + g.points, 0) + jp.earned;
  const max = det.reduce((s, g) => s + g.max, 0) + jp.max;
  const checked = input.check.detail !== "not yet checked";
  return {
    version: "wqs-1",
    total: checked && max > 0 ? Math.round((100 * earned) / max) : null,
    gates,
    judge: input.judge,
    process: input.process,
    hold: input.hold,
    advice: adviceFor(det, input.judge),
    computedAt: input.now,
  };
};
