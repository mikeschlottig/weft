// Contest evaluator access — pure policy (no Cloudflare imports; unit-tested).
//
// An evaluator token lets a judge try Weft on a repository of their choosing without the admin token:
//   - it can create repos (GitHub import or upload), register agents, change repo config, approve/reject,
//     revert and kick the queue — only on repos named eval-*;
//   - agents it registers are named eval-* and may only work in eval-* repos;
//   - global caps (EVAL_MAX_REPOS, EVAL_MAX_AGENTS), a hard expiry, and an instant kill switch
//     (KV CONFIG "evaluator/disabled") bound the blast radius.
// It can never rotate keys, kill or budget agents, configure mirrors, or touch non-eval repos.

export const EVAL_PREFIX = "eval-";
// Raised from 10 / 30 on 2026-10-15: release gates and failed imports also use evaluator repos.
export const EVAL_MAX_REPOS = 25;
export const EVAL_MAX_AGENTS = 75;
/** Evaluator tokens never outlive this (the day after finalists present at Cloudflare Connect). */
export const EVAL_HARD_EXPIRY = Date.parse("2026-10-23T06:59:00Z");
export const EVAL_KILL_KEY = "evaluator/disabled";

/** Admin-level commands an evaluator may run (repo-scoped ones are further limited to eval-* repos). */
export const EVAL_ADMIN_COMMANDS: ReadonlySet<string> = new Set(["init", "agent register", "config", "revert", "queue run"]);

/** Repo-config keys an evaluator may set. Recipes and merge drivers stay admin-only. */
export const EVAL_CONFIG_KEYS: ReadonlySet<string> = new Set(["checkCommand", "sensitiveGlobs", "unionGlobs", "batchSize", "batchWindowMs", "reviewThreshold", "lanes"]);

export const isEvalName = (s: string | undefined | null): boolean => typeof s === "string" && /^eval-[a-z0-9][a-z0-9_-]{0,58}$/.test(s);

/** Only public GitHub HTTPS remotes may be imported with an evaluator token. */
export const isGithubHttps = (url: string): boolean => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/.test(url);

export type RouteAuth = "public" | "read" | "agent" | "review" | "admin";

export interface Decision {
  allow: boolean;
  reason?: string;
}

/** May an evaluator token call this route? `repo` is the :repo path parameter, when the route has one. */
export const evaluatorMay = (auth: RouteAuth, command: string, repo: string | undefined): Decision => {
  if (auth === "public" || auth === "read") return { allow: true };
  if (repo !== undefined && !isEvalName(repo)) {
    return { allow: false, reason: `evaluator access is limited to repositories named ${EVAL_PREFIX}* (got ${repo})` };
  }
  if (auth === "admin" && !EVAL_ADMIN_COMMANDS.has(command)) {
    return { allow: false, reason: `"${command}" needs the admin token; evaluator tokens can run: ${[...EVAL_ADMIN_COMMANDS].join(", ")}` };
  }
  return { allow: true };
};

/** May an agent registered by an evaluator (name eval-*) act on this repo? */
export const evalAgentMay = (agentName: string, repo: string | undefined): Decision =>
  isEvalName(agentName) && repo !== undefined && !isEvalName(repo)
    ? { allow: false, reason: `agent ${agentName} was registered for evaluation and may only work in ${EVAL_PREFIX}* repositories` }
    : { allow: true };

/** Keep only the config keys an evaluator may set; report what was dropped. */
export const filterEvalConfig = (patch: Record<string, unknown>): { patch: Record<string, unknown>; dropped: string[] } => {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (EVAL_CONFIG_KEYS.has(k)) out[k] = v;
    else dropped.push(k);
  }
  return { patch: out, dropped };
};

/** Expiry for a new evaluator token: the requested time, clamped to now+1 h … EVAL_HARD_EXPIRY. */
export const evalExpiry = (nowMs: number, requested: string | null): number => {
  const want = requested ? Date.parse(requested) : EVAL_HARD_EXPIRY;
  if (!Number.isFinite(want)) return EVAL_HARD_EXPIRY;
  return Math.max(nowMs + 3_600_000, Math.min(want, EVAL_HARD_EXPIRY));
};
