// Core simulation for `daemon` — pure state + functions, no DOM.
// Keep this deterministic and DOM-free so it stays testable.
//
// Unbounded values (cycles, costs, output, legacy rates) are Decimals from
// ./bignum. Bounded values (counts, RAM, timers) stay plain numbers.

import { d, Decimal } from "./bignum";
import { type PerkId } from "./config/perks";
import { type MilestoneId } from "./config/milestones";
import {
  canBuyPerk,
  perkById,
  perkCost,
  perkMods,
  pointsForFork,
  MAX_POINTS_PER_FORK,
} from "./perks";
import { evaluateMilestones, hasUnlock, milestoneById, UNLOCK } from "./milestones";

export interface TierDef {
  name: string;
  desc: string;
  baseCost: number;
  /** Per-tier cost multiplier applied on each purchase (cost curve). */
  costGrowth: number;
  baseOutput: number;
  ram: number;
  /** Sweep order: lower priority gets reaped first. */
  priority: number;
  /** Identity tag; `"leak-immune"` tiers consume RAM but never feed the leak. */
  trait: "none" | "leak-immune";
}

export const TIERS: TierDef[] = [
  {
    name: "noop loop",
    desc: "a flat while(true){} — cheap, dumb, keeps ticking",
    baseCost: 10,
    costGrowth: 1.12,
    baseOutput: 0.1,
    ram: 1,
    priority: 0,
    trait: "leak-immune",
  },
  {
    name: "fork()",
    desc: "a real worker child",
    baseCost: 100,
    costGrowth: 1.15,
    baseOutput: 1,
    ram: 2,
    priority: 1,
    trait: "none",
  },
  {
    name: "worker thread",
    desc: "threads are cheaper than processes",
    baseCost: 1_000,
    costGrowth: 1.15,
    baseOutput: 12,
    ram: 4,
    priority: 2,
    trait: "none",
  },
  {
    name: "microservice",
    desc: "it has its own Dockerfile, of course",
    baseCost: 10_000,
    costGrowth: 1.18,
    baseOutput: 150,
    ram: 8,
    priority: 3,
    trait: "none",
  },
  {
    name: "cron daemon",
    desc: "fires every night; nobody knows what it does",
    baseCost: 100_000,
    costGrowth: 1.22,
    baseOutput: 2000,
    ram: 16,
    priority: 4,
    trait: "none",
  },
];

/**
 * Default sacrifice order: tier indices sorted by ascending `TIERS.priority`.
 * `TIERS.priority` is now only the source of this default; the live order lives on
 * `GameState.sacrificeOrder` and the player can rearrange it.
 */
export const DEFAULT_SACRIFICE_ORDER: readonly number[] = Object.freeze(
  TIERS.map((_, i) => i).sort((a, b) => TIERS[a].priority - TIERS[b].priority),
);

/**
 * Cross-tier synergy links. Owning `from` units multiplies the output of tier
 * `tier` by `1 + pct * counts[from]`. Data-driven on purpose: links are declared
 * here, not branched in `childOutput`, so composition (not raw tier spam) matters.
 * Tier indices: 2 = worker thread, 3 = microservice, 4 = cron daemon.
 */
export const SYNERGY: Array<{ tier: number; from: number; pct: number }> = [
  { tier: 2 /* worker thread */, from: 3 /* microservice */, pct: 0.02 },
  { tier: 3 /* microservice */, from: 4 /* cron daemon */, pct: 0.05 },
];

const LEAK_RATE = 0.01; // fraction of footprint leaked per second
const LEGACY_CRASH_CHANCE = 0.002; // per second, per daemon
const LEGACY_SHARE = 0.1; // legacy daemon produces 10% of peak cps

export const HEAT_PER_RAM = 0.02; // heat gained per second per MB of childRam
export const HEAT_DECAY_RATE = 0.02; // proportional heat shed rate, 1/s, before cooling
export const HEAT_THROTTLE_AT = 60; // heat at which throttling begins
export const MAX_THROTTLE = 0.5; // most cycles/s that heat can strip

/** RAM may exceed the cap by this factor before the OOM killer fires (2% grace). */
export const OOM_TOLERANCE = 1.02;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface LegacyDaemon {
  name: string;
  rate: Decimal;
  crashed: boolean;
  respawn: number;
}

