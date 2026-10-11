// Core simulation for `daemon` — pure state + functions, no DOM.
// Keep this deterministic and DOM-free so it stays testable.
//
// Unbounded values (cycles, costs, output, legacy rates) are Decimals from
// ./bignum. Bounded values (counts, RAM, timers) stay plain numbers.

import { d, Decimal } from "./bignum";

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
    baseOutput: 8,
    ram: 4,
    priority: 2,
    trait: "none",
  },
  {
    name: "microservice",
    desc: "it has its own Dockerfile, of course",
    baseCost: 10_000,
    costGrowth: 1.18,
    baseOutput: 60,
    ram: 8,
    priority: 3,
    trait: "none",
  },
  {
    name: "cron daemon",
    desc: "fires every night; nobody knows what it does",
    baseCost: 100_000,
    costGrowth: 1.22,
    baseOutput: 400,
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
export const HEAT_DECAY = 1.0; // heat shed per second, before cooling
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
  /** Cooling upgrade level; each level sheds heat 50% faster. */
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
  log: string[];
  playtime: number;
  lastSave: number;
}

export const BASE = {
  ramCap: 8,
  sweepInterval: 60,
  /** Baseline cycles/s from the root process itself, before any children. */
  rootOutput: 1,
};

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
    log: ["boot: daemon pid 1 started (unattended)"],
    playtime: 0,
    lastSave: Date.now(),
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
  return d(TIERS[i].baseCost).mul(d(TIERS[i].costGrowth).pow(s.counts[i]));
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
 * Income multiplier from heat: `1` up to HEAT_THROTTLE_AT, then falls linearly to
 * `1 - MAX_THROTTLE` at heat 100.
 */
export function heatMult(s: GameState): number {
  const over = (s.heat - HEAT_THROTTLE_AT) / (100 - HEAT_THROTTLE_AT);
  return 1 - MAX_THROTTLE * clamp(over, 0, 1);
}

/**
 * Income from children plus the root baseline, before lineage and heat. Lineage-free
 * on purpose: legacy daemon rates snapshot this, then `tick` applies `lineageMult`
 * once — baking lineage into the snapshot would double-count it.
 */
export function baseCyclesPerSec(s: GameState): Decimal {
  return childOutput(s).add(BASE.rootOutput);
}

/**
 * Income before the heat throttle. Also the basis for forked legacy daemon rates,
 * which must not bake in the heat throttle.
 */
export function rawCyclesPerSec(s: GameState): Decimal {
  return baseCyclesPerSec(s).mul(lineageMult(s));
}

export function cyclesPerSec(s: GameState): Decimal {
  return rawCyclesPerSec(s).mul(heatMult(s));
}

export function sweepVictimMult(s: GameState): number {
  return Math.max(0.3, 1 - s.nice * 0.03);
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
  flavor: string; // short description
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
  flavor: "reap in your sacrifice order",
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
  flavor: "SIGKILL — nice cannot save you",
  unlockAt: 3,
  ignoresNice: true,
  budget: (s, total) => sweepBudget(s, total, 1, true),
  victims: (s, budget) => reapInOrder(s, priorityOrder(s), budget),
};

const scavenger: SweepDirective = {
  id: "scavenger",
  name: "scavenger",
  flavor: "reap the highest-output children first",
  unlockAt: 6,
  ignoresNice: false,
  budget: (s, total) => sweepBudget(s, total, 0.6, false),
  victims: (s, budget) => reapInOrder(s, descendingOutputOrder, budget),
};

const groupKill: SweepDirective = {
  id: "group-kill",
  name: "group-kill",
  flavor: "reap the densest tier first",
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
  flavor: "reclaim the leak, then reap half the usual budget",
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

export const MALLOC_STEP = 8;

export function mallocCost(s: GameState): Decimal {
  return d(150).mul(d(1.85).pow((s.ramCap - BASE.ramCap) / MALLOC_STEP));
}

export function gcCost(s: GameState): Decimal {
  return d(400).mul(d(3).pow(s.gc));
}

export function coolCost(s: GameState): Decimal {
  return d(1000).mul(d(2.5).pow(s.cooling));
}

export function forkCost(s: GameState): Decimal {
  return d(1e6).mul(d(10).pow(s.forks));
}

// --- actions ---------------------------------------------------------------

export function canSpawn(s: GameState, i: number): boolean {
  const ramOk = ramUsed(s) + TIERS[i].ram <= s.ramCap;
  return s.cycles.gte(tierCost(s, i)) && ramOk;
}

export function spawn(s: GameState, i: number): boolean {
  if (!canSpawn(s, i)) return false;
  s.cycles = s.cycles.sub(tierCost(s, i));
  s.counts[i]++;
  return true;
}

export function buyNice(s: GameState): boolean {
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

export function canFork(s: GameState): boolean {
  return s.totalEarned.gte(forkCost(s));
}

export function doFork(s: GameState): boolean {
  if (!canFork(s)) return false;
  const peak = baseCyclesPerSec(s); // unthrottled + lineage-free: heat and lineage are not baked in
  const rate = Decimal.max(0.1, peak.mul(LEGACY_SHARE));
  s.forks++;
  s.legacy.push({
    name: `legacy-${s.forks}`,
    rate,
    crashed: false,
    respawn: 0,
  });
  // reset the working set, keep lineage + legacy
  s.cycles = d(0);
  s.counts = TIERS.map(() => 0);
  s.leak = 0;
  s.ramCap = BASE.ramCap;
  s.heat = 0;
  s.cooling = 0;
  s.shields = 0;
  s.nice = 0;
  s.gc = 0;
  s.sweepTimer = BASE.sweepInterval;
  log(s, `fork(): new instance spawned — lineage ×${lineageMult(s).toNumber().toFixed(1)}`);
  return true;
}

// --- tick ------------------------------------------------------------------

export function tick(s: GameState, dt: number): void {
  s.playtime += dt;

  const gain = cyclesPerSec(s).mul(dt);
  s.cycles = s.cycles.add(gain);
  s.totalEarned = s.totalEarned.add(gain);

  // heat: children generate it, cooling sheds it; throttles next tick's income
  s.heat += childRam(s) * HEAT_PER_RAM * dt;
  s.heat -= HEAT_DECAY * (1 + s.cooling * 0.5) * dt;
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

  // legacy daemons: produce, occasionally crash, maybe auto-respawn
  const mult = lineageMult(s);
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

  // cleanup sweep
  s.sweepTimer -= dt;
  if (s.sweepTimer <= 0) {
    runSweep(s);
    s.sweepTimer = s.sweepInterval;
  }

  // memory pressure warning, then out of memory
  const used = ramUsed(s);
  if (!s.ramWarned && used > s.ramCap * 0.9) {
    s.ramWarned = true;
    log(s, `memory pressure: ${Math.ceil(used)}/${s.ramCap}MB — OOM killer imminent`);
  } else if (s.ramWarned && used < s.ramCap * 0.8) {
    s.ramWarned = false;
  }
  if (used > s.ramCap * OOM_TOLERANCE) runOom(s);
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
    if (ramUsed(s) <= s.ramCap) break;
    const need = Math.ceil((ramUsed(s) - s.ramCap) / TIERS[i].ram);
    const take = Math.min(s.counts[i], need);
    if (take <= 0) continue;
    s.counts[i] -= take;
    killed += take;
  }
  // if the leak alone is over the ceiling, reclaim it
  if (ramUsed(s) > s.ramCap) {
    s.leak = Math.max(0, s.ramCap - childRam(s));
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
