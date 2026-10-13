// Pure achievement logic for `daemon`. No DOM, no runtime `sim.ts`/`GameState` import — the
// helpers read a narrow `AchievementInput` so they stay testable and cycle-free. State, the
// income hook, and the `tick` call live in `src/sim.ts`.
//
// Achievements are the numeric counterpart to milestones' content unlocks: each earned row
// grants a small permanent income multiplier, applied through exactly one hook
// (`rawCyclesPerSec` in `src/sim.ts`).

import { d, type Decimal } from "./bignum";
import { METRICS, type MetricInput } from "./milestones";
import { ACHIEVEMENTS, type AchievementDef, type AchievementId } from "./config/achievements";

export * from "./config/achievements";

/** The slice of game state the achievement helpers read/write. `GameState` satisfies it. */
export interface AchievementInput extends MetricInput {
  achievementsDone: Record<AchievementId, true>;
}

/** True when the achievement's metric has reached its threshold. */
export function achievementMet(s: MetricInput, def: AchievementDef): boolean {
  return METRICS[def.metric](s) >= def.at;
}

/** Progress toward an achievement, clamped to `[0, 1]` for the panel bar. */
export function achievementProgress(s: MetricInput, def: AchievementDef): number {
  if (def.at <= 0) return 1;
  return Math.min(1, METRICS[def.metric](s) / def.at);
}

/**
 * Income multiplier from earned achievements: the product of `(1 + mult)` over the roster
 * rows recorded as done. Folds over `ACHIEVEMENTS`, so a stale key cannot affect income.
 */
export function achievementMult(s: Pick<AchievementInput, "achievementsDone">): Decimal {
  let mult = d(1);
  for (const a of ACHIEVEMENTS) if (s.achievementsDone[a.id]) mult = mult.mul(1 + a.mult);
  return mult;
}

/**
 * Fire every achievement whose predicate is met and that has not fired yet. Sticky (a fired
 * achievement stays fired) and idempotent (re-running adds nothing), so the sim may call it
 * every tick. Returns the newly-earned ids; logging is the sim's job.
 */
export function evaluateAchievements(s: AchievementInput): AchievementId[] {
  const fired: AchievementId[] = [];
  for (const a of ACHIEVEMENTS) {
    if (s.achievementsDone[a.id]) continue;
    if (!achievementMet(s, a)) continue;
    s.achievementsDone[a.id] = true;
    fired.push(a.id);
  }
  return fired;
}

/**
 * Panel order: pending achievements first, closest-to-earning on top (progress descending),
 * then earned ones. Pure, so the UI can recompute it each frame.
 */
export function orderedAchievements(s: AchievementInput): AchievementDef[] {
  const pending = ACHIEVEMENTS.filter((a) => !s.achievementsDone[a.id]).sort(
    (a, b) => achievementProgress(s, b) - achievementProgress(s, a),
  );
  const done = ACHIEVEMENTS.filter((a) => s.achievementsDone[a.id]);
  return [...pending, ...done];
}