export interface GameState {
  cycles: Decimal;
  totalEarned: Decimal;
  counts: number[];
  /** Tier indices in reap order: earlier = sacrificed sooner. A permutation. */
  sacrificeOrder: number[];
  ramCap: number;
  leak: number;
  /** 0..100. Children generate it; it throttles income above HEAT_THROTTLE_AT. */
  heat: number;
  /**
   * Cooling upgrade level; each level sheds heat 50% faster and lowers the heat
   * equilibrium by the same `1 + cooling * 0.5` factor.
   */
  cooling: number;
  nice: number;
  /** Sweep charges; each absorbs one victim before selection. */
  shields: number;
  gc: number;
  forks: number;
  sweepTimer: number;
  sweepInterval: number;
  sweepsSurvived: number;
  rngState: number;
  nextDirective: DirectiveId;
  oomCount: number;
  ramWarned: boolean;
  legacy: LegacyDaemon[];
  /** Lineage points earned at fork; spent on permanent perks. */
  lineage: number;
  /** Purchased perk level per node id; a missing key means level 0. */
  perks: Record<PerkId, number>;
  /** `totalEarned` at the last fork (base for the per-run earnings delta). */
  runBaseEarned: Decimal;
  /** `playtime` at the last fork (base for the per-run duration). */
  runStartPlaytime: number;
  /** Milestones that have fired (sticky). */
  milestonesDone: Record<MilestoneId, true>;
  /** Unlock ids granted by milestones; features gate via `hasUnlock`. */
  unlocks: Record<string, true>;
  /** `buy max` toggle preference (is a bulk-buy capability unlocked). */
  buyMax: boolean;
  /** Auto-buy `nice` when affordable (needs the `auto-nice` unlock). */
  autoNice: boolean;
  /** Auto-buy `malloc` when affordable (needs the `auto-malloc` unlock). */
  autoMalloc: boolean;
  /** Auto-`free()` the leak at `freeThreshold` (needs the `auto-free` unlock). */
  autoFree: boolean;
  /** Leak MB at which auto-free fires. */
  freeThreshold: number;
  /** `nohup` level; each adds `OFFLINE_CAP_STEP` to the offline cap. */
  offlineCap: number;
  log: string[];
  playtime: number;
  lastSave: number;
  /** Save format version; bumped when `decode` must migrate legacy fields. */
  saveVersion: number;
}

/**
 * Current save format. Version 2 fixed `doFork` to snapshot legacy rates from the
 * lineage-free `baseCyclesPerSec`; saves below it still have lineage baked into their
 * legacy `rate`s and must be migrated in `decode` (see `src/persistence.ts`).
 * Version 3 added the lineage/perk fields (`lineage`, `perks`, `runBaseEarned`,
 * `runStartPlaytime`) and the milestone records (`milestonesDone`, `unlocks`) — both additive.
 * Version 4 added the `buyMax` toggle. Version 5 added the automation toggles
 * (`autoNice`, `autoMalloc`, `autoFree`) and `freeThreshold`. Version 6 added the `offlineCap`
 * level. Versions 3–6 are additive.
 */
export const SAVE_VERSION = 6;

export const BASE = {
  ramCap: 8,
  sweepInterval: 60,
  /** Baseline cycles/s from the root process itself, before any children. */
  rootOutput: 1,
};

/** Offline cap: 8 h base, +4 h per `nohup` level; a step budget bounds the replay loop. */
export const BASE_OFFLINE_CAP_S = 8 * 3600;
export const OFFLINE_CAP_STEP = 4 * 3600;
export const OFFLINE_MAX_STEPS = 200_000;

/** Sweep cadence floor (s) reached once escalation saturates. */
export const SWEEP_INTERVAL_MIN = 10;
/** Sweeps survived needed to shrink the cadence from `BASE.sweepInterval` to the floor. */
export const SWEEP_ESCALATE_SWEEPS = 60;

/** Income compounding per sweep survived. `survivalMult = (1 + SURVIVAL_BONUS)^sweepsSurvived`. */
export const SURVIVAL_BONUS = 0.05;

const LOG_LIMIT = 40;

export function newGame(): GameState {
  return {
    cycles: d(0),
    totalEarned: d(0),
    counts: TIERS.map(() => 0),
    sacrificeOrder: [...DEFAULT_SACRIFICE_ORDER],
    ramCap: BASE.ramCap,
    leak: 0,
    heat: 0,
    cooling: 0,
    nice: 0,
    shields: 0,
    gc: 0,
    forks: 0,
    sweepTimer: BASE.sweepInterval,
    sweepInterval: BASE.sweepInterval,
    sweepsSurvived: 0,
    rngState: Date.now() | 0 || 1,
    nextDirective: "standard",
    oomCount: 0,
    ramWarned: false,
    legacy: [],
    lineage: 0,
    perks: {},
    runBaseEarned: d(0),
    runStartPlaytime: 0,
    milestonesDone: {},
    unlocks: {},
    buyMax: false,
    autoNice: false,
    autoMalloc: false,
    autoFree: false,
    freeThreshold: 16,
    offlineCap: 0,
    log: ["boot: daemon pid 1 started (unattended)"],
    playtime: 0,
    lastSave: Date.now(),
    saveVersion: SAVE_VERSION,
  };
}

