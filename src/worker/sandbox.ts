// D8 (FR-15): a cloud sandbox per workspace. One WorkspaceSandbox Durable Object per (repo, workspace) owns
// one container through the Durable Object container API (ctx.container, scheduling_policy "durable_object" —
// the Sandbox SDK 1.0 model). The agent never needs a local clone: `weft start --sandbox` clones its fork
// inside the sandbox, `weft exec -- <cmd>` runs commands there, `weft submit` commits + pushes from there.
//
// Tokens are passed per call as process env (never written to disk, git config or DO storage). The Worker
// checks workspace ownership (coordinator.workspaceGit) before any call reaches this class.

import { DurableObject } from "cloudflare:workers";
import { WeftError, invalidState } from "../core/errors.ts";

const REPO_DIR = "/workspace/repo";
const IDLE_MS = 30 * 60_000;
const OUT_CAP = 1_000_000;

export interface SandboxSpec {
  repo: string;
  wsId: string;
  branch: string;
  baseCommit: string;
  agentName: string;
  fork: { remote: string; token: string };
  trunk: { remote: string; token: string };
  stackedOn: { branch: string; head: string } | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
  truncated: boolean;
}

const text = (buf: ArrayBuffer): { s: string; cut: boolean } => {
  const s = new TextDecoder().decode(buf);
  return s.length > OUT_CAP ? { s: s.slice(-OUT_CAP), cut: true } : { s, cut: false };
};

// Credentials ride in env (FT/TT) and reach git only as -c http.extraHeader for that one command.
const AUTH_FORK = 'git -c "http.extraHeader=Authorization: Bearer $FT"';
const AUTH_TRUNK = 'git -c "http.extraHeader=Authorization: Bearer $TT"';

export class WorkspaceSandbox extends DurableObject<Env> {
  private container(): Container {
    const c = this.ctx.container;
    if (!c) throw new WeftError("INTERNAL", "the WorkspaceSandbox container binding is not configured");
    return c;
  }

  private async ensureRunning(): Promise<Container> {
    const c = this.container();
    if (!c.running) {
      // Internet is on for git over HTTPS to *.artifacts.cloudflare.net (the fork) and the trunk.
      c.start({ image: c.images.workspace ?? "", entrypoint: ["sleep", "infinity"], enableInternet: true, instance: "lite", labels: { role: "weft-sandbox" } });
      await c.setInactivityTimeout(IDLE_MS);
    }
    return c;
  }

