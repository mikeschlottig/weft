// Decision-model classifiers (Cloudflare CLEF-flash, System One API) — pure: request shapes + answer parsing.
//
// Weft splits its Workers AI work by kind:
//   - decisions (score, classify, rank): CLEF / CLEF-flash — typed answers with probabilities, ms latency,
//     input tokens only ($0.038 / M for clef-flash);
//   - generation (write code): Gemma 4 — the Conflict Room resolver.
// Each classifier here is advisory or a pre-screen; the deterministic check on the merged tree stays the
// decider for anything that reaches trunk.

import type { Room, RoomFile } from "./types.ts";

export interface ClefRequest {
  model: "clef" | "clef-flash";
  state: string;
  questions: Record<string, { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown }>;
}

/** P(yes) for each noul question id; null where the answer is missing or malformed. */
export const noulAnswers = (raw: unknown, ids: readonly string[]): Record<string, number | null> => {
  const answers = ((raw as { answers?: unknown } | null)?.answers ?? {}) as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  for (const id of ids) {
    const a = answers[id];
    const v = typeof a === "number" ? a : typeof a === "object" && a !== null ? (a as { noul?: unknown; probability?: unknown }).noul ?? (a as { probability?: unknown }).probability : null;
    out[id] = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
  }
  return out;
};

// ---------------------------------------------------------------- FR-09 duplicate intent (embeddings → CLEF)

/** Embedding similarity at or above this makes a live task a candidate for the decision model. */
export const DUPLICATE_CANDIDATE_FLOOR = 0.55;
/** CLEF-flash P(same work) at or above this marks a duplicate. */
export const DUPLICATE_P = 0.5;
export const MAX_DUPLICATE_CANDIDATES = 8;

export const duplicateRequest = (task: string, candidates: readonly { workspaceId: string; agentName: string; task: string }[]): ClefRequest => ({
  model: "clef-flash",
  state: JSON.stringify({ new_task: task.slice(0, 1000), live_tasks: candidates.map((c, i) => ({ id: `t${i}`, agent: c.agentName, task: c.task.slice(0, 600) })) }),
  questions: Object.fromEntries(
    candidates.map((c, i) => [
      `same_t${i}`,
      {
        type: "noul" as const,
        instructions: `Is new_task the same piece of work as live task t${i} (by ${c.agentName}), so that finishing one would make the other redundant? Related work in the same area is not the same work.`,
      },
    ]),
  ),
});

/** Decision per candidate: CLEF-flash P(same work) when answered, else the embedding threshold (fallback). */
export const decideDuplicates = <T extends { similarity: number }>(
  candidates: readonly T[],
  p: readonly (number | null)[],
  embedThreshold: number,
): (T & { sameWorkP: number | null; decidedBy: "clef" | "embedding" })[] =>
  candidates.flatMap((c, i) => {
    const pi = p[i] ?? null;
    const dup = pi === null ? c.similarity >= embedThreshold : pi >= DUPLICATE_P;
    return dup ? [{ ...c, sameWorkP: pi, decidedBy: pi === null ? ("embedding" as const) : ("clef" as const) }] : [];
  });

// ---------------------------------------------------------------- FR-24 Conflict Room pre-screen

/** Below this P on either side, the proposal is sent back without spending a container check. */
export const ROOM_SCREEN_FLOOR = 0.1;

export const roomScreenRequest = (room: Room, files: readonly RoomFile[], proposal: readonly { path: string; content: string }[]): ClefRequest => ({
  model: "clef-flash",
  state: JSON.stringify({
    change_being_resolved: { agent: room.agentName, task: room.task },
    already_on_trunk: room.peers.map((p) => ({ agent: p.agentName, task: p.task })),
    conflicts: files.filter((f) => f.conflicted).map((f) => ({ path: f.path, merged_with_markers: (f.merged ?? "").slice(0, 6000) })),
    proposed_resolution: proposal.map((f) => ({ path: f.path, content: f.content.slice(0, 6000) })),
  }),
  questions: {
    keeps_change: { type: "noul", instructions: "Does proposed_resolution keep the behaviour that change_being_resolved was adding?" },
    keeps_trunk: { type: "noul", instructions: "Does proposed_resolution keep the behaviour of the work already_on_trunk?" },
  },
});

export interface RoomScreen {
  model: string;
  keepsChange: number | null;
  keepsTrunk: number | null;
  /** True when either side is confidently dropped (P below ROOM_SCREEN_FLOOR). */
  reject: boolean;
}

export const readRoomScreen = (model: string, raw: unknown): RoomScreen => {
  const a = noulAnswers(raw, ["keeps_change", "keeps_trunk"]);
  const low = (v: number | null): boolean => v !== null && v < ROOM_SCREEN_FLOOR;
  return { model, keepsChange: a.keeps_change ?? null, keepsTrunk: a.keeps_trunk ?? null, reject: low(a.keeps_change ?? null) || low(a.keeps_trunk ?? null) };
};