export function lineageMult(s: GameState): Decimal {
  return d(1 + s.forks * 0.1);
}

export function childRam(s: GameState): number {
  return s.counts.reduce((sum, n, i) => sum + n * TIERS[i].ram, 0);
}

export function ramUsed(s: GameState): number {
  return childRam(s) + s.leak;
}

/** Effective RAM ceiling: the purchased cap plus the `oomguard` perk bonus. */
export function ramCapTotal(s: GameState): number {
  return s.ramCap + perkMods(s).ramCapAdd;
}

/**
 * RAM that feeds the leak: like `childRam`, but skips `"leak-immune"` tiers.
 * Immune tiers still count toward `childRam`/`ramUsed` and spawn gating.
 */
function leakFootprint(s: GameState): number {
  return s.counts.reduce(
    (sum, n, i) => (TIERS[i].trait === "leak-immune" ? sum : sum + n * TIERS[i].ram),
    0,
  );
}

export function tierCost(s: GameState, i: number): Decimal {
  return d(TIERS[i].baseCost)
    .mul(d(TIERS[i].costGrowth).pow(s.counts[i]))
    .mul(perkMods(s).tierCostMult);
}

export function childOutput(s: GameState): Decimal {
  let sum = d(0);
  for (let i = 0; i < TIERS.length; i++) {
    sum = sum.add(d(TIERS[i].baseOutput).mul(s.counts[i]).mul(synergyMult(s, i)));
  }
  return sum;
}

/**
 * Output multiplier for tier `i`: the product of every `SYNERGY` link targeting it,
 * `1 + pct * counts[from]`. Tiers with no incoming link stay at exactly `1`.
 */
export function synergyMult(s: GameState, i: number): number {
  let mult = 1;
  for (const link of SYNERGY) {
    if (link.tier === i) mult *= 1 + link.pct * s.counts[link.from];
  }
  return mult;
}

/**
 * Heat the current footprint drives toward, before the `[0, 100]` clamp. Because
 * `HEAT_PER_RAM === HEAT_DECAY_RATE`, this is `childRam / (1 + cooling * 0.5)` MB —
 * roughly 1 heat per MB of child RAM, halved per two cooling levels.
 */
export function heatEquilibrium(s: GameState): number {
  return (
    ((childRam(s) * HEAT_PER_RAM) / (HEAT_DECAY_RATE * (1 + s.cooling * 0.5))) *
    perkMods(s).heatGenMult
  );
}

/**
 * Income multiplier from heat: `1` up to HEAT_THROTTLE_AT, then falls linearly to
 * `1 - MAX_THROTTLE` at heat 100.
 */
export function heatMult(s: GameState): number {
  const over = (s.heat - HEAT_THROTTLE_AT) / (100 - HEAT_THROTTLE_AT);
  return 1 - MAX_THROTTLE * clamp(over, 0, 1);
}

/**
 * Income multiplier from sweeps survived: `(1 + SURVIVAL_BONUS)^sweepsSurvived`. A
 * `Decimal`, not a JS number: `1.05^n` overflows a double after ~14 000 sweeps, and the
 * game is idle for days. The exponential engine that makes the economy scale.
 */
export function survivalMult(s: GameState): Decimal {
  return d(1 + SURVIVAL_BONUS).pow(s.sweepsSurvived);
}

/**
 * Income from children plus the root baseline, before lineage and heat. Lineage-free
 * on purpose: legacy daemon rates snapshot this, then `tick` applies `lineageMult`
 * once — baking lineage into the snapshot would double-count it. Children are scaled by
 * the global `survivalMult`; the root stays **outside** it so an empty board still earns
 * exactly `BASE.rootOutput` cycles/s.
 */
export function baseCyclesPerSec(s: GameState): Decimal {
  return childOutput(s).mul(survivalMult(s)).add(BASE.rootOutput);
}

/**
 * Live income base: `baseCyclesPerSec` with perk income applied (children scaled by
 * `incomeMult`, the root term additionally by `rootMult`). Kept out of `baseCyclesPerSec`
 * so the legacy-rate snapshot stays perk-free.
 */
function perkedBaseCyclesPerSec(s: GameState): Decimal {
  const m = perkMods(s);
  const children = childOutput(s).mul(survivalMult(s)).mul(m.incomeMult);
  const root = d(BASE.rootOutput).mul(m.incomeMult).mul(m.rootMult);
  return children.add(root);
}

