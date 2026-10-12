// MCP server: the CLI's verbs as tools, stateless (Agents SDK createMcpHandler; McpAgent is
// deprecated). Identity comes from the bearer JWT verified in index.ts. Tool results carry the
// same JSON envelope the CLI prints, so MCP and CLI clients parse identically.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
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
    "weft_leaderboard",
    { description: "Quality leaderboard for the repo: mean WQS, land rate and first-try rate by agent and by model.", inputSchema: z.object({ repo: z.string() }) },
    async (a) => envelope("leaderboard", () => repo(a.repo).leaderboard()),
  );
  return s;
};

export const handleMcp = (req: Request, env: Env, exec: ExecutionContext, claims: AgentClaims): Promise<Response> =>
  createMcpHandler(() => buildServer(env, claims), { route: "/mcp" })(req, env, exec);
