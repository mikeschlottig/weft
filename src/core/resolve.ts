// Conflict Room resolver logic (FR-24) — pure, no Cloudflare imports, unit-tested.
// The model only PROPOSES file contents. A proposal reaches trunk only after the merge-runner has
// built it as a merge commit and the repo's check passed on it (spec §9.7).

import type { Room, RoomAttempt, RoomFile } from "./types.ts";

export const RESOLVER_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const MAX_ROOM_ATTEMPTS = 3;
const FILE_OPEN = "=== FILE: ";
const FILE_CLOSE = "=== END FILE ===";

export interface Proposal {
  files: { path: string; content: string }[];
  rationale: string;
}

const block = (label: string, text: string | null): string => (text === null ? `${label}: (file does not exist)\n` : `${label}:\n\`\`\`\n${text}\n\`\`\`\n`);

/** Chat messages for one resolution attempt. `previous` carries the failed attempt's check log. */
export const resolverMessages = (room: Room, files: RoomFile[], previous: { attempt: RoomAttempt; log: string } | null): { role: "system" | "user"; content: string }[] => {
  const editable = files.map((f) => f.path);
  const system = [
    "You resolve git merge conflicts for a merge queue used by many AI coding agents.",
    "Two changes were made concurrently. 'ours' is trunk (the change that already landed). 'theirs' is the change being resolved.",
    "Produce final file contents that keep the intent of BOTH changes. Never drop the landed change's behavior.",
    "If both behaviors interact (for example one adds tax and the other adds a discount), combine them sensibly and update the affected tests so they describe the combined behavior.",
    "Remove every conflict marker. Do not invent unrelated changes.",
    `You may only output these paths: ${editable.join(", ")}.`,
    `Output format, exactly, for each file you change:\n${FILE_OPEN}<path> ===\n<full new file content>\n${FILE_CLOSE}\nThen one final line: RATIONALE: <one sentence>.`,
    "Output nothing else: no markdown fences around the files, no commentary.",
  ].join("\n");
  const peers = room.peers.map((p) => `- ${p.agentName ?? "trunk"} (${p.changesetId ?? "?"}): ${p.task ?? "unknown task"}; files ${p.files.join(", ")}`).join("\n");
  const parts = [
    `Change being resolved: ${room.csId} by ${room.agentName}. Task: "${room.task}". Declared scope: ${room.intentGlobs.join(", ")}.`,
    `Already landed (ours):\n${peers || "- (trunk moved; no single peer recorded)"}`,
    `Conflicted files: ${room.files.join(", ")}.`,
  ];
  for (const f of files) {
    parts.push(
      `\n## ${f.path}${f.conflicted ? " (CONFLICTED)" : " (also changed by the change being resolved)"}${f.truncated ? " [truncated]" : ""}\n` +
        (f.conflicted ? block("merged with conflict markers", f.merged) : "") +
        block("base", f.base) +
        block("ours (trunk)", f.ours) +
        block("theirs (change being resolved)", f.theirs),
    );
  }
  if (previous) {
    parts.push(
      `\nYour previous proposal (attempt ${previous.attempt.n}) was built and the repo's check FAILED. Fix it.` +
        (previous.attempt.markersLeft.length ? ` Conflict markers remained in: ${previous.attempt.markersLeft.join(", ")}.` : "") +
        `\nCheck output (tail):\n\`\`\`\n${previous.log.slice(-4000)}\n\`\`\``,
    );
  }
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
};

/** Extract the text of a Workers AI text-generation result (classic `response` or OpenAI-style `choices`). */
export const responseText = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const r = raw as { response?: unknown; result?: { response?: unknown }; choices?: { message?: { content?: unknown } }[] };
    if (typeof r.response === "string") return r.response;
    if (r.result && typeof r.result.response === "string") return r.result.response;
    const c = r.choices?.[0]?.message?.content;
    if (typeof c === "string") return c;
  }
  throw new Error(`unrecognized model output shape: ${JSON.stringify(raw).slice(0, 200)}`);
};

/** Parse the FILE blocks. Paths outside `allowed` are rejected (the model may not touch other files). */
export const parseProposal = (text: string, allowed: readonly string[]): Proposal => {
  const files: { path: string; content: string }[] = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf(FILE_OPEN, i);
    if (open === -1) break;
    const headEnd = text.indexOf("\n", open);
    if (headEnd === -1) break;
    const path = text.slice(open + FILE_OPEN.length, headEnd).replace(/\s*===\s*$/, "").trim();
    const close = text.indexOf(FILE_CLOSE, headEnd + 1);
    if (close === -1) throw new Error(`unterminated FILE block for ${path}`);
    let content = text.slice(headEnd + 1, close);
    if (content.endsWith("\n")) content = content.slice(0, -1);
    if (!allowed.includes(path)) throw new Error(`proposal touched a path outside the room: ${path}`);
    files.push({ path, content: `${content}\n` });
    i = close + FILE_CLOSE.length;
  }
  if (files.length === 0) throw new Error("proposal contained no FILE blocks");
  const m = /RATIONALE:\s*(.+)/.exec(text.slice(i));
  return { files, rationale: (m?.[1] ?? "").trim().slice(0, 500) };
};

export const hasConflictMarkers = (content: string): boolean => /^(<<<<<<<|>>>>>>>)( |$)/m.test(content) || /^=======$/m.test(content);