/**
 * Income before the heat throttle: `baseCyclesPerSec` scaled by the lineage multiplier.
 * Forked legacy daemon rates are based on `baseCyclesPerSec`, not this, so lineage is
 * not baked into the new daemon's output.
 */
export function rawCyclesPerSec(s: GameState): Decimal {
  return perkedBaseCyclesPerSec(s).mul(lineageMult(s));
}

export function cyclesPerSec(s: GameState): Decimal {
  return rawCyclesPerSec(s).mul(heatMult(s));
}

export function sweepVictimMult(s: GameState): number {
  return Math.max(0.3, 1 - (s.nice + perkMods(s).niceAdd) * 0.03);
}

/**
 * Sweep cadence derived from progress: shrinks from `BASE.sweepInterval` toward
 * `SWEEP_INTERVAL_MIN` over `SWEEP_ESCALATE_SWEEPS`, softened back toward 60 s by
 * `nice` (via `sweepVictimMult`). Deterministic; the tick caches it on `s.sweepInterval`.
 */
export function sweepIntervalFor(s: GameState): number {
  const progress = Math.min(1, s.sweepsSurvived / SWEEP_ESCALATE_SWEEPS);
  const raw =
    BASE.sweepInterval - (BASE.sweepInterval - SWEEP_INTERVAL_MIN) * progress * sweepVictimMult(s);
  return Math.max(SWEEP_INTERVAL_MIN, raw);
}

// --- sacrifice order -------------------------------------------------------

/** Rank of `tier` in the player's sacrifice order (lower = reaped sooner). */
export function priorityOf(s: GameState, tier: number): number {
  return s.sacrificeOrder.indexOf(tier);
}

/** Tier indices sorted by `priorityOf`; a permutation of `0..TIERS.length-1`. */
export function priorityOrder(s: GameState): number[] {
  return TIERS.map((_, i) => i).sort((a, b) => priorityOf(s, a) - priorityOf(s, b));
}

/**
 * Move `tier` one slot earlier (`-1`) or later (`+1`), swapping with its neighbour.
 * Returns `false` (and mutates nothing) when the move would leave the range.
 */
export function movePriority(s: GameState, tier: number, delta: -1 | 1): boolean {
  const pos = s.sacrificeOrder.indexOf(tier);
  const next = pos + delta;
  if (pos < 0 || next < 0 || next >= s.sacrificeOrder.length) return false;
  s.sacrificeOrder[pos] = s.sacrificeOrder[next];
  s.sacrificeOrder[next] = tier;
  return true;
}

/**
 * Coerce loaded data into a valid sacrifice order. Accepts `unknown` (save decode);
 * returns a copy of the valid permutation when given one, else a copy of the default.
 */
export function sanitizeSacrificeOrder(order: unknown): number[] {
  if (!Array.isArray(order) || order.length !== TIERS.length) return [...DEFAULT_SACRIFICE_ORDER];
  const seen = new Set<number>();
  for (const t of order as unknown[]) {
    if (
      typeof t !== "number" ||
      !Number.isInteger(t) ||
      t < 0 ||
      t >= TIERS.length ||
      seen.has(t)
    ) {
      return [...DEFAULT_SACRIFICE_ORDER];
    }
    seen.add(t);
  }
  return (order as number[]).slice();
}

// --- sweep directives ------------------------------------------------------

export type DirectiveId = "standard" | "sigkill" | "scavenger" | "group-kill" | "backpressure";

export interface SweepDirective {
  id: DirectiveId;
  name: string; // shown on the countdown and in the sweep log line
  unlockAt: number; // minimum sweepsSurvived before it can be drawn
  ignoresNice: boolean; // when true, sweepVictimMult is not applied
  /** Number of victims for this sweep, before selection. */
  budget(s: GameState, totalChildren: number): number;
  /** Tier indices to reap, in kill order; length == number of victims. */
  victims(s: GameState, budget: number): number[];
  /** Optional side effect applied before selection (e.g. reclaim the leak). */
  pre?(s: GameState): void;
}

function baseSeverity(s: GameState): number {
  return Math.min(0.35, 0.15 + s.sweepsSurvived * 0.002);
}

/** Shared budget: `max(1, round(total * severity * frac * niceMult))`. */
function sweepBudget(s: GameState, total: number, frac: number, ignoresNice: boolean): number {
  const mult = ignoresNice ? 1 : sweepVictimMult(s);
  return Math.max(1, Math.round(total * baseSeverity(s) * frac * mult));
}

