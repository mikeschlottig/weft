// FR-48 calibration: per-signal threshold sweep against outcome labels (pure; unit-tested).
// A changeset is "bad" when its outcome label is reverted, hotfixed or human_rejected; "good" when it landed
// more than 7 days ago with no such label. Everything else is unlabeled and excluded.

export const MIN_LABELED = 150;
export const BAD_OUTCOMES = ["reverted", "hotfixed", "human_rejected"] as const;

export interface LabeledRow {
  bad: boolean;
  held: boolean;
  signals: Partial<Record<SignalName, number | null>>;
}

export type SignalName = "intentAlignment" | "testAdequacy" | "securityConcern" | "secondIntentAlignment" | "judgeDisagreement";

/** Direction: "low" = a LOW value predicts a bad outcome (scores); "high" = a HIGH value does (probabilities, disagreement). */
export const SIGNALS: Record<SignalName, "low" | "high"> = {
  intentAlignment: "low",
  testAdequacy: "low",
  securityConcern: "high",
  secondIntentAlignment: "low",
  judgeDisagreement: "high",
};

export interface SweepPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  flagged: number;
}

export interface SignalReport {
  signal: SignalName;
  direction: "low" | "high";
  n: number; // rows with this signal present
  best: SweepPoint | null;
  sweep: SweepPoint[];
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export const sweep = (rows: LabeledRow[], signal: SignalName): SignalReport => {
  const dir = SIGNALS[signal];
  const have = rows.filter((r) => typeof r.signals[signal] === "number") as (LabeledRow & { signals: Record<SignalName, number> })[];
  const values = [...new Set(have.map((r) => r.signals[signal]))].sort((a, b) => a - b);
  const totalBad = have.filter((r) => r.bad).length;
  const points: SweepPoint[] = [];
  for (const t of values) {
    const flagged = have.filter((r) => (dir === "low" ? r.signals[signal] <= t : r.signals[signal] >= t));
    const tp = flagged.filter((r) => r.bad).length;
    const precision = flagged.length ? tp / flagged.length : 0;
    const recall = totalBad ? tp / totalBad : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    points.push({ threshold: r3(t), precision: r3(precision), recall: r3(recall), f1: r3(f1), flagged: flagged.length });
  }
  const best = points.reduce<SweepPoint | null>((b, p) => (!b || p.f1 > b.f1 ? p : b), null);
  return { signal, direction: dir, n: have.length, best: best && best.f1 > 0 ? best : null, sweep: points };
};

export interface CalibrationReport {
  labeled: number;
  bad: number;
  sufficient: boolean;
  autoLandPrecision: number | null; // among labeled changesets the judge did NOT hold: share that were good
  signals: SignalReport[];
  note: string;
}

export const calibrate = (rows: LabeledRow[]): CalibrationReport => {
  const bad = rows.filter((r) => r.bad).length;
  const autoLanded = rows.filter((r) => !r.held);
  const autoLandPrecision = autoLanded.length ? r3(autoLanded.filter((r) => !r.bad).length / autoLanded.length) : null;
  const sufficient = rows.length >= MIN_LABELED;
  return {
    labeled: rows.length,
    bad,
    sufficient,
    autoLandPrecision,
    signals: (Object.keys(SIGNALS) as SignalName[]).map((s) => sweep(rows, s)),
    note: sufficient
      ? "Thresholds with the best F1 per signal are recommendations; apply with `weft config` after review."
      : `Only ${rows.length} labeled changesets (need ≥ ${MIN_LABELED}); thresholds below are indicative, not calibrated.`,
  };
};
