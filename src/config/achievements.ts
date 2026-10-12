// Achievement data and types for `daemon`.
//
// Pure data + types, no runtime imports. `src/achievements.ts` reads this and adds the
// pure logic; `src/sim.ts` owns the state, the income hook, and the `tick` evaluation.

import type { MetricId } from "./milestones"; // type-only: stays a leaf, no runtime edge

export type AchievementId = string;

export interface AchievementDef {
  id: AchievementId;
  name: string;
  desc: string;
  metric: MetricId; // read from METRICS in src/milestones.ts
  /** Met when `METRICS[metric](state) >= at`. */
  at: number;
  /** Small positive fraction, e.g. 0.02 = +2% income. */
  mult: number;
}

/** The roster. Eight rows cover all six metrics; the full product is ≈ 1.25×. */
export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first-earnings",
    name: "first earnings",
    desc: "earn 1,000 cycles",
    metric: "totalEarned",
    at: 1e3,
    mult: 0.02,
  },
  {
    id: "grinder",
    name: "grinder",
    desc: "earn 1,000,000,000 cycles",
    metric: "totalEarned",
    at: 1e9,
    mult: 0.05,
  },
  {
    id: "survivor",
    name: "survivor",
    desc: "survive 10 cleanup sweeps",
    metric: "sweepsSurvived",
    at: 10,
    mult: 0.02,
  },
  {
    id: "veteran",
    name: "veteran",
    desc: "survive 100 cleanup sweeps",
    metric: "sweepsSurvived",
    at: 100,
    mult: 0.04,
  },
  {
    id: "forker",
    name: "forker",
    desc: "fork once",
    metric: "forks",
    at: 1,
    mult: 0.02,
  },
  {
    id: "crowd",
    name: "crowd",
    desc: "run 50 children at once",
    metric: "children",
    at: 50,
    mult: 0.03,
  },
  {
    id: "headroom",
    name: "headroom",
    desc: "raise the RAM ceiling to 64 MB",
    metric: "ramCap",
    at: 64,
    mult: 0.03,
  },
  {
    id: "uptime",
    name: "uptime",
    desc: "play for one hour",
    metric: "playtime",
    at: 3600,
    mult: 0.02,
  },
];

export function achievementById(id: AchievementId): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}
