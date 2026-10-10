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
  baseOutput: number;
  ram: number;
  /** Sweep order: lower priority gets reaped first. */
  priority: number;
}

export const TIERS: TierDef[] = [
  {
    name: "noop loop",
    desc: "a flat while(true){} — cheap, dumb, keeps ticking",
    baseCost: 10,
    baseOutput: 0.1,
    ram: 1,
    priority: 0,
  },
  {
    name: "fork()",
    desc: "a real worker child",
    baseCost: 100,
    baseOutput: 1,
    ram: 2,
    priority: 1,
  },
  {
    name: "worker thread",
    desc: "threads are cheaper than processes",
    baseCost: 1_000,
    baseOutput: 8,
    ram: 4,
    priority: 2,
  },
  {
    name: "microservice",
    desc: "it has its own Dockerfile, of course",
    baseCost: 10_000,
    baseOutput: 60,
    ram: 8,
    priority: 3,
  },
  {
    name: "cron daemon",
    desc: "fires every night; nobody knows what it does",
    baseCost: 100_000,
    baseOutput: 400,
    ram: 16,
    priority: 4,
  },
];

export const COST_GROWTH = 1.15;
const LEAK_RATE = 0.01; // fraction of footprint leaked per second
const LEGACY_CRASH_CHANCE = 0.002; // per second, per daemon
const LEGACY_SHARE = 0.1; // legacy daemon produces 10% of peak cps

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
  ramCap: number;
  leak: number;
  nice: number;
  gc: number;
  forks: number;
  sweepTimer: number;
  sweepInterval: number;
  sweepsSurvived: number;
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
    ramCap: BASE.ramCap,
    leak: 0,
    nice: 0,
    gc: 0,
    forks: 0,
    sweepTimer: BASE.sweepInterval,
    sweepInterval: BASE.sweepInterval,
    sweepsSurvived: 0,
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

export function tierCost(s: GameState, i: number): Decimal {
  return d(TIERS[i].baseCost).mul(d(COST_GROWTH).pow(s.counts[i]));
}

export function childOutput(s: GameState): Decimal {
  let sum = d(0);
  for (let i = 0; i < TIERS.length; i++) {
    sum = sum.add(d(TIERS[i].baseOutput).mul(s.counts[i]));
  }
  return sum;
}

export function cyclesPerSec(s: GameState): Decimal {
  return childOutput(s).add(BASE.rootOutput).mul(lineageMult(s));
}

export function sweepVictimMult(s: GameState): number {
  return Math.max(0.3, 1 - s.nice * 0.03);
}

// --- upgrade costs ---------------------------------------------------------

export function niceCost(s: GameState): Decimal {
  return d(250).mul(d(2.5).pow(s.nice));
}

export function mallocCost(s: GameState): Decimal {
  return d(150).mul(d(1.9).pow((s.ramCap - BASE.ramCap) / 8));
}

export function gcCost(s: GameState): Decimal {
  return d(400).mul(d(3).pow(s.gc));
}

export function forkCost(s: GameState): Decimal {
  return d(1e6).mul(d(10).pow(s.forks));
}

export const MALLOC_STEP = 8;

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
  const peak = cyclesPerSec(s);
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

  // memory leak grows with footprint; gc flushes it back down
  const footprint = childRam(s);
  const growth = footprint * LEAK_RATE * dt;
  s.leak += growth;
  if (s.gc > 0) {
    s.leak = Math.max(0, s.leak - growth * s.gc * 0.9);
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
  if (used > s.ramCap) runOom(s);
}

function runSweep(s: GameState): void {
  const total = s.counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    log(s, "cleanup sweep: nothing to reap");
    s.sweepsSurvived++;
    return;
  }
  const severity = Math.min(0.35, 0.15 + s.sweepsSurvived * 0.002);
  let budget = Math.max(1, Math.round(total * severity * sweepVictimMult(s)));

  // reap lowest priority first
  const order = TIERS.map((_, i) => i).sort((a, b) => TIERS[a].priority - TIERS[b].priority);
  let killed = 0;
  for (const i of order) {
    while (budget > 0 && s.counts[i] > 0) {
      s.counts[i]--;
      budget--;
      killed++;
    }
    if (budget <= 0) break;
  }
  s.sweepsSurvived++;
  log(s, `cleanup sweep: reaped ${killed} process${killed === 1 ? "" : "es"}`);
}

function runOom(s: GameState): void {
  // kill the most valuable children first — the OOM killer does not care
  const order = TIERS.map((_, i) => i).sort((a, b) => TIERS[b].baseOutput - TIERS[a].baseOutput);
  let killed = 0;
  while (ramUsed(s) > s.ramCap) {
    const i = order.find((idx) => s.counts[idx] > 0);
    if (i === undefined) break;
    s.counts[i]--;
    killed++;
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
