// MCP server: the CLI's verbs as tools, stateless (Agents SDK createMcpHandler; McpAgent is
// deprecated). Identity comes from the bearer JWT verified in index.ts. Tool results carry the
// same JSON envelope the CLI prints, so MCP and CLI clients parse identically.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { type ContextPack, contextMarkdown } from "../core/context.ts";
import { decodeFromRpc } from "../core/errors.ts";
import type { AgentClaims } from "../core/types.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const envelope = async (command: string, fn: () => Promise<unknown>, hints: string[] = []): Promise<ToolResult> => {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, command, data, hints }) }] };
  } catch (err: unknown) {
    const e = decodeFromRpc(err);
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, command, error: e.toJSON() }) }], isError: true };
  }
};

const buildServer = (env: Env, claims: AgentClaims): McpServer => {
  const s = new McpServer({ name: "weft", version: "0.1.0" });
  const repo = (r: string) => env.REPO.getByName(r);

  s.registerTool(
    "weft_start",
    {
      description: "Declare intent and open a workspace (an Artifacts fork). Returns the fork remote + token, trunk read token, and an overlap forecast.",
      inputSchema: z.object({ repo: z.string(), task: z.string(), touch: z.array(z.string()).min(1), exclusive: z.boolean().optional() }),
    },
    async (a) => envelope("start", () => repo(a.repo).start({ agent: claims, task: a.task, globs: a.touch, mode: a.exclusive ? "exclusive" : "soft", ttl: null }), ["git clone the fork remote with header 'Authorization: Bearer <fork.token>'"]),
  );
  s.registerTool(
    "weft_heartbeat",
    {
      description: "Report the files you have touched; renews your lease and returns live overlaps with other agents.",
      inputSchema: z.object({ repo: z.string(), workspace: z.string(), touched: z.array(z.string()) }),
    },
    async (a) => envelope("status", () => repo(a.repo).heartbeat({ wsId: a.workspace, agent: claims, touched: a.touched })),
  );
  s.registerTool(
    "weft_submit",
    {
      description: "Submit your fork head as a changeset. Weft scores it (WQS rubric), validates it on the merged tree and lands it.",
      inputSchema: z.object({
        repo: z.string(),
        workspace: z.string(),
        message: z.string(),
        head: z.string().length(40),
        base: z.string().length(40),
        filesTouched: z.array(z.string()).min(1),
        linesAdded: z.number().int().nonnegative(),
        linesDeleted: z.number().int().nonnegative(),
        behind: z.number().int().nonnegative().optional(),
      }),
    },
    async (a) =>
      envelope("submit", () =>
        repo(a.repo).submit({
          wsId: a.workspace,
          agent: claims,
          message: a.message,
          head: a.head,
          base: a.base,
          filesTouched: a.filesTouched,
          linesAdded: a.linesAdded,
          linesDeleted: a.linesDeleted,
          checkpoints: 0,
          behind: a.behind ?? 0,
          promptSha256: null,
          toolCalls: null,
          costUsd: null,
          resolves: null,
        }),
      ),
  );
  s.registerTool(
    "weft_show",
    { description: "Show a changeset: status, provenance, risk, rejection and its WQS scorecard with improvement advice.", inputSchema: z.object({ repo: z.string(), changeset: z.string() }) },
    async (a) => envelope("show", () => repo(a.repo).show(a.changeset)),
  );
  s.registerTool(
    "weft_who",
    { description: "Who has live intent on a path, and who recently changed it.", inputSchema: z.object({ repo: z.string(), path: z.string() }) },
    async (a) => envelope("who", () => repo(a.repo).who(a.path)),
  );
  s.registerTool(
    "weft_queue",
    { description: "The merge queue: needs-review, queued and validating changesets.", inputSchema: z.object({ repo: z.string() }) },
    async (a) => envelope("queue", () => repo(a.repo).queue()),
  );
  s.registerTool(
    "weft_context",
    {
      description: "Your context pack as prompt-ready Markdown: task, intent, collision forecast, nearby agents, your earlier rejections + advice, recent landings in your scope, house rules, next steps. Read it at the start of every session.",
      inputSchema: z.object({ repo: z.string(), workspace: z.string(), budgetTokens: z.number().int().min(800).max(32000).optional() }),
    },
    async (a) => envelope("context", async () => ({ markdown: contextMarkdown((await repo(a.repo).contextPack(a.workspace, claims, a.budgetTokens ?? 6000)) as unknown as ContextPack, a.repo) })),
  );
  s.registerTool(
    "weft_resume",
    { description: "Resume your workspace after a crash or an expired lease: re-acquires the intent if free, re-forecasts, returns fresh fork/trunk tokens.", inputSchema: z.object({ repo: z.string(), workspace: z.string() }) },
    async (a) => envelope("resume", () => repo(a.repo).resume(a.workspace, claims)),
  );
  s.registerTool(
    "weft_rooms",
    { description: "Conflict rooms for the repo: each rejected-for-conflict changeset, the resolver's attempts and whether a check-verified resolution is ready.", inputSchema: z.object({ repo: z.string() }) },
    async (a) => envelope("room list", () => repo(a.repo).rooms()),
  );
  s.registerTool(
    "weft_room_show",
    { description: "One conflict room: both intents, the conflicted files with markers, every resolver attempt with its check verdict.", inputSchema: z.object({ repo: z.string(), room: z.string() }) },
    async (a) => envelope("room show", () => repo(a.repo).roomShow(a.room)),
  );
  s.registerTool(
    "weft_room_accept",
    {
      description: "Accept a verified resolution: your workspace branch is fast-forwarded to the merge commit that passed the check, and it is resubmitted with Weft-Resolves. Then fetch your fork branch.",
      inputSchema: z.object({ repo: z.string(), room: z.string() }),
    },
    async (a) => envelope("room accept", () => repo(a.repo).roomAccept(a.room, claims), ["git fetch origin && git reset --hard <head> in your checkout"]),
  );
  // D8: an agent with no local checkout works entirely through its workspace sandbox.
  s.registerTool(
    "weft_sandbox_open",
    { description: "Clone your workspace fork into a cloud sandbox (no local checkout needed). Then use weft_exec to run commands in it.", inputSchema: z.object({ repo: z.string(), workspace: z.string() }) },
    async (a) =>
      envelope("sandbox open", async () => {
        const spec = await repo(a.repo).workspaceGit(a.workspace, claims);
        return env.SANDBOX.getByName(`${a.repo}/${a.workspace}`).open({ repo: a.repo, wsId: a.workspace, branch: spec.branch, baseCommit: spec.baseCommit, agentName: spec.agentName, fork: spec.fork, trunk: spec.trunk, stackedOn: spec.stackedOn });
      }),
  );
  s.registerTool(
    "weft_exec",
    { description: "Run a shell command (bash -lc) in your workspace sandbox, in the repo root. Returns exitCode, stdout, stderr. Edit files with it, run tests with it.", inputSchema: z.object({ repo: z.string(), workspace: z.string(), cmd: z.string().max(20000), timeoutSeconds: z.number().int().min(1).max(900).optional() }) },
    async (a) =>
      envelope("exec", async () => {
        await repo(a.repo).workspaceGit(a.workspace, claims);
        const r = await env.SANDBOX.getByName(`${a.repo}/${a.workspace}`).exec(a.cmd, (a.timeoutSeconds ?? 300) * 1000);
        if ("needsOpen" in r) throw new Error("INVALID_STATE: the sandbox is not open (or stopped while idle); call weft_sandbox_open, then retry");
        return r;
      }),
  );
  s.registerTool(
    "weft_limits",
    { description: "Measured usage of a repo against documented platform limits (Artifacts namespace rate, DO storage, lanes, queue depth).", inputSchema: z.object({ repo: z.string() }) },
    async (a) => envelope("limits", () => repo(a.repo).limits()),
  );
  s.registerTool(
    "weft_leaderboard",
    { description: "Quality leaderboard for the repo: mean WQS, land rate and first-try rate by agent and by model.", inputSchema: z.object({ repo: z.string() }) },
    async (a) => envelope("leaderboard", () => repo(a.repo).leaderboard()),
  );
  return s;
};

export const handleMcp = (req: Request, env: Env, exec: ExecutionContext, claims: AgentClaims): Promise<Response> =>
  createMcpHandler(() => buildServer(env, claims), { route: "/mcp" })(req, env, exec);
