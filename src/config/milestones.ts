// Milestone data and unlock-id constants for `daemon`.
//
// Pure data + types, no runtime imports. `src/milestones.ts` reads this and adds the pure
// logic; `src/sim.ts` owns the state and the `tick` evaluation.

export type MilestoneId = string;

/** A comparable metric a milestone can test. Read from `METRICS` in `src/milestones.ts`. */
export type MetricId =
  | "totalEarned"
  | "sweepsSurvived"
  | "forks"
  | "playtime"
  | "children"
  | "ramCap";

export interface MilestoneDef {
  id: MilestoneId;
  name: string;
  desc: string;
  metric: MetricId;
  /** Met when `metric(state) >= at`. */
  at: number;
  /** Unlock ids granted when the milestone fires (usually one). */
  unlocks: string[];
}

/** The starter set. #18/#19/#23 add their own rows on the forward unlock ids below. */
export const MILESTONES: MilestoneDef[] = [
  {
    id: "first-blood",
    name: "first blood",
    desc: "survive your first cleanup sweep",
    metric: "sweepsSurvived",
    at: 1,
    unlocks: ["nice"],
  },
  {
    id: "grown-up",
    name: "grown-up",
    desc: "raise the RAM ceiling to 24 MB",
    metric: "ramCap",
    at: 24,
    unlocks: ["gc"],
  },
  {
    id: "bulk-buy",
    name: "bulk-buy",
    desc: "earn 100,000 cycles",
    metric: "totalEarned",
    at: 1e5,
    unlocks: ["buy-max"],
  },
  {
    id: "hands-off",
    name: "hands-off",
    desc: "fork once",
    metric: "forks",
    at: 1,
    unlocks: ["auto-nice", "auto-malloc", "auto-free"],
  },
  {
    id: "legacy-respawn",
    name: "auto-respawn",
    desc: "fork twice",
    metric: "forks",
    at: 2,
    unlocks: ["legacy-respawn"],
  },
];

/**
 * Forward unlock ids. `nice`/`gc` are granted by the starter milestones above; the rest are
 * consumed by #18 (buy-max), #19 (auto-*), and #23 (tier gates follow a `tier:<index>`
 * convention). Declared here so features check a stable id.
 */
export const UNLOCK = {
  nice: "nice",
  gc: "gc",
  buyMax: "buy-max",
  autoNice: "auto-nice",
  autoMalloc: "auto-malloc",
  autoFree: "auto-free",
  legacyRespawn: "legacy-respawn",
} as const;

export function milestoneById(id: MilestoneId): MilestoneDef | undefined {
  return MILESTONES.find((m) => m.id === id);
}
