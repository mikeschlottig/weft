// Context pack → prompt-ready Markdown (pure; unit-tested). The pack itself is built by the coordinator.

export interface ContextPack {
  workspace: { id: string; status: string; task: string; intent: string[]; mode: string; leaseExpiresAt: string; expired: boolean; base: string; trunkHead: string | null; touched: string[]; outOfIntent: string[]; changeset: string | null };
  forecast: { risk: string; advice: string };
  peers: { agent: string; workspace: string; task: string; mode: string; strength: string; files: string[]; theirIntent: string[]; theirTouched: string[] }[];
  rooms: { room: string; status: string; changeset: string; files: string[]; verified: string | null }[];
  history: { changeset: string; status: string; message: string; rejection: { reason: string; files: string[]; conflictsWith: string[] } | null; wqs: number | null; advice: string[] }[];
  recentLandingsInScope: { changeset: string; agent: string; model: string; message: string; commit: string | null; files: string[]; wqs: number | null; landedAt: string; afterMyBase: boolean }[];
  scopeFiles: string[];
  conventions: { checkCommand: string | null; unionMergedFiles: string[]; sensitivePaths: string[]; sensitiveInMyScope: string[]; reviewThreshold: number; rubric: string };
  recentEvents: { at: string; type: string; csId: unknown; detail: unknown }[];
  next: string[];
  budget: { tokens: number; trimmed: string[]; used?: number };
}

const list = (xs: string[], empty = "none"): string => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : empty);

export const contextMarkdown = (p: ContextPack, repo: string): string => {
  const w = p.workspace;
  const out: string[] = [];
  out.push(`# Weft context — ${repo} · ${w.id}`);
  out.push(`You are working in a Weft workspace. Many agents edit this repo at once; Weft coordinates them. Read this before editing.`);
  out.push(`\n## Your task\n${w.task}\n\n- Intent (files you declared): ${list(w.intent)} · mode **${w.mode}**`);
  out.push(`- Status: **${w.status}**${w.changeset ? ` · changeset ${w.changeset}` : ""} · lease ${w.expired ? "**EXPIRED** — run `weft resume`" : `until ${w.leaseExpiresAt}`}`);
  out.push(`- Touched so far: ${list(w.touched)}${w.outOfIntent.length ? `\n- ⚠ Outside your intent (costs WQS points; \`weft widen --touch\` first): ${list(w.outOfIntent)}` : ""}`);
  out.push(`- Base ${w.base.slice(0, 10)} · trunk ${String(w.trunkHead ?? "").slice(0, 10)}`);
  out.push(`\n## Collision forecast: ${p.forecast.risk}\n${p.forecast.advice}`);
  if (p.peers.length) {
    out.push(`\n## Other agents near your scope`);
    for (const x of p.peers) out.push(`- **${x.agent}** (${x.workspace}, ${x.mode}) — "${x.task}" · overlap: ${x.strength}${x.files.length ? ` on ${list(x.files)}` : ""}${x.theirTouched.length ? ` · has edited ${list(x.theirTouched)}` : ""}`);
  }
  if (p.rooms.length) {
    out.push(`\n## Conflict rooms for you`);
    for (const r of p.rooms) out.push(`- ${r.room} (${r.status}) for ${r.changeset} on ${list(r.files)}${r.status === "verified" ? ` — a check-verified resolution is ready: \`weft room accept ${r.room}\`` : ""}`);
  }
  if (p.history.length) {
    out.push(`\n## Your earlier submissions`);
    for (const h of p.history) {
      out.push(`- ${h.changeset} **${h.status}** — ${h.message}${h.wqs !== null ? ` (WQS ${h.wqs})` : ""}${h.rejection ? ` · rejected: ${h.rejection.reason}${h.rejection.conflictsWith.length ? ` with ${h.rejection.conflictsWith.join(", ")}` : ""}${h.rejection.files.length ? ` in ${list(h.rejection.files)}` : ""}` : ""}`);
      for (const a of h.advice.slice(0, 3)) out.push(`  - improve: ${a}`);
    }
  }
  if (p.recentLandingsInScope.length) {
    out.push(`\n## Recently landed in your scope`);
    for (const l of p.recentLandingsInScope) out.push(`- ${l.changeset} by ${l.agent} (${l.model}) — ${l.message} · ${list(l.files)}${l.afterMyBase ? " · **after you started: sync**" : ""}`);
  }
  const c = p.conventions;
  out.push(`\n## House rules`);
  out.push(`- Check run on the merged tree before anything lands: ${c.checkCommand ? `\`${c.checkCommand}\`` : "none configured"}`);
  out.push(`- Union-merged (append freely, never conflict): ${list(c.unionMergedFiles)}`);
  out.push(`- Sensitive paths (a human must approve): ${list(c.sensitivePaths)}${c.sensitiveInMyScope.length ? ` — in your scope: ${list(c.sensitiveInMyScope)}` : ""}`);
  out.push(`- Risk ≥ ${c.reviewThreshold} goes to human review. Quality rubric: ${c.rubric}`);
  if (p.scopeFiles.length) out.push(`\n## Files in your scope (${p.scopeFiles.length})\n${p.scopeFiles.map((f) => `- \`${f}\``).join("\n")}`);
  if (p.next.length) out.push(`\n## Next\n${p.next.map((n) => `- \`${n}\``).join("\n")}`);
  out.push(`\n<!-- weft context pack · budget ${p.budget.tokens} tokens · used ${p.budget.used ?? "?"}${p.budget.trimmed.length ? ` · trimmed ${p.budget.trimmed.join(", ")}` : ""} -->`);
  return `${out.join("\n")}\n`;
};
