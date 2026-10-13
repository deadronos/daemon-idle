// Perk-tree data and tunable constants for `daemon`.
//
// Pure data + types, no runtime imports (the `Decimal` import is type-only and erased),
// so this stays a leaf module that `src/perks.ts` reads. Editing the roster here is the
// only thing needed to add or rebalance a node; the fold, cost, gating, and UI are
// generic over `PERKS`.

import type { Decimal } from "../bignum";

export type PerkId = string;
export type Branch = "growth" | "survival" | "lineage";

/** Aggregate of every purchased perk, applied by the sim. One field per effect kind. */
export interface PerkMods {
  incomeMult: Decimal; // multiply, >= 1  (children + root)
  rootMult: Decimal; // multiply, >= 1  (root baseline only)
  tierCostMult: number; // divide in (0, 1]
  niceAdd: number; // add, >= 0  (equivalent extra `nice` levels)
  ramCapAdd: number; // add, >= 0
  heatGenMult: number; // divide in (0, 1]  (scales heat equilibrium)
  startShieldsAdd: number; // add, >= 0
  forkCostMult: number; // divide, floored at FORK_COST_FLOOR
  pointsMult: number; // multiply, >= 1
  legacyRateMult: Decimal; // multiply, >= 1
  startCycles: Decimal; // add, >= 0
}

export interface PerkDef {
  id: PerkId;
  branch: Branch;
  name: string;
  desc: string; // terminal-flavored flavor text
  requires?: PerkId; // prerequisite node (DAG edge); undefined = root of its branch
  maxLevel: number; // 1 for distinct perks; Infinity for sinks
  costBase: number; // points for level 0 -> 1
  costRate: number; // per-level cost multiplier: 1 = flat (distinct), 1.6 = sink
  mod: keyof PerkMods; // which aggregate field this node feeds
  perLevel: number; // magnitude per level (interpreted via MOD_KIND)
}

// --- pacing constants (exported so tuning never touches logic) --------------

export const T_REF = 300; // seconds for timeFactor = 1
export const E_REF = 1e6; // cycles for earnFactor = 1
export const DEPTH_GAIN = 2; // points per unit of depth
export const FLAT_BASE = 1; // flat points for a qualifying fork
export const MIN_RUN_SECONDS = 60;
export const MIN_RUN_EARNED = 1e3;
export const DEPTH_CAP = 1000; // bound on each factor before toNumber()
export const MAX_POINTS_PER_FORK = 1e6; // hard ceiling on a single grant
export const SINK_RATE = 1.6; // per-level cost multiplier used by sink nodes
export const FORK_COST_FLOOR = 0.25; // floor on the forkCost-reduction multiplier

// --- roster -----------------------------------------------------------------

export const PERKS: PerkDef[] = [
  // growth — more cycles, cheaper herd
  {
    id: "spin",
    branch: "growth",
    name: "spin loop",
    desc: "warm the branch predictor; the herd ticks a little harder",
    maxLevel: 1,
    costBase: 2,
    costRate: 1,
    mod: "incomeMult",
    perLevel: 0.1,
  },
  {
    id: "tailcall",
    branch: "growth",
    name: "tail-call opt",
    desc: "reuse the frame; spawning gets cheaper",
    requires: "spin",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "tierCostMult",
    perLevel: 0.08,
  },
  {
    id: "prefetch",
    branch: "growth",
    name: "prefetcher",
    desc: "read ahead; the herd wastes fewer stalls",
    requires: "spin",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "incomeMult",
    perLevel: 0.15,
  },
  {
    id: "vec",
    branch: "growth",
    name: "vectorized",
    desc: "the root process itself runs wide",
    requires: "tailcall",
    maxLevel: 1,
    costBase: 10,
    costRate: 1,
    mod: "rootMult",
    perLevel: 1.0,
  },
  {
    id: "pipeline",
    branch: "growth",
    name: "pipelining",
    desc: "overlap the stages; margin shrinks as it deepens",
    requires: "prefetch",
    maxLevel: Infinity,
    costBase: 3,
    costRate: SINK_RATE,
    mod: "incomeMult",
    perLevel: 0.1,
  },

  // survival — keep the herd alive
  {
    id: "renice",
    branch: "survival",
    name: "re-nice",
    desc: "renice the herd; the sweep takes fewer",
    maxLevel: 1,
    costBase: 2,
    costRate: 1,
    mod: "niceAdd",
    perLevel: 1,
  },
  {
    id: "oomguard",
    branch: "survival",
    name: "oom-guard",
    desc: "reserve a slab; the ceiling lifts",
    requires: "renice",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "ramCapAdd",
    perLevel: 8,
  },
  {
    id: "heatsink",
    branch: "survival",
    name: "heatsink",
    desc: "bleed the heat before the throttle bites",
    requires: "renice",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "heatGenMult",
    perLevel: 0.1,
  },
  {
    id: "sigblock",
    branch: "survival",
    name: "signal mask",
    desc: "start every instance behind a shield",
    requires: "oomguard",
    maxLevel: 1,
    costBase: 10,
    costRate: 1,
    mod: "startShieldsAdd",
    perLevel: 1,
  },
  {
    id: "reaper",
    branch: "survival",
    name: "lazy sweeper",
    desc: "the supervisor looks the other way, a little more each level",
    requires: "heatsink",
    maxLevel: Infinity,
    costBase: 3,
    costRate: SINK_RATE,
    mod: "niceAdd",
    perLevel: 1,
  },

  // lineage — meta-carryover (the risky branch)
  {
    id: "echo",
    branch: "lineage",
    name: "lineage echo",
    desc: "each fork leaves a little more behind",
    maxLevel: 1,
    costBase: 2,
    costRate: 1,
    mod: "pointsMult",
    perLevel: 0.05,
  },
  {
    id: "cheapfork",
    branch: "lineage",
    name: "cheap fork",
    desc: "fork earlier for less (never free)",
    requires: "echo",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "forkCostMult",
    perLevel: 0.1,
  },
  {
    id: "cache",
    branch: "lineage",
    name: "ancestor cache",
    desc: "your old daemons run hotter",
    requires: "echo",
    maxLevel: 1,
    costBase: 5,
    costRate: 1,
    mod: "legacyRateMult",
    perLevel: 0.05,
  },
  {
    id: "startup",
    branch: "lineage",
    name: "warm start",
    desc: "boot with a head start of cycles",
    requires: "cheapfork",
    maxLevel: 1,
    costBase: 10,
    costRate: 1,
    mod: "startCycles",
    perLevel: 1000,
  },
  {
    id: "recursion",
    branch: "lineage",
    name: "recursion",
    desc: "the fork forks; returns shrink as it deepens",
    requires: "cache",
    maxLevel: Infinity,
    costBase: 3,
    costRate: SINK_RATE,
    mod: "pointsMult",
    perLevel: 0.05,
  },
];

export function perkById(id: PerkId): PerkDef | undefined {
  return PERKS.find((p) => p.id === id);
}