  private async run(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ExecResult> {
    const c = await this.ensureRunning();
    const started = Date.now();
    const proc = await c.exec(argv, { cwd: opts.cwd ?? "/workspace", env: { HOME: "/root", GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) }, signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000) });
    const out = await proc.output();
    const o = text(out.stdout);
    const e = text(out.stderr);
    return { exitCode: out.exitCode, stdout: o.s, stderr: e.s, ms: Date.now() - started, truncated: o.cut || e.cut };
  }

  /** Is the workspace clone present (it is lost if the container was stopped while idle)? */
  async status(): Promise<{ running: boolean; cloned: boolean; spec: { repo: string; wsId: string; branch: string } | null; head: string | null }> {
    const spec = await this.ctx.storage.get<{ repo: string; wsId: string; branch: string }>("spec");
    const c = this.container();
    if (!c.running) return { running: false, cloned: false, spec: spec ?? null, head: null };
    const r = await this.run(["sh", "-c", `git -C ${REPO_DIR} rev-parse HEAD 2>/dev/null || true`]);
    const head = r.stdout.trim();
    return { running: true, cloned: /^[0-9a-f]{40}$/.test(head), spec: spec ?? null, head: head || null };
  }

  /** Clone the workspace fork (or re-clone after an idle stop: checkpoints pushed to the fork survive). */
  async open(spec: SandboxSpec): Promise<{ head: string; branch: string; ms: number }> {
    const started = Date.now();
    const script = [
      "set -eu",
      `rm -rf ${REPO_DIR}`,
      `${AUTH_FORK} clone -q "$FORK" ${REPO_DIR}`,
      `cd ${REPO_DIR}`,
      'git remote add trunk "$TRUNK"',
      // A branch already pushed to the fork (earlier checkpoints) wins over the base: work is not lost.
      `if ${AUTH_FORK} fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null; then git checkout -q -B "$BRANCH" "origin/$BRANCH";`,
      `elif [ -n "$STACK_BRANCH" ]; then ${AUTH_FORK} fetch -q origin "+refs/heads/$STACK_BRANCH:refs/remotes/origin/$STACK_BRANCH" && git checkout -q -B "$BRANCH" "$STACK_HEAD";`,
      'else git checkout -q -B "$BRANCH"; fi',
      'git config user.name "$AGENT"',
      'git config user.email "$WS@agents.weft.dev"',
      'git config weft.base "$BASE"',
      "git rev-parse HEAD",
    ].join("\n");
    const r = await this.run(["bash", "-c", script], {
      env: { FT: spec.fork.token, TT: spec.trunk.token, FORK: spec.fork.remote, TRUNK: spec.trunk.remote, BRANCH: spec.branch, BASE: spec.baseCommit, AGENT: spec.agentName, WS: spec.wsId, STACK_BRANCH: spec.stackedOn?.branch ?? "", STACK_HEAD: spec.stackedOn?.head ?? "" },
      timeoutMs: 600_000,
    });
    if (r.exitCode !== 0) throw new WeftError("UPSTREAM_SANDBOX", `sandbox clone failed (exit ${r.exitCode}): ${r.stderr.replace(/Bearer [^"\s]+/g, "Bearer <redacted>").slice(-600)}`, { retryable: true });
    await this.ctx.storage.put("spec", { repo: spec.repo, wsId: spec.wsId, branch: spec.branch });
    return { head: r.stdout.trim().split("\n").pop() ?? "", branch: spec.branch, ms: Date.now() - started };
  }

  /** Run one agent command in the workspace (bash -lc). Never throws for a non-zero exit. */
  async exec(cmd: string, timeoutMs = 300_000): Promise<ExecResult | { needsOpen: true }> {
    const st = await this.status();
    if (!st.cloned) return { needsOpen: true };
    return this.run(["bash", "-lc", cmd], { cwd: REPO_DIR, env: { CI: "1", WEFT_SANDBOX: "1" }, timeoutMs: Math.min(Math.max(timeoutMs, 1_000), 900_000) });
  }

  /**
   * Commit everything, push the branch to the fork, and report the submit facts computed by git in the
   * sandbox (head, base, files, numstat, checkpoints, commits behind trunk) — the same facts the CLI sends.
   */
  async prepareSubmit(input: { message: string; forkToken: string; trunkToken: string }): Promise<{ head: string; base: string; files: string[]; added: number; deleted: number; checkpoints: number; behind: number } | { needsOpen: true }> {
    const st = await this.status();
    if (!st.cloned) return { needsOpen: true };
    const script = [
      "set -eu",
      `cd ${REPO_DIR}`,
      "git add -A",
      'git diff --cached --quiet || git commit -q -m "$MSG"',
      'B=$(git config --get weft.base)',
      "H=$(git rev-parse HEAD)",
      `${AUTH_FORK} push -q -f origin "HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD)"`,
      `${AUTH_TRUNK} fetch -q trunk "+refs/heads/main:refs/remotes/trunk/main"`,
      'jq -n --arg head "$H" --arg base "$B" --arg files "$(git diff --name-only "$B" "$H")" --arg numstat "$(git diff --numstat "$B" "$H")" --arg cps "$(git rev-list --count --no-merges "$B..HEAD")" --arg behind "$(git rev-list --count "$B..refs/remotes/trunk/main")" \'{head:$head, base:$base, files:$files, numstat:$numstat, checkpoints:($cps|tonumber), behind:($behind|tonumber)}\'',
    ].join("\n");
    const r = await this.run(["bash", "-c", script], { env: { FT: input.forkToken, TT: input.trunkToken, MSG: input.message }, timeoutMs: 600_000 });
    if (r.exitCode !== 0) throw new WeftError("UPSTREAM_SANDBOX", `sandbox submit failed (exit ${r.exitCode}): ${r.stderr.replace(/Bearer [^"\s]+/g, "Bearer <redacted>").slice(-600)}`, { retryable: true });
    const j = JSON.parse(r.stdout) as { head: string; base: string; files: string; numstat: string; checkpoints: number; behind: number };
    let added = 0;
    let deleted = 0;
    for (const row of j.numstat.split("\n").filter((x) => x.trim().length > 0)) {
      const [a = "0", d = "0"] = row.split("\t");
      added += Number.isNaN(Number(a)) ? 0 : Number(a);
      deleted += Number.isNaN(Number(d)) ? 0 : Number(d);
    }
    const files = j.files.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
    if (files.length === 0) throw invalidState("nothing to submit: the sandbox has no changes relative to the workspace base");
    return { head: j.head, base: j.base, files, added, deleted, checkpoints: j.checkpoints, behind: j.behind };
  }

  async close(): Promise<{ stopped: boolean }> {
    const c = this.container();
    const was = c.running;
    if (was) await c.destroy();
    await this.ctx.storage.deleteAll();
    return { stopped: was };
  }
}