/** Pure: returns the tier indices to reap, taking up to `budget` from `order`. */
export function reapInOrder(s: GameState, order: number[], budget: number): number[] {
  const victims: number[] = [];
  let remaining = budget;
  for (const i of order) {
    const take = Math.min(s.counts[i], remaining);
    for (let n = 0; n < take; n++) victims.push(i);
    remaining -= take;
    if (remaining <= 0) break;
  }
  return victims;
}

const standard: SweepDirective = {
  id: "standard",
  name: "standard",
  unlockAt: 0,
  ignoresNice: false,
  budget: (s, total) => sweepBudget(s, total, 1, false),
  victims: (s, budget) => reapInOrder(s, priorityOrder(s), budget),
};

// Static order: highest baseOutput first (ties keep the lower tier index).
const descendingOutputOrder = TIERS.map((_, i) => i).sort(
  (a, b) => TIERS[b].baseOutput - TIERS[a].baseOutput,
);

const sigkill: SweepDirective = {
  id: "sigkill",
  name: "sigkill",
  unlockAt: 3,
  ignoresNice: true,
  budget: (s, total) => sweepBudget(s, total, 1, true),
  victims: (s, budget) => reapInOrder(s, priorityOrder(s), budget),
};

const scavenger: SweepDirective = {
  id: "scavenger",
  name: "scavenger",
  unlockAt: 6,
  ignoresNice: false,
  budget: (s, total) => sweepBudget(s, total, 0.6, false),
  victims: (s, budget) => reapInOrder(s, descendingOutputOrder, budget),
};

const groupKill: SweepDirective = {
  id: "group-kill",
  name: "group-kill",
  unlockAt: 10,
  ignoresNice: false,
  budget: (s, total) => sweepBudget(s, total, 1, false),
  victims: (s, budget) => {
    const densestFirst = TIERS.map((_, i) => i).sort((a, b) => s.counts[b] - s.counts[a] || a - b);
    return reapInOrder(s, densestFirst, budget);
  },
};

const backpressure: SweepDirective = {
  id: "backpressure",
  name: "backpressure",
  unlockAt: 15,
  ignoresNice: false,
  budget: (s, total) => sweepBudget(s, total, 0.5, false),
  victims: (s, budget) => reapInOrder(s, priorityOrder(s), budget),
  pre: (s) => {
    s.leak = 0;
  },
};

export const DIRECTIVES: SweepDirective[] = [standard, sigkill, scavenger, groupKill, backpressure];

export const directiveById: Map<DirectiveId, SweepDirective> = new Map(
  DIRECTIVES.map((d) => [d.id, d]),
);

