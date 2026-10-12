// Pure milestone logic for `daemon`. No DOM, no runtime `sim.ts` import — the helpers read a
// narrow `MilestoneInput` so they stay testable and cycle-free. State, the `tick` call, and
// the `nice`/`gc` gates live in `src/sim.ts`.

import type { Decimal } from "./bignum";
import {
  MILESTONES,
  type MetricId,
  type MilestoneDef,
  type MilestoneId,
} from "./config/milestones";

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

/** True when the named unlock has been granted. */
export function hasUnlock(s: Pick<MilestoneInput, "unlocks">, id: string): boolean {
  return Boolean(s.unlocks[id]);
}

/**
 * Fire every milestone whose predicate is met and that has not fired yet, granting its
 * unlocks. Sticky (a fired milestone stays fired) and idempotent (re-running adds nothing),
 * so the sim may call it every tick. Returns the newly-fired ids; logging is the sim's job.
 */
export function evaluateMilestones(s: MilestoneInput): MilestoneId[] {
  const fired: MilestoneId[] = [];
  for (const d of MILESTONES) {
    if (s.milestonesDone[d.id]) continue;
    if (!milestoneMet(s, d)) continue;
    s.milestonesDone[d.id] = true;
    for (const u of d.unlocks) s.unlocks[u] = true;
    fired.push(d.id);
  }
  return fired;
}
