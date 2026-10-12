// Pure milestone logic for `daemon`. No DOM, no runtime `sim.ts` import — the helpers read a
// narrow `MilestoneInput` so they stay testable and cycle-free. State, the `tick` call, and
// the `nice`/`gc` gates live in `src/sim.ts`.

import type { Decimal } from "./bignum";
import { type MetricId, type MilestoneDef, type MilestoneId } from "./config/milestones";

export * from "./config/milestones";

/** The slice of game state the milestone helpers read/write. `GameState` satisfies it. */
export interface MilestoneInput {
  totalEarned: Decimal;
  sweepsSurvived: number;
  forks: number;
  playtime: number;
  counts: number[];
  ramCap: number;
  milestonesDone: Record<MilestoneId, true>;
  unlocks: Record<string, true>;
}

/** Comparable metric readers, one per `MetricId`. */
export const METRICS: Record<MetricId, (s: MilestoneInput) => number> = {
  totalEarned: (s) => s.totalEarned.toNumber(),
  sweepsSurvived: (s) => s.sweepsSurvived,
  forks: (s) => s.forks,
  playtime: (s) => s.playtime,
  children: (s) => s.counts.reduce((a, b) => a + b, 0),
  ramCap: (s) => s.ramCap,
};

export function milestoneMet(s: MilestoneInput, d: MilestoneDef): boolean {
  return METRICS[d.metric](s) >= d.at;
}

/** Progress toward a milestone, clamped to `[0, 1]` for the panel bar. */
export function milestoneProgress(s: MilestoneInput, d: MilestoneDef): number {
  if (d.at <= 0) return 1;
  return Math.min(1, METRICS[d.metric](s) / d.at);
}
