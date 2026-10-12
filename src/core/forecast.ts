// Overlap forecasting and risk scoring — pure ports of prototype/cli/src/coordinator.ts
// (forecast, scoreRisk). Weights and policy are normative (spec §7.2, §7.4).

import { matches, prefixesOverlap } from "./glob.ts";
import type { Forecast, OverlapFinding, Provenance, RepoConfig, RiskFactor, Workspace } from "./types.ts";

export const isLive = (ws: Workspace, nowMs: number): boolean => {
  if (ws.status === "submitted" || ws.status === "provisioning") return true;
  if (ws.status !== "active" && ws.status !== "conflicted") return false;
  return Date.parse(ws.intent.expiresAt) > nowMs;
};

const finding = (ws: Workspace, strength: OverlapFinding["strength"], files: string[], globs: string[]): OverlapFinding => ({
  workspaceId: ws.id,
  agentId: ws.agentId,
  agentName: ws.agentName,
  task: ws.task,
  mode: ws.intent.mode,
  strength,
  files: files.slice(0, 50),
  globs,
});

export const forecast = (
  workspaces: readonly Workspace[],
  self: { wsId: string | null; globs: string[]; touched: string[] },
  trunkFiles: readonly string[],
  config: RepoConfig,
  nowMs: number,
): Forecast => {
  const merging = (f: string): boolean => !matches(f, config.unionGlobs);
  const files = trunkFiles.filter(merging);
  const selfTouched = self.touched.filter(merging);
  const mine = new Set([...files.filter((f) => matches(f, self.globs)), ...selfTouched]);
  const overlaps: OverlapFinding[] = [];
  for (const ws of workspaces) {
    if (ws.id === self.wsId || !isLive(ws, nowMs)) continue;
    const touchedHit = selfTouched.filter((f) => ws.touched.includes(f));
    if (touchedHit.length > 0) {
      overlaps.push(finding(ws, "touched", touchedHit, []));
      continue;
    }
    const theirs = files.filter((f) => matches(f, ws.intent.globs) || ws.touched.includes(f));
    const fileHit = theirs.filter((f) => mine.has(f));
    if (fileHit.length > 0) {
      overlaps.push(finding(ws, "files", fileHit, []));
      continue;
    }
    const prefixHit = prefixesOverlap(self.globs, ws.intent.globs);
    if (prefixHit.length > 0) overlaps.push(finding(ws, "prefix", [], prefixHit));
  }
  const risk: Forecast["risk"] = overlaps.some((o) => o.strength === "touched")
    ? "high"
    : overlaps.some((o) => o.strength === "files" && o.mode === "exclusive")
      ? "high"
      : overlaps.some((o) => o.strength === "files")
        ? "medium"
        : overlaps.length > 0
          ? "low"
          : "none";
  const advice =
    risk === "none"
      ? "No other live intent overlaps this scope. Proceed."
      : risk === "low"
        ? "Scopes share a directory prefix but no existing file. Proceed; new files may collide."
        : risk === "medium"
          ? "Another agent has declared intent on the same files. Coordinate, narrow scope, or sync often."
          : "Another agent has already modified the same files. Expect a conflict; sync before continuing.";
  return { risk, overlaps, advice };
};

export const blockingOverlaps = (fc: Forecast, requestedMode: "soft" | "exclusive"): OverlapFinding[] =>
  fc.overlaps.filter((o) => (o.mode === "exclusive" || requestedMode === "exclusive") && o.strength !== "prefix");

export const scoreRisk = (
  config: RepoConfig,
  prov: Provenance,
  overlaps: number,
  behind: number,
): { score: number; factors: RiskFactor[]; sensitive: boolean } => {
  const factors: RiskFactor[] = [];
  const add = (name: string, weight: number, detail: string): void => {
    if (weight > 0) factors.push({ name, weight: Math.round(weight), detail });
  };
  add("breadth", Math.min(25, prov.filesTouched.length * 2), `${prov.filesTouched.length} files`);
  add("size", Math.min(20, (prov.linesAdded + prov.linesDeleted) / 20), `+${prov.linesAdded} -${prov.linesDeleted}`);
  const sensitive = prov.filesTouched.filter((f) => matches(f, config.sensitiveGlobs));
  add("sensitive_paths", sensitive.length > 0 ? 35 : 0, sensitive.slice(0, 5).join(", "));
  const outside = prov.filesTouched.filter((f) => !matches(f, prov.intentGlobs) && !matches(f, config.unionGlobs));
  add("out_of_intent", outside.length > 0 ? 15 : 0, outside.slice(0, 5).join(", "));
  add("live_overlap", Math.min(20, overlaps * 10), `${overlaps} live overlapping workspace(s)`);
  add("drift", Math.min(10, behind * 2), `${behind} trunk commits behind`);
  add("no_automated_check", config.checkCommand ? 0 : 10, "repo has no check command");
  const score = Math.min(100, factors.reduce((s, f) => s + f.weight, 0));
  return { score, factors, sensitive: sensitive.length > 0 };
};

export const outOfIntent = (touched: readonly string[], globs: readonly string[], unionGlobs: readonly string[]): string[] =>
  touched.filter((f) => !matches(f, globs) && !matches(f, unionGlobs));