/** Mulberry32-style step: advances `s.rngState` and returns a float in [0, 1). */
export function nextRng(s: GameState): number {
  s.rngState = (s.rngState + 0x6d2b79f5) | 0;
  let t = s.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Directives drawable at the current sweep count (inclusive of the threshold). */
export function unlockedDirectives(s: GameState): SweepDirective[] {
  return DIRECTIVES.filter((d) => d.unlockAt <= s.sweepsSurvived);
}

/** Draw the next directive, never repeating the just-fired one when avoidable. */
export function pickNextDirective(s: GameState): DirectiveId {
  const pool = unlockedDirectives(s);
  const choices = pool.length > 1 ? pool.filter((d) => d.id !== s.nextDirective) : pool;
  return choices[Math.floor(nextRng(s) * choices.length)].id;
}

// --- upgrade costs ---------------------------------------------------------

export function niceCost(s: GameState): Decimal {
  return d(250).mul(d(2.2).pow(s.nice));
}

/** Cost of the next SIGTERM handler charge; doubles with each charge owned. */
export function shieldCost(s: GameState): Decimal {
  return d(500).mul(d(2).pow(s.shields));
}

export const MALLOC_STEP = 16;

export function mallocCost(s: GameState): Decimal {
  return d(150).mul(d(1.6).pow((s.ramCap - BASE.ramCap) / MALLOC_STEP));
}

export function gcCost(s: GameState): Decimal {
  return d(400).mul(d(3).pow(s.gc));
}

export function coolCost(s: GameState): Decimal {
  return d(1000).mul(d(2.5).pow(s.cooling));
}

export function forkCost(s: GameState): Decimal {
  return d(1e6).mul(d(10).pow(s.forks)).mul(perkMods(s).forkCostMult);
}

/** Offline cap in seconds for the current `nohup` level, saturated at the step budget. */
export function offlineCapS(s: GameState): number {
  return Math.min(BASE_OFFLINE_CAP_S + s.offlineCap * OFFLINE_CAP_STEP, OFFLINE_MAX_STEPS);
}

export function offlineCost(s: GameState): Decimal {
  return d(1e7).mul(d(5).pow(s.offlineCap));
}

export function buyOfflineCap(s: GameState): boolean {
  // Refuse once the cap is saturated, so a purchase never silently buys nothing.
  if (offlineCapS(s) >= OFFLINE_MAX_STEPS) return false;
  const cost = offlineCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.offlineCap++;
  log(s, `nohup: offline cap ${Math.round(offlineCapS(s) / 3600)}h`);
  return true;
}

// --- actions ---------------------------------------------------------------

export function canSpawn(s: GameState, i: number): boolean {
  const ramOk = ramUsed(s) + TIERS[i].ram <= ramCapTotal(s);
  return s.cycles.gte(tierCost(s, i)) && ramOk;
}

export function spawn(s: GameState, i: number): boolean {
  if (!canSpawn(s, i)) return false;
  s.cycles = s.cycles.sub(tierCost(s, i));
  s.counts[i]++;
  return true;
}

/** Largest number of units of tier `i` buyable now, bounded by `cycles` and RAM. Pure. */
export function maxAffordable(s: GameState, i: number): number {
  const def = TIERS[i];
  if (!def) return 0;
  const room = Math.floor((ramCapTotal(s) - ramUsed(s)) / def.ram);
  if (room <= 0) return 0;
  const next = tierCost(s, i); // cost of the next unit
  const growth = def.costGrowth;
  let k = 0;
  if (s.cycles.gt(0)) {
    // solve next * (growth^k - 1) / (growth - 1) <= cycles  ->  k
    const ratio = s.cycles.mul(growth - 1).div(next).add(1);
    k = Math.floor(ratio.ln().div(Math.log(growth)).toNumber());
  }
  if (!Number.isFinite(k) || k < 0) k = 0;
  k = Math.min(k, room);
  const total = (n: number) => next.mul(d(growth).pow(n).sub(1)).div(growth - 1);
  while (k > 0 && total(k).gt(s.cycles)) k--; // absorb Decimal rounding
  while (k + 1 <= room && total(k + 1).lte(s.cycles)) k++;
  return k;
}

/** Buy the maximum affordable units of tier `i` in one action. Gated by the `buy-max` unlock. */
export function spawnMax(s: GameState, i: number): boolean {
  if (!hasUnlock(s, UNLOCK.buyMax)) return false;
  const k = maxAffordable(s, i);
  if (k <= 0) return false;
  const growth = TIERS[i].costGrowth;
  const total = tierCost(s, i).mul(d(growth).pow(k).sub(1)).div(growth - 1);
  s.cycles = s.cycles.sub(total);
  s.counts[i] += k;
  log(s, `spawn x${k}: ${TIERS[i].name}`);
  return true;
}

/** Earned automation: at most one action of each kind per tick, live ticks only. */
export function runAutomation(s: GameState): void {
  if (hasUnlock(s, UNLOCK.autoFree) && s.autoFree && s.leak >= s.freeThreshold) freeMemory(s);
  if (hasUnlock(s, UNLOCK.autoMalloc) && s.autoMalloc && s.cycles.gte(mallocCost(s))) buyMalloc(s);
  if (hasUnlock(s, UNLOCK.autoNice) && s.autoNice && s.cycles.gte(niceCost(s))) buyNice(s);
}

export function buyNice(s: GameState): boolean {
  if (!hasUnlock(s, UNLOCK.nice)) return false;
  const cost = niceCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.nice++;
  log(s, `nice(+1): sweep will reap ${Math.round((1 - sweepVictimMult(s)) * 100)}% fewer`);
  return true;
}

export function buyShield(s: GameState): boolean {
  const cost = shieldCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.shields++;
  log(s, `SIGTERM handler: +1 shield charge (${s.shields} total)`);
  return true;
}

export function buyMalloc(s: GameState): boolean {
  const cost = mallocCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.ramCap += MALLOC_STEP;
  log(s, `malloc(+${MALLOC_STEP}MB): ceiling is now ${s.ramCap}MB`);
  return true;
}

export function buyGc(s: GameState): boolean {
  if (!hasUnlock(s, UNLOCK.gc)) return false;
  const cost = gcCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.gc++;
  log(s, `gc level ${s.gc}: leak flushed automatically`);
  return true;
}

export function buyCooling(s: GameState): boolean {
  const cost = coolCost(s);
  if (s.cycles.lt(cost)) return false;
  s.cycles = s.cycles.sub(cost);
  s.cooling++;
  log(s, `cooling level ${s.cooling}: heat sheds ${(1 + s.cooling * 0.5).toFixed(1)}× faster`);
  return true;
}

export function freeMemory(s: GameState): boolean {
  if (s.leak <= 0) return false;
  const freed = s.leak;
  s.leak = 0;
  log(s, `free(): flushed ${Math.ceil(freed)}MB of leaked memory`);
  return true;
}

export function nudgeDaemon(s: GameState, index: number): boolean {
  const dm = s.legacy[index];
  if (!dm || !dm.crashed) return false;
  dm.crashed = false;
  dm.respawn = 0;
  log(s, `${dm.name} restarted by hand`);
  return true;
}

export function buyPerk(s: GameState, id: PerkId): boolean {
  if (!canBuyPerk(s, id)) return false;
  s.lineage -= perkCost(s, id);
  s.perks[id] = (s.perks[id] ?? 0) + 1;
  log(s, `lineage: bought ${perkById(id)?.name ?? id} (L${s.perks[id]})`);
  return true;
}

export function canFork(s: GameState): boolean {
  return s.totalEarned.gte(forkCost(s));
}

export function doFork(s: GameState): boolean {
  if (!canFork(s)) return false;
  const m = perkMods(s); // pre-reset: earning perks apply to the fork that earns
  s.lineage += Math.min(MAX_POINTS_PER_FORK, Math.floor(pointsForFork(s) * m.pointsMult));
  const peak = baseCyclesPerSec(s); // unthrottled + lineage-free: heat and lineage are not baked in
  const rate = Decimal.max(0.1, peak.mul(LEGACY_SHARE));
  s.forks++;
  s.legacy.push({
    name: `legacy-${s.forks}`,
    rate,
    crashed: false,
    respawn: 0,
  });
  // reset the working set, keep lineage + legacy + perks
  s.cycles = m.startCycles; // warm start grants a head start
  s.counts = TIERS.map(() => 0);
  s.leak = 0;
  s.ramCap = BASE.ramCap;
  s.heat = 0;
  s.cooling = 0;
  s.shields = m.startShieldsAdd; // signal-mask charges for the new run
  s.nice = 0;
  s.gc = 0;
  s.runBaseEarned = s.totalEarned;
  s.runStartPlaytime = s.playtime;
  s.sweepInterval = sweepIntervalFor(s);
  s.sweepTimer = s.sweepInterval;
  log(s, `fork(): new instance spawned — lineage ×${lineageMult(s).toNumber().toFixed(1)}`);
  return true;
}

// --- tick ------------------------------------------------------------------

/**
 * Options for `tick`. `offline` marks a catch-up replay (see `persistence.applyOffline`):
 * it accrues income (heat-throttled), heat, leak + `gc` drain, and legacy crashes, but
 * skips the cleanup sweep (step 6) and the memory-pressure latch + OOM killer (steps 7–8),
 * so idling never reaps the table and never OOMs.
 */
export interface TickOptions {
  offline?: boolean;
}

export function tick(s: GameState, dt: number, opts: TickOptions = {}): void {
  s.playtime += dt;

  const gain = cyclesPerSec(s).mul(dt);
  s.cycles = s.cycles.add(gain);
  s.totalEarned = s.totalEarned.add(gain);

  // heat: children generate it, cooling sheds it proportionally; throttles next tick's income
  const coolingFactor = 1 + s.cooling * 0.5;
  const rate = HEAT_DECAY_RATE * coolingFactor;
  const eq = heatEquilibrium(s);
  s.heat = eq + (s.heat - eq) * Math.exp(-rate * dt);
  s.heat = clamp(s.heat, 0, 100);

  // memory leak grows with the non-immune footprint; gc flushes it back down
  const footprint = leakFootprint(s);
  const growth = footprint * LEAK_RATE * dt;
  s.leak += growth;
  if (s.gc > 0) {
    const growthFlush = growth * s.gc * 0.9;
    // standing leak decays at `min(1, gc * 0.1)` per second; compound over dt
    const standingRate = Math.min(1, s.gc * 0.1);
    const standingFlush = s.leak * (1 - Math.pow(1 - standingRate, dt));
    s.leak = Math.max(0, s.leak - growthFlush - standingFlush);
  }

  // Offline catch-up skips the OOM killer, so bound the leak here: otherwise hours away
  // would grow it without limit and the first live tick would wipe the board.
  if (opts.offline) s.leak = Math.min(s.leak, ramCapTotal(s));

  // legacy daemons: produce, occasionally crash, maybe auto-respawn
  const mult = lineageMult(s).mul(perkMods(s).legacyRateMult);
  for (const dm of s.legacy) {
    if (dm.crashed) {
      dm.respawn -= dt;
      if (dm.respawn <= 0 && s.gc > 0) {
        dm.crashed = false;
        log(s, `${dm.name} respawned by gc`);
      }
    } else {
      const legacyGain = dm.rate.mul(dt).mul(mult);
      s.cycles = s.cycles.add(legacyGain);
      s.totalEarned = s.totalEarned.add(legacyGain);
      if (Math.random() < 1 - Math.exp(-LEGACY_CRASH_CHANCE * dt)) {
        dm.crashed = true;
        dm.respawn = 10;
        log(s, `${dm.name} segfaulted (PID ${randPid()})`);
      }
    }
  }

  // Offline catch-up skips the sweep and the OOM machinery: idling must not punish.
  if (opts.offline) return;

  // earned automation — live only, at most one action of each kind per tick
  runAutomation(s);

  // cleanup sweep — cadence escalates with progress; the countdown previews it
  s.sweepInterval = sweepIntervalFor(s);
  s.sweepTimer -= dt;
  if (s.sweepTimer <= 0) {
    runSweep(s);
    s.sweepTimer = s.sweepInterval;
  }

  // memory pressure warning, then out of memory
  const used = ramUsed(s);
  const cap = ramCapTotal(s);
  if (!s.ramWarned && used > cap * 0.9) {
    s.ramWarned = true;
    log(s, `memory pressure: ${Math.ceil(used)}/${cap}MB — OOM killer imminent`);
  } else if (s.ramWarned && used < cap * 0.8) {
    s.ramWarned = false;
  }
  if (used > cap * OOM_TOLERANCE) runOom(s);

  // milestones: evaluate once per live tick (after the offline early-return), fire-once
  for (const id of evaluateMilestones(s)) {
    const def = milestoneById(id);
    if (def && def.unlocks.length > 0) log(s, `milestone: ${def.name} — unlocked`);
  }
}

/**
 * Pure estimate of how many children the next sweep will reap. Mirrors `runSweep`
 * without mutating state: resolve the incoming directive (fallback `standard`),
 * compute its budget, absorb SIGTERM shield charges, and count the victims it would
 * select. `pre` is deliberately not called — it has side effects (backpressure
 * reclaims the leak).
 */
export function estimateVictims(s: GameState): number {
  const total = s.counts.reduce((a, b) => a + b, 0);
  const d = directiveById.get(s.nextDirective) ?? directiveById.get("standard")!;
  const budget = d.budget(s, total);
  const absorbed = Math.min(s.shields, budget);
  return d.victims(s, budget - absorbed).length;
}

function runSweep(s: GameState): void {
  const total = s.counts.reduce((a, b) => a + b, 0);
  const d = directiveById.get(s.nextDirective) ?? directiveById.get("standard")!;
  d.pre?.(s);
  if (total === 0) {
    log(s, "cleanup sweep: nothing to reap");
  } else {
    let budget = d.budget(s, total);
    // SIGTERM handler charges absorb victims before any are selected.
    const absorbed = Math.min(s.shields, budget);
    s.shields -= absorbed;
    budget -= absorbed;
    const victims = d.victims(s, budget);
    for (const i of victims) s.counts[i]--;
    log(
      s,
      `cleanup sweep [${d.name}]: reaped ${victims.length} process${victims.length === 1 ? "" : "es"}` +
        (absorbed > 0 ? ` (${absorbed} absorbed)` : ""),
    );
  }
  s.sweepsSurvived++;
  s.nextDirective = pickNextDirective(s);
}

function runOom(s: GameState): void {
  // kill the most valuable children first — the OOM killer does not care
  const order = TIERS.map((_, i) => i).sort((a, b) => TIERS[b].baseOutput - TIERS[a].baseOutput);
  let killed = 0;
  // Drain in bulk: remove as many of the current tier as needed to fit under the cap.
  // A per-iteration `counts[i]--` loop would stall for a huge (but finite) count.
  for (const i of order) {
    if (ramUsed(s) <= ramCapTotal(s)) break;
    const need = Math.ceil((ramUsed(s) - ramCapTotal(s)) / TIERS[i].ram);
    const take = Math.min(s.counts[i], need);
    if (take <= 0) continue;
    s.counts[i] -= take;
    killed += take;
  }
  // if the leak alone is over the ceiling, reclaim it
  if (ramUsed(s) > ramCapTotal(s)) {
    s.leak = Math.max(0, ramCapTotal(s) - childRam(s));
  }
  s.cycles = s.cycles.mul(0.9);
  s.oomCount++;
  log(
    s,
    `OOM killer: out of memory — killed ${killed} process${killed === 1 ? "" : "es"}, cycles -10%`,
  );
}

function randPid(): number {
  return 100 + Math.floor(Math.random() * 32000);
}

export function log(s: GameState, msg: string): void {
  s.log.unshift(msg);
  if (s.log.length > LOG_LIMIT) s.log.length = LOG_LIMIT;
}
