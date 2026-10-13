import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { fmt } from "./format";
import type { GameState } from "./sim";
import {
  BASE,
  BASE_OFFLINE_CAP_S,
  OFFLINE_CAP_STEP,
  OFFLINE_MAX_STEPS,
  DEFAULT_SACRIFICE_ORDER,
  HEAT_THROTTLE_AT,
  MALLOC_STEP,
  MAX_THROTTLE,
  SURVIVAL_BONUS,
  TIERS,
  baseCyclesPerSec,
  buyCooling,
  buyGc,
  buyMalloc,
  buyNice,
  buyPerk,
  buyRepeatable,
  buyShield,
  canSpawn,
  childOutput,
  childRam,
  coolCost,
  cyclesPerSec,
  directiveById,
  doFork,
  estimateVictims,
  forkCost,
  freeMemory,
  gcCost,
  heatEquilibrium,
  heatMult,
  lineageMult,
  mallocCost,
  maxAffordable,
  movePriority,
  newGame,
  niceCost,
  nudgeDaemon,
  offlineCapS,
  offlineCost,
  buyOfflineCap,
  pickNextDirective,
  priorityOf,
  priorityOrder,
  ramCapTotal,
  ramUsed,
  rawCyclesPerSec,
  sanitizeSacrificeOrder,
  shieldCost,
  spawn,
  spawnMax,
  survivalMult,
  sweepIntervalFor,
  sweepVictimMult,
  synergyMult,
  tick,
  tierCost,
  tierUnlocked,
  unlockedDirectives,
} from "./sim";
import { UNLOCK } from "./milestones";
import { achievementById } from "./achievements";

// --- bootstrap -------------------------------------------------------------

describe("bootstrap", () => {
  it("earns 1 cycle/s from the root process with no children", () => {
    const s = newGame();
    expect(cyclesPerSec(s).toNumber()).toBe(1);
    tick(s, 10);
    expect(s.cycles.toNumber()).toBeCloseTo(10, 5);
  });

  it("can afford the first child after ~10s from a fresh save", () => {
    const s = newGame();
    expect(canSpawn(s, 0)).toBe(false);
    tick(s, 10);
    expect(canSpawn(s, 0)).toBe(true);
  });
});

// --- economy ---------------------------------------------------------------

describe("cost curve", () => {
  it("grows a tier cost by that tier's own costGrowth per purchase", () => {
    for (let i = 0; i < TIERS.length; i++) {
      const s = newGame();
      s.cycles = d(1e12);
      s.ramCap = 10_000;
      s.unlocks[UNLOCK.tier5] = true; // the two new tiers are unlock-gated
      s.unlocks[UNLOCK.tier6] = true;
      const first = tierCost(s, i);
      expect(spawn(s, i)).toBe(true);
      expect(tierCost(s, i).div(first).toNumber()).toBeCloseTo(TIERS[i].costGrowth, 5);
    }
  });

  it("gives tiers distinct curves (1.12 for noop loop, 1.22 for cron daemon)", () => {
    expect(TIERS[0].costGrowth).toBe(1.12);
    expect(TIERS[4].costGrowth).toBe(1.22);

    const cheap = newGame();
    cheap.cycles = d(1e12);
    cheap.ramCap = 10_000;
    const cheapFirst = tierCost(cheap, 0);
    spawn(cheap, 0);
    expect(tierCost(cheap, 0).div(cheapFirst).toNumber()).toBeCloseTo(1.12, 5);

    const pricy = newGame();
    pricy.cycles = d(1e12);
    pricy.ramCap = 10_000;
    const pricyFirst = tierCost(pricy, 4);
    spawn(pricy, 4);
    expect(tierCost(pricy, 4).div(pricyFirst).toNumber()).toBeCloseTo(1.22, 5);
  });
});

describe("upgrade cost curves", () => {
  it("niceCost is 250 * 2.2^n and strictly increasing", () => {
    const s = newGame();
    const costs = [0, 1, 2].map((n) => {
      s.nice = n;
      return niceCost(s).toNumber();
    });
    expect(costs[0]).toBeCloseTo(250, 5);
    expect(costs[1]).toBeCloseTo(550, 5);
    expect(costs[2]).toBeCloseTo(1210, 5);
    expect(costs[1]).toBeGreaterThan(costs[0]);
    expect(costs[2]).toBeGreaterThan(costs[1]);
  });

  it("mallocCost is 150 * 1.6^step and strictly increasing", () => {
    const s = newGame();
    const costs = [0, 1, 2].map((step) => {
      s.ramCap = BASE.ramCap + step * MALLOC_STEP;
      return mallocCost(s).toNumber();
    });
    expect(costs[0]).toBeCloseTo(150, 5);
    expect(costs[1]).toBeCloseTo(240, 5);
    expect(costs[2]).toBeCloseTo(384, 5);
    expect(costs[1]).toBeGreaterThan(costs[0]);
    expect(costs[2]).toBeGreaterThan(costs[1]);
  });
});

describe("tier identity", () => {
  it("gives every tier an explicit costGrowth and trait", () => {
    expect(TIERS.map((t) => t.costGrowth)).toEqual([1.12, 1.15, 1.15, 1.18, 1.22, 1.25, 1.3]);
    expect(TIERS.map((t) => t.trait)).toEqual([
      "leak-immune",
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);
  });

  it("does not worsen payback with tier (flat-to-improving)", () => {
    // cost / output per tier: 100 / 100 / 83.3 / 66.7 / 50 — cheap spam no longer wins.
    // Tiers 5–6 are milestone-gated goals, not spam: they trade payback for raw output,
    // so the flat-to-improving claim is scoped to the ungated curve (0–4).
    const ungated = TIERS.slice(0, 5);
    for (const tier of ungated) {
      expect(tier.baseCost / tier.baseOutput).toBeLessThanOrEqual(100);
    }
    const payback = ungated.map((t) => t.baseCost / t.baseOutput);
    for (let i = 1; i < payback.length; i++) expect(payback[i]).toBeLessThanOrEqual(payback[i - 1]);
  });
});

// --- survival multiplier ---------------------------------------------------

describe("survival multiplier", () => {
  it("compounds per sweep survived", () => {
    const s = newGame();
    s.sweepsSurvived = 0;
    expect(survivalMult(s).toNumber()).toBe(1);
    s.sweepsSurvived = 1;
    expect(survivalMult(s).toNumber()).toBeCloseTo(1.05, 10);
    s.sweepsSurvived = 10;
    expect(survivalMult(s).toNumber()).toBeCloseTo(1.05 ** 10, 8);
  });

  it("stays finite far past the double ceiling (Decimal, not a number)", () => {
    const s = newGame();
    s.sweepsSurvived = 100_000; // 1.05^100000 would overflow a JS double
    expect(survivalMult(s).isFinite()).toBe(true);
    expect(survivalMult(s).gt(d(Number.MAX_VALUE))).toBe(true);
  });

  it("multiplies child output but leaves root unmultiplied", () => {
    const empty = newGame();
    empty.sweepsSurvived = 100;
    expect(baseCyclesPerSec(empty).toNumber()).toBe(1); // root is outside the multiplier

    const one = newGame();
    one.sweepsSurvived = 100;
    one.counts = [0, 1, 0, 0, 0, 0, 0]; // one fork(): childOutput = 1
    expect(baseCyclesPerSec(one).toNumber()).toBeCloseTo(1.05 ** 100 + 1, 4);
  });

  it("does not change the bootstrap (survivalMult = 1 at 0 sweeps)", () => {
    const s = newGame();
    expect(survivalMult(s).toNumber()).toBe(1);
    expect(SURVIVAL_BONUS).toBe(0.05);
  });
});

describe("spawn gating", () => {
  it("refuses a spawn that would exceed the RAM cap", () => {
    const s = newGame();
    s.cycles = d(1e9);
    s.ramCap = TIERS[0].ram; // room for exactly one
    expect(spawn(s, 0)).toBe(true);
    expect(ramUsed(s)).toBe(TIERS[0].ram);
    expect(canSpawn(s, 0)).toBe(false);
    expect(spawn(s, 0)).toBe(false);
  });

  it("refuses a spawn without enough cycles", () => {
    const s = newGame();
    expect(spawn(s, 1)).toBe(false);
    expect(s.counts[1]).toBe(0);
  });
});

// --- tier unlocks ----------------------------------------------------------

describe("tier unlocks", () => {
  it("appends two unlock-gated tiers and leaves 0-4 ungated", () => {
    expect(TIERS.length).toBe(7);
    expect(TIERS[5]).toMatchObject({ name: "k8s pod", unlock: UNLOCK.tier5 });
    expect(TIERS[6]).toMatchObject({ name: "bare-metal node", unlock: UNLOCK.tier6 });
    for (let i = 0; i < 5; i++) expect(TIERS[i].unlock).toBeUndefined();
  });

  it("starts with one zero count per tier", () => {
    expect(newGame().counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses spawn and buy-max for a locked tier even when affordable", () => {
    const s = newGame();
    s.cycles = d(1e12);
    s.ramCap = 1000;
    s.unlocks[UNLOCK.buyMax] = true; // isolate the tier gate from the buy-max gate
    expect(tierUnlocked(s, 5)).toBe(false);
    expect(canSpawn(s, 5)).toBe(false);
    expect(maxAffordable(s, 5)).toBe(0);
    expect(spawn(s, 5)).toBe(false);
    expect(spawnMax(s, 5)).toBe(false);
    expect(s.counts[5]).toBe(0);
  });

  it("allows spawn once the unlock is granted", () => {
    const s = newGame();
    s.cycles = d(1e12);
    s.ramCap = 1000;
    s.unlocks[UNLOCK.tier5] = true;
    expect(tierUnlocked(s, 5)).toBe(true);
    expect(canSpawn(s, 5)).toBe(true);
    expect(spawn(s, 5)).toBe(true);
    expect(s.counts[5]).toBe(1);
  });

  it("links the new tiers into SYNERGY (higher boosts lower)", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 0, 0, 10]; // 10 bare-metal nodes
    expect(synergyMult(s, 5)).toBeCloseTo(1 + 0.05 * 10, 10);
    s.counts = [0, 0, 0, 0, 0, 10, 0]; // 10 k8s pods
    expect(synergyMult(s, 4)).toBeCloseTo(1 + 0.03 * 10, 10);
  });
});

// --- cross-tier synergy ----------------------------------------------------

describe("cross-tier synergy", () => {
  // tier indices: 2 = worker thread, 3 = microservice, 4 = cron daemon
  it("boosts workers 2% per microservice (10 workers + 5 microservices = 1.10x)", () => {
    const alone = newGame();
    alone.counts = [0, 0, 10, 0, 0, 0, 0];
    const mixed = newGame();
    mixed.counts = [0, 0, 10, 5, 0, 0, 0];

    expect(synergyMult(mixed, 2)).toBeCloseTo(1 + 0.02 * 5, 10);

    const aloneWorkers = d(TIERS[2].baseOutput).mul(alone.counts[2]);
    const mixedWorkers = d(TIERS[2].baseOutput).mul(mixed.counts[2]).mul(synergyMult(mixed, 2));
    expect(mixedWorkers.div(aloneWorkers).toNumber()).toBeCloseTo(1.1, 10);

    // the mixed board also earns its (unboosted) microservice output
    const microComponent = d(TIERS[3].baseOutput).mul(mixed.counts[3]);
    expect(childOutput(mixed).toNumber()).toBeCloseTo(
      mixedWorkers.add(microComponent).toNumber(),
      6,
    );
  });

  it("boosts microservices 5% per cron daemon", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 10, 4, 0, 0]; // 10 microservices, 4 cron daemons
    expect(synergyMult(s, 3)).toBeCloseTo(1 + 0.05 * 4, 10);

    const microComponent = d(TIERS[3].baseOutput).mul(10).mul(synergyMult(s, 3));
    const cronComponent = d(TIERS[4].baseOutput).mul(4);
    expect(childOutput(s).toNumber()).toBeCloseTo(microComponent.add(cronComponent).toNumber(), 6);
  });

  it("leaves tiers without a booster at 1x regardless of unrelated counts", () => {
    const s = newGame();
    s.counts = [5, 5, 5, 5, 5, 0, 0]; // every tier populated
    expect(synergyMult(s, 0)).toBe(1); // noop loop: no booster
    expect(synergyMult(s, 1)).toBe(1); // fork(): no booster
    expect(synergyMult(s, 4)).toBe(1); // cron daemon: no booster (top of the chain)
    // microservices boost workers, not other microservices or forks
    expect(synergyMult(s, 2)).toBeCloseTo(1 + 0.02 * s.counts[3], 10);
  });

  it("leaves the bootstrap unchanged (empty board)", () => {
    const s = newGame();
    expect(childOutput(s).toNumber()).toBe(0);
    expect(s.heat).toBe(0);
    expect(cyclesPerSec(s).toNumber()).toBe(1);
  });
});

// --- sweep -----------------------------------------------------------------

describe("cleanup sweep", () => {
  it("reaps the lowest-priority children first", () => {
    const s = newGame();
    s.ramCap = 1000; // roomy: isolate sweep behavior from the OOM killer
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(1);
    expect(s.counts[0]).toBeLessThan(10); // tier 0 (priority 0) is hit first
    expect(s.counts[1]).toBe(10); // tier 1 untouched while tier 0 remains
  });

  it("reduces victims as `nice` rises", () => {
    const base = newGame();
    base.ramCap = 1000;
    base.counts = [100, 0, 0, 0, 0, 0, 0];
    base.sweepTimer = 0.001;
    tick(base, 0.01);
    const withoutNice = 100 - base.counts[0];

    const nice = newGame();
    nice.ramCap = 1000;
    nice.counts = [100, 0, 0, 0, 0, 0, 0];
    nice.nice = 5;
    nice.sweepTimer = 0.001;
    tick(nice, 0.01);
    const withNice = 100 - nice.counts[0];

    expect(withNice).toBeLessThan(withoutNice);
  });
});

describe("sweep cadence", () => {
  it("sweepIntervalFor shrinks from 60 to the 10s floor", () => {
    const s = newGame();
    s.sweepsSurvived = 0;
    expect(sweepIntervalFor(s)).toBe(60);
    s.sweepsSurvived = 30;
    expect(sweepIntervalFor(s)).toBeCloseTo(35, 5);
    s.sweepsSurvived = 60;
    expect(sweepIntervalFor(s)).toBeCloseTo(10, 5);
    s.sweepsSurvived = 600; // past the escalation horizon: clamped at the floor
    expect(sweepIntervalFor(s)).toBeCloseTo(10, 5);
  });

  it("nice softens the escalation", () => {
    const s = newGame();
    s.sweepsSurvived = 60;
    s.nice = 0;
    expect(sweepIntervalFor(s)).toBeCloseTo(10, 5);
    s.nice = 20; // sweepVictimMult 0.4 -> 40s
    expect(sweepIntervalFor(s)).toBeCloseTo(40, 5);
    s.nice = 24; // sweepVictimMult at its 0.3 floor -> 45s
    expect(sweepIntervalFor(s)).toBeCloseTo(45, 5);
  });

  it("the next sweep uses the escalated cadence", () => {
    const s = newGame();
    s.sweepsSurvived = 60;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(61);
    expect(s.sweepTimer).toBeCloseTo(10, 5);
    expect(s.sweepInterval).toBeCloseTo(10, 5);
  });

  it("is deterministic and drives the countdown field", () => {
    const a = newGame();
    const b = newGame();
    a.sweepsSurvived = 12;
    b.sweepsSurvived = 12;
    expect(sweepIntervalFor(a)).toBe(sweepIntervalFor(b));

    a.sweepTimer = 1e9; // freeze the sweep so sweepsSurvived is stable
    tick(a, 1);
    expect(a.sweepInterval).toBe(sweepIntervalFor(a));
  });
});

describe("sweep directive model", () => {
  it("standard reaps the lowest-priority tier first", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it("standard budget matches the severity formula", () => {
    const s = newGame(); // sweepsSurvived 0 -> severity 0.15, nice 0 -> mult 1
    s.counts = [100, 0, 0, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.budget(s, 100)).toBe(15);
  });

  it("never returns more victims than are owned", () => {
    const s = newGame();
    s.counts = [2, 0, 0, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 50)).toEqual([0, 0]);
  });
});

describe("sweep directives", () => {
  it("sigkill ignores nice entirely", () => {
    const noNice = newGame();
    noNice.counts = [100, 0, 0, 0, 0, 0, 0];
    const nice = newGame();
    nice.counts = [100, 0, 0, 0, 0, 0, 0];
    nice.nice = 20; // well past the floor
    const d = directiveById.get("sigkill")!;
    expect(d.budget(noNice, 100)).toBe(15);
    expect(d.budget(nice, 100)).toBe(d.budget(noNice, 100)); // nice does not reduce it
  });

  it("scavenger reaps the highest-output tier first", () => {
    const s = newGame();
    s.counts = [10, 10, 10, 10, 10, 0, 0];
    const d = directiveById.get("scavenger")!;
    expect(d.victims(s, 3)).toEqual([4, 4, 4]); // tier 4 has the highest baseOutput
  });

  it("group-kill reaps the densest tier first", () => {
    const s = newGame();
    s.counts = [0, 9, 2, 0, 0, 0, 0]; // tier 1 is densest
    const d = directiveById.get("group-kill")!;
    expect(d.victims(s, 11)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  });

  it("backpressure reclaims the leak and reaps half the usual budget", () => {
    const s = newGame();
    s.counts = [100, 0, 0, 0, 0, 0, 0];
    s.leak = 50;
    const d = directiveById.get("backpressure")!;
    d.pre?.(s);
    expect(s.leak).toBe(0);
    expect(d.budget(s, 100)).toBe(8); // round(100 * 0.15 * 0.5) = 8
  });

  it("backpressure zeroes the leak even with no children to reap", () => {
    const s = newGame();
    s.sweepsSurvived = 15; // backpressure unlocked
    s.nextDirective = "backpressure";
    s.leak = 50;
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(16); // empty-table sweep still counts
    expect(s.leak).toBe(0); // `pre` runs before the empty-table branch
  });
});

// --- SIGTERM handler shields -----------------------------------------------

describe("SIGTERM handler shields", () => {
  it("buyShield spends cycles and adds a charge", () => {
    const s = newGame();
    expect(s.shields).toBe(0);
    const cost = shieldCost(s);
    s.cycles = cost.add(d(10));
    expect(buyShield(s)).toBe(true);
    expect(s.shields).toBe(1);
    expect(s.cycles.eq(d(10))).toBe(true);
    expect(s.log[0]).toMatch(/shield/i);
  });

  it("refuses to buy a shield without enough cycles", () => {
    const s = newGame();
    s.cycles = shieldCost(s).sub(1);
    expect(buyShield(s)).toBe(false);
    expect(s.shields).toBe(0);
  });

  it("absorbs one sweep victim per charge", () => {
    const bare = newGame();
    bare.ramCap = 1000;
    bare.counts = [0, 20, 0, 0, 0, 0, 0];
    bare.sweepTimer = 0.001;
    tick(bare, 0.01);

    const shielded = newGame();
    shielded.ramCap = 1000;
    shielded.counts = [0, 20, 0, 0, 0, 0, 0];
    shielded.shields = 2;
    shielded.sweepTimer = 0.001;
    tick(shielded, 0.01);

    expect(20 - bare.counts[1]).toBe(3); // standard budget at severity 0.15
    expect(20 - shielded.counts[1]).toBe(1); // exactly two victims absorbed
  });

  it("consumes charges, floors at zero, and reaps nothing when it covers the budget", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 20, 0, 0, 0, 0, 0];
    s.shields = 5; // budget is 3, so the surplus must survive
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.counts[1]).toBe(20); // nothing reaped
    expect(s.shields).toBe(2); // only the budget was consumed, never negative
  });
});

// --- victim estimate -------------------------------------------------------

describe("estimateVictims", () => {
  it("matches the count the standard sweep actually reaps", () => {
    const s = newGame();
    s.ramCap = 1000; // isolate from the OOM killer
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    const est = estimateVictims(s);
    const before = s.counts.reduce((a, b) => a + b, 0);
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    const reaped = before - s.counts.reduce((a, b) => a + b, 0);
    expect(est).toBe(reaped);
    expect(est).toBe(3); // round(20 * 0.15) at sweepsSurvived 0
  });

  it("follows the incoming non-standard directive (scavenger)", () => {
    const s = newGame();
    s.sweepsSurvived = 6; // scavenger unlocked
    s.nextDirective = "scavenger";
    s.ramCap = 1000;
    s.counts = [3, 3, 3, 3, 3, 0, 0];
    const est = estimateVictims(s);
    const before = s.counts.reduce((a, b) => a + b, 0);
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    const reaped = before - s.counts.reduce((a, b) => a + b, 0);
    expect(est).toBe(reaped);
    expect(est).toBe(1); // round(15 * 0.162 * 0.6)
    expect(s.counts[4]).toBe(2); // the highest-output tier was hit
  });

  it("subtracts shields from the estimate and never goes below zero", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 20, 0, 0, 0, 0, 0]; // standard budget = round(20 * 0.15) = 3
    s.shields = 2;
    expect(estimateVictims(s)).toBe(1);

    s.shields = 100; // more charges than the budget
    expect(estimateVictims(s)).toBe(0);
    expect(estimateVictims(s)).toBeGreaterThanOrEqual(0);
  });

  it("does not mutate state", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 20, 0, 0, 0, 0, 0];
    s.shields = 3;
    s.leak = 12;
    s.heat = 40;
    const before = {
      counts: [...s.counts],
      shields: s.shields,
      leak: s.leak,
      heat: s.heat,
      sweepsSurvived: s.sweepsSurvived,
      nextDirective: s.nextDirective,
    };
    estimateVictims(s);
    expect(s.counts).toEqual(before.counts);
    expect(s.shields).toBe(before.shields);
    expect(s.leak).toBe(before.leak);
    expect(s.heat).toBe(before.heat);
    expect(s.sweepsSurvived).toBe(before.sweepsSurvived);
    expect(s.nextDirective).toBe(before.nextDirective);
  });
});

// --- sacrifice order -------------------------------------------------------

describe("sacrifice order", () => {
  it("defaults to the current tier priority order", () => {
    const s = newGame();
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(priorityOf(s, 0)).toBe(0);
  });

  it("standard reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(s.sacrificeOrder).toEqual([1, 0, 2, 3, 4, 5, 6]);
    expect(directiveById.get("standard")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("sigkill reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(directiveById.get("sigkill")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("backpressure reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(directiveById.get("backpressure")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("refuses to move past either end", () => {
    const s = newGame();
    expect(movePriority(s, 0, -1)).toBe(false);
    expect(movePriority(s, 6, 1)).toBe(false);
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4, 5, 6]); // unchanged
  });

  it("priorityOrder reflects priorityOf", () => {
    const s = newGame();
    movePriority(s, 4, -1); // [0, 1, 2, 4, 3]
    expect(priorityOrder(s)).toEqual([0, 1, 2, 4, 3, 5, 6]);
  });

  it("scavenger and group-kill ignore the sacrifice order", () => {
    const s = newGame();
    s.counts = [5, 5, 5, 5, 5, 0, 0];
    for (let i = 0; i < 4; i++) movePriority(s, 4, -1); // tier 4 first in the player's order
    expect(s.sacrificeOrder[0]).toBe(4);
    expect(directiveById.get("scavenger")!.victims(s, 3)).toEqual([4, 4, 4]); // by output, not order
    expect(directiveById.get("group-kill")!.victims(s, 3)).toEqual([0, 0, 0]); // densest tie-break
  });
});

describe("sanitizeSacrificeOrder", () => {
  it("keeps a valid permutation", () => {
    expect(sanitizeSacrificeOrder([2, 0, 1, 3, 4, 5, 6])).toEqual([2, 0, 1, 3, 4, 5, 6]);
  });
  it("returns a fresh array, not the input or shared default", () => {
    const input = [2, 0, 1, 3, 4, 5, 6];
    const result = sanitizeSacrificeOrder(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result).not.toBe(DEFAULT_SACRIFICE_ORDER);
  });
  it("falls back to the default for invalid input", () => {
    expect(sanitizeSacrificeOrder([0, 0, 1, 2, 3])).toEqual(DEFAULT_SACRIFICE_ORDER); // duplicate
    expect(sanitizeSacrificeOrder([0, 1, 2])).toEqual(DEFAULT_SACRIFICE_ORDER); // wrong length
    expect(sanitizeSacrificeOrder([0, 1, 2, 3, 9])).toEqual(DEFAULT_SACRIFICE_ORDER); // out of range
    expect(sanitizeSacrificeOrder(undefined)).toEqual(DEFAULT_SACRIFICE_ORDER);
  });
});

// --- directive scheduling --------------------------------------------------

describe("directive scheduling", () => {
  it("starts on the standard directive", () => {
    expect(newGame().nextDirective).toBe("standard");
  });

  it("only draws from directives unlocked at the current sweep count", () => {
    const s = newGame();
    s.sweepsSurvived = 0;
    expect(unlockedDirectives(s).map((d) => d.id)).toEqual(["standard"]);
    s.sweepsSurvived = 3; // boundary: sigkill unlocks exactly here
    expect(unlockedDirectives(s).map((d) => d.id)).toEqual(["standard", "sigkill"]);
    for (let i = 0; i < 50; i++) {
      s.rngState = (i + 1) * 2654435761;
      expect(["standard", "sigkill"]).toContain(pickNextDirective(s));
    }
  });

  it("is deterministic for a fixed rngState", () => {
    const a = newGame();
    a.rngState = 12345;
    a.sweepsSurvived = 20;
    const b = newGame();
    b.rngState = 12345;
    b.sweepsSurvived = 20;
    expect(pickNextDirective(a)).toBe(pickNextDirective(b));
  });

  it("never immediately repeats a directive when more than one is unlocked", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.rngState = 999;
    s.nextDirective = "scavenger";
    for (let i = 0; i < 50; i++) expect(pickNextDirective(s)).not.toBe("scavenger");
  });

  it("advances the next directive after a sweep", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.counts = [10, 0, 0, 0, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(
      s.nextDirective,
    );
  });

  it("still advances with no children to reap", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(
      s.nextDirective,
    );
  });

  it("falls back to standard for an unknown loaded directive id", () => {
    const s = newGame();
    (s as unknown as { nextDirective: string }).nextDirective = "bogus";
    s.counts = [10, 0, 0, 0, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    expect(() => tick(s, 0.01)).not.toThrow();
    // the fallback was actually applied: standard budget at severity 0.15, nice 0
    expect(s.counts[0]).toBe(8); // 10 - round(10 * 0.15 * 1) = 8
    expect(s.log.some((l) => l.startsWith("cleanup sweep [standard]:"))).toBe(true);
  });

  it("applies the drawn directive end-to-end (scavenger reaps the highest-output tier)", () => {
    const s = newGame();
    s.sweepsSurvived = 6; // scavenger unlocks exactly here
    s.nextDirective = "scavenger";
    s.ramCap = 1000;
    s.counts = [1, 1, 1, 1, 1, 0, 0];
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.counts[4]).toBe(0); // tier 4 has the highest baseOutput; scavenger hits it first
    expect(s.counts.slice(0, 4)).toEqual([1, 1, 1, 1]); // lower-output tiers untouched this sweep
  });
});

// --- memory ----------------------------------------------------------------

describe("memory leak and gc", () => {
  it("grows the leak at 1% of the non-immune footprint per second", () => {
    const s = newGame();
    s.counts = [0, 10, 0, 0, 0, 0, 0]; // 10 fork()s = 20 MB, all leak-prone
    s.ramCap = 100;
    tick(s, 10);
    expect(s.leak).toBeCloseTo(20 * 0.01 * 10, 3);
  });

  it("a leak-immune tier consumes RAM but never feeds the leak", () => {
    const s = newGame();
    s.counts = [10, 0, 0, 0, 0, 0, 0]; // 10 noop loops = 10 MB, leak-immune
    s.ramCap = 100;
    expect(childRam(s)).toBe(10);
    tick(s, 30); // under the sweep interval, so the counts are stable
    expect(s.leak).toBe(0);
    expect(ramUsed(s)).toBe(10); // still counted against the RAM ceiling
  });

  it("only the non-immune share of a mixed footprint leaks", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0, 0, 0]; // 10 MB immune + 20 MB leak-prone
    s.ramCap = 1000;
    tick(s, 10);
    expect(s.leak).toBeCloseTo(20 * 0.01 * 10, 3); // immune 10 MB contributes nothing
  });

  it("free() zeroes the leak", () => {
    const s = newGame();
    s.leak = 42;
    expect(freeMemory(s)).toBe(true);
    expect(s.leak).toBe(0);
    expect(freeMemory(s)).toBe(false); // nothing left to free
  });

  it("gc keeps the leak near zero", () => {
    const s = newGame();
    s.counts = [0, 10, 0, 0, 0, 0, 0];
    s.ramCap = 100;
    s.gc = 2;
    tick(s, 10);
    expect(s.leak).toBeLessThan(0.2);
  });

  it("gc drains a standing leak with no footprint", () => {
    const s = newGame();
    s.ramCap = 1000; // keep the leak clear of the OOM reclaim
    s.leak = 50;
    s.gc = 1;
    tick(s, 1);
    expect(s.leak).toBeCloseTo(45, 5);
  });

  it("a standing leak decays geometrically under gc", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.leak = 50;
    s.gc = 1;
    tick(s, 10);
    expect(s.leak).toBeCloseTo(50 * 0.9 ** 10, 5);
  });

  it("without gc a standing leak persists", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.leak = 50;
    s.gc = 0;
    tick(s, 1);
    expect(s.leak).toBe(50);
  });
});

describe("OOM killer", () => {
  it("kills highest-output children when over the cap", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 2, 0, 0]; // two cron daemons (16 MB each)
    s.ramCap = 16; // room for one
    tick(s, 0.01);
    expect(s.oomCount).toBe(1);
    expect(s.counts[4]).toBeLessThan(2);
    expect(ramUsed(s)).toBeLessThanOrEqual(s.ramCap);
  });

  it("applies a ~10% cycle penalty", () => {
    const s = newGame();
    s.cycles = d(1000);
    s.counts = [0, 0, 0, 0, 2, 0, 0];
    s.ramCap = 16;
    // income accrues before the killer fires; the penalty is applied to that total
    const afterIncome = d(1000).add(cyclesPerSec(s).mul(0.01));
    tick(s, 0.01);
    expect(s.cycles.toNumber()).toBeCloseTo(afterIncome.mul(0.9).toNumber(), 5);
  });

  it("bulk-drains a huge count without stalling", () => {
    const s = newGame();
    s.counts = [1e9, 0, 0, 0, 0, 0, 0]; // noop loop, 1 MB each
    s.ramCap = 8;
    tick(s, 0.01);
    expect(s.oomCount).toBe(1);
    expect(ramUsed(s)).toBeLessThanOrEqual(s.ramCap);
  });

  it("does not OOM when RAM is exactly at the cap", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 1, 0, 0]; // one cron daemon, exactly 16 MB
    s.ramCap = 16;
    tick(s, 0.01);
    expect(s.oomCount).toBe(0);
  });

  it("does not compound the penalty while a full bar leaks past the cap", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 1, 0, 0]; // one cron daemon = 16 MB = ramCap
    s.ramCap = 16;
    // The old `used > ramCap` trigger fired every tick; the 2% grace holds the
    // killer off while the leak creeps up toward `ramCap * OOM_TOLERANCE`.
    for (let i = 0; i < 5; i++) tick(s, 0.01);
    expect(s.oomCount).toBe(0);
  });

  it("fires strictly above ramCap * OOM_TOLERANCE, not at it", () => {
    const below = newGame();
    below.ramCap = 16;
    below.leak = 16.2; // < 16 * 1.02 = 16.32
    tick(below, 0.01);
    expect(below.oomCount).toBe(0);

    const above = newGame();
    above.ramCap = 16;
    above.leak = 16.4; // > 16 * 1.02 = 16.32
    tick(above, 0.01);
    expect(above.oomCount).toBe(1);
  });
});

// --- heat ------------------------------------------------------------------

describe("heat", () => {
  it("heatEquilibrium is footprint / (1 + cooling/2)", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 5, 0, 0]; // 5 cron daemons = 80 MB
    expect(heatEquilibrium(s)).toBe(80);

    s.cooling = 2; // 1 + 2 * 0.5 = 2 -> half the equilibrium
    expect(heatEquilibrium(s)).toBe(40);
  });

  it("settles at an interior equilibrium and shows a partial throttle", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 5, 0, 0]; // 80 MB -> equilibrium 80
    s.sweepTimer = 1e9; // freeze the sweep so the footprint is stable
    tick(s, 600); // residual 80 * e^-12
    expect(s.heat).toBeCloseTo(80, 0);
    expect(heatMult(s)).toBeCloseTo(0.75, 4);
  });

  it("a large footprint approaches saturation", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 8, 0, 0]; // 128 MB -> equilibrium 128, above the cap
    s.sweepTimer = 1e9;
    tick(s, 600);
    expect(s.heat).toBe(100);
    expect(heatMult(s)).toBe(0.5);
  });

  it("decays toward 0 with no footprint", () => {
    const s = newGame();
    s.heat = 50;
    s.sweepTimer = 1e9;
    tick(s, 10); // 50 * e^-0.2
    expect(s.heat).toBeCloseTo(40.94, 2);
  });

  it("cooling lowers the equilibrium", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 5, 0, 0]; // 80 MB
    s.cooling = 1; // 1 + 0.5 = 1.5 -> equilibrium 53.33
    s.sweepTimer = 1e9;
    expect(heatEquilibrium(s)).toBeCloseTo(53.33, 2);
    tick(s, 600);
    expect(s.heat).toBeCloseTo(53.33, 2);
    expect(heatMult(s)).toBe(1); // equilibrium sits below the throttle
  });

  it("rises from 0 toward equilibrium", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 5, 0, 0]; // 80 MB -> equilibrium 80
    s.heat = 0;
    s.sweepTimer = 1e9;
    tick(s, 10); // 80 * (1 - e^-0.2)
    expect(s.heat).toBeCloseTo(14.5, 1);
  });

  it("clamps to [0, 100]", () => {
    const hot = newGame();
    hot.ramCap = 1000;
    hot.counts = [0, 0, 0, 0, 10, 0, 0]; // 160 MB -> equilibrium above the cap
    hot.heat = 99;
    hot.sweepTimer = 1e9;
    tick(hot, 100);
    expect(hot.heat).toBe(100);

    const cold = newGame();
    cold.heat = 5;
    cold.sweepTimer = 1e9;
    tick(cold, 1000); // no footprint -> equilibrium 0, decays to ~0
    expect(cold.heat).toBeCloseTo(0, 5);
  });

  it("does not throttle cycles below HEAT_THROTTLE_AT", () => {
    const cool = newGame();
    const warm = newGame();
    warm.heat = HEAT_THROTTLE_AT - 1;
    expect(warm.heat).toBeLessThan(HEAT_THROTTLE_AT);
    expect(cyclesPerSec(warm).toNumber()).toBe(cyclesPerSec(cool).toNumber());
  });

  it("throttles cycles above HEAT_THROTTLE_AT (heatMult is 0.75 at heat 80)", () => {
    const s = newGame();
    s.heat = 80;
    expect(heatMult(s)).toBeCloseTo(
      1 - MAX_THROTTLE * ((80 - HEAT_THROTTLE_AT) / (100 - HEAT_THROTTLE_AT)),
      10,
    );
    expect(heatMult(s)).toBe(0.75);
    expect(cyclesPerSec(s).toNumber()).toBeCloseTo(0.75, 10);
  });

  it("buyCooling spends cycles and refuses when unaffordable", () => {
    const poor = newGame();
    poor.cycles = coolCost(poor).sub(1);
    expect(buyCooling(poor)).toBe(false);
    expect(poor.cooling).toBe(0);

    const rich = newGame();
    rich.cycles = coolCost(rich).add(d(5));
    expect(buyCooling(rich)).toBe(true);
    expect(rich.cooling).toBe(1);
    expect(rich.cycles.eq(d(5))).toBe(true);
    expect(rich.log[0]).toMatch(/cooling/i);
  });

  it("coolCost grows 2.5x per level", () => {
    const s = newGame();
    const first = coolCost(s);
    s.cooling = 1;
    expect(coolCost(s).div(first).toNumber()).toBeCloseTo(2.5, 5);
  });
});

// --- prestige --------------------------------------------------------------

describe("prestige", () => {
  it("refuses to fork below the threshold", () => {
    const s = newGame();
    expect(doFork(s)).toBe(false);
    expect(s.forks).toBe(0);
  });

  it("seeds a forked legacy daemon's rate from unthrottled income", () => {
    const s = newGame();
    s.totalEarned = d(2e6);
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 10, 0, 0]; // big footprint -> heat-throttled board
    s.heat = 100;
    expect(heatMult(s)).toBeLessThan(1);
    // rate is derived from the pre-throttle, lineage-free peak, so neither heatMult
    // nor lineageMult is baked in
    const expected = baseCyclesPerSec(s).mul(0.1);
    expect(doFork(s)).toBe(true);
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(expected.toNumber(), 5);
  });

  it("does not bake lineage into the legacy rate (snapshot is lineage-free)", () => {
    const s = newGame();
    s.totalEarned = d(1e9); // >= forkCost at forks = 2 (1e8)
    s.ramCap = 1000;
    s.forks = 2; // lineage ×1.2
    s.counts = [0, 0, 0, 0, 10, 0, 0]; // childOutput 20000, +root 1 => base 20001
    expect(doFork(s)).toBe(true);
    // 20001 * 0.1, not 20001 * 1.2 * 0.1 = 2400.12 (the double-count bug)
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(2000.1, 5);
  });

  it("resets the working set and grants lineage plus a legacy daemon", () => {
    const s = newGame();
    s.totalEarned = d(2e6);
    s.counts = [5, 5, 0, 0, 0, 0, 0];
    expect(doFork(s)).toBe(true);
    expect(s.forks).toBe(1);
    expect(lineageMult(s).toNumber()).toBeCloseTo(1.1, 5);
    expect(s.counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(s.cycles.eq(0)).toBe(true);
    expect(s.ramCap).toBe(BASE.ramCap);
    expect(s.legacy).toHaveLength(1);
    expect(s.legacy[0].rate.toNumber()).toBeGreaterThan(0);
  });

  it("clears per-run heat, cooling, and shields on fork", () => {
    const s = newGame();
    s.totalEarned = d(2e6);
    s.ramCap = 1000;
    s.counts = [5, 5, 0, 0, 0, 0, 0];
    s.heat = 75; // would otherwise throttle the fresh run
    s.cooling = 3;
    s.shields = 4;
    expect(doFork(s)).toBe(true);
    expect(s.heat).toBe(0);
    expect(s.cooling).toBe(0);
    expect(s.shields).toBe(0);
    expect(s.counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("resets sweepInterval (not just sweepTimer) on fork", () => {
    const s = newGame();
    s.totalEarned = d(1e9);
    s.sweepsSurvived = 60; // escalated cadence: sweepIntervalFor is the 10s floor
    expect(doFork(s)).toBe(true);
    expect(s.sweepInterval).toBeCloseTo(sweepIntervalFor(s), 5);
    expect(s.sweepInterval).toBeCloseTo(10, 5);
    expect(s.sweepTimer).toBeCloseTo(s.sweepInterval, 5);
  });
});

// --- legacy daemons --------------------------------------------------------

describe("legacy daemons", () => {
  it("applies the lineage multiplier once to legacy income per tick", () => {
    const s = newGame();
    s.forks = 2; // lineage ×1.2
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: false, respawn: 0 }];
    tick(s, 1);
    // root 1 * 1.2 + legacy rate 10 * 1.2 = 13.2 (lineage applied once, not twice)
    expect(s.cycles.toNumber()).toBeCloseTo(13.2, 5);
  });
});

describe("legacy auto-respawn unlock", () => {
  it("keeps a crashed daemon down without the unlock, even with gc", () => {
    const s = newGame();
    s.gc = 5; // gc no longer drives respawn
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    tick(s, 1);
    expect(s.legacy[0].crashed).toBe(true);
  });

  it("auto-respawns once the legacy-respawn unlock is granted", () => {
    const s = newGame();
    s.unlocks[UNLOCK.legacyRespawn] = true;
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    tick(s, 1);
    expect(s.legacy[0].crashed).toBe(false);
  });

  it("still restarts a crashed daemon by hand before the unlock", () => {
    const s = newGame();
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    expect(nudgeDaemon(s, 0)).toBe(true);
    expect(s.legacy[0].crashed).toBe(false);
  });

  it("fires the milestone at two forks and unlocks auto-respawn", () => {
    const s = newGame();
    s.forks = 2;
    tick(s, 0); // a live tick evaluates milestones
    expect(s.unlocks[UNLOCK.legacyRespawn]).toBe(true);
  });

  it("produces on the offline path (legacy block runs before the early-return)", () => {
    const s = newGame();
    s.legacy = [{ name: "legacy-1", rate: d(1000), crashed: false, respawn: 0 }];
    tick(s, 0.001, { offline: true }); // tiny dt: the 0.2%/s crash roll is effectively impossible
    expect(s.cycles.toNumber()).toBeGreaterThan(0.9); // root 0.001 + legacy 1.0
  });
});

// --- big-number range ------------------------------------------------------

describe("big-number range", () => {
  it("represents magnitudes far beyond a double", () => {
    const v = d("1e400");
    expect(v.isFinite()).toBe(true);
    expect(v.gt(d(Number.MAX_VALUE))).toBe(true);
  });

  it("multiplies past the double ceiling", () => {
    const v = d("1e300").mul(d("1e300"));
    expect(v.isFinite()).toBe(true);
    expect(v.log10().toNumber()).toBeCloseTo(600, 0);
  });

  it("formats astronomically large values in exponent notation", () => {
    expect(fmt(d("1e60"))).toBe("1.00e60");
  });
});

// --- progression -----------------------------------------------------------

/**
 * Deterministic greedy player: tick, then spend on RAM, keep one of every tier alive,
 * and fill the rest with the highest affordable tier; cool when hot, buy `nice` once the
 * sweeps bite, and buy `gc` to keep the leak from churning the board. No legacy daemons
 * are ever created, so `tick` never touches `Math.random`.
 *
 * The plan's sketch omitted the leak and composition management, which made the run
 * seed-chaotic (the OOM killer fired ~200×/hour and wiped the board) and left a
 * cron-only board. `buyGc` and the one-of-each floor are what a real player does; they
 * make the script's outcome stable across every PRNG seed (60/60) without touching the
 * assertions.
 */
function playGreedy(s: GameState, seconds: number, dt = 1): void {
  for (let t = 0; t < seconds; t += dt) {
    tick(s, dt);
    for (;;) {
      if (ramUsed(s) > s.ramCap * 0.75 && s.cycles.gte(mallocCost(s))) {
        buyMalloc(s);
        continue;
      }
      // Composition floor: keep one of every tier alive so the board stays a mix.
      const missing = TIERS.findIndex((_, i) => s.counts[i] === 0 && canSpawn(s, i));
      if (missing >= 0) {
        spawn(s, missing);
        continue;
      }
      // Otherwise fill the RAM budget with the highest tier that fits.
      let bought = false;
      for (let i = TIERS.length - 1; i >= 0; i--) {
        if (canSpawn(s, i)) {
          spawn(s, i);
          bought = true;
          break;
        }
      }
      if (!bought) break;
    }
    if (s.heat > HEAT_THROTTLE_AT + 5 && s.cycles.gte(coolCost(s))) buyCooling(s);
    if (s.sweepsSurvived > 2 && s.cycles.gte(niceCost(s))) buyNice(s);
    if (s.cycles.gte(gcCost(s))) buyGc(s);
  }
}

/** A fresh state with a pinned PRNG cursor, so directive draws are reproducible. */
function freshGreedy(rngState = 1): GameState {
  const s = newGame();
  s.rngState = rngState;
  return s;
}

describe("progression", () => {
  it("a greedy session reaches the upper tiers and fork-ready within an hour", () => {
    const s = freshGreedy();
    playGreedy(s, 3600);
    expect(s.counts[3]).toBeGreaterThan(0); // microservice
    expect(s.counts[4]).toBeGreaterThan(0); // cron daemon
    expect(s.totalEarned.gte(d(1e6))).toBe(true); // prestige affordable
  });

  it("income grows super-linearly over the session", () => {
    const s = freshGreedy();
    playGreedy(s, 600);
    const early = cyclesPerSec(s);
    playGreedy(s, 3000);
    const late = cyclesPerSec(s);
    expect(late.div(early).toNumber()).toBeGreaterThan(100);
  });

  it("a composed board still functions after a session", () => {
    // NB: this does not claim "no tier dominates" — cron daemons do dominate on both
    // payback and output/RAM (a pre-existing base-stat shape, out of scope here). It only
    // checks that a session ends with a mixed, functioning board (workers still boosted).
    const s = freshGreedy();
    playGreedy(s, 3600);
    expect(s.counts.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(synergyMult(s, 2)).toBeGreaterThan(1); // microservices still boost workers
  });

  it("progresses from several fixed PRNG seeds (not a lucky snapshot)", () => {
    // The plan's script is seed-sensitive; pinning one seed would make the test vacuous.
    // Five fixed cursors cover the directive draws cheaply (~0.2 s total).
    for (const seed of [1, 2, 3, 7, 12]) {
      const s = freshGreedy(seed);
      playGreedy(s, 3600);
      expect(s.counts[3], `seed ${seed}: microservice`).toBeGreaterThan(0);
      expect(s.counts[4], `seed ${seed}: cron daemon`).toBeGreaterThan(0);
      expect(s.totalEarned.gte(d(1e6)), `seed ${seed}: totalEarned`).toBe(true);
      expect(s.counts.filter((n) => n > 0).length, `seed ${seed}: tiers`).toBeGreaterThanOrEqual(3);
      expect(s.heat, `seed ${seed}: heat floor`).toBeGreaterThan(HEAT_THROTTLE_AT);
      expect(s.heat, `seed ${seed}: heat ceiling`).toBeLessThan(100);
    }
  });

  it("heat stays interior, not saturated", () => {
    const s = freshGreedy();
    playGreedy(s, 3600);
    expect(s.heat).toBeGreaterThan(HEAT_THROTTLE_AT);
    expect(s.heat).toBeLessThan(100);
  });
});

describe("lineage perks", () => {
  it("newGame starts with no points and no perks", () => {
    const s = newGame();
    expect(s.lineage).toBe(0);
    expect(s.perks).toEqual({});
    expect(s.runBaseEarned.toNumber()).toBe(0);
    expect(s.runStartPlaytime).toBe(0);
  });

  it("buyPerk spends points, adds a level, and refuses when broke or gated", () => {
    const s = newGame();
    expect(buyPerk(s, "spin")).toBe(false); // 0 points
    s.lineage = 2;
    expect(buyPerk(s, "spin")).toBe(true);
    expect(s.lineage).toBe(0);
    expect(s.perks.spin).toBe(1);
    expect(buyPerk(s, "spin")).toBe(false); // maxLevel 1 already reached
    s.lineage = 5;
    expect(buyPerk(s, "tailcall")).toBe(true); // prereq `spin` owned, costs 5
    expect(s.lineage).toBe(0);
    s.lineage = 4;
    expect(buyPerk(s, "vec")).toBe(false); // prereq owned but costs 10
    s.lineage = 10;
    expect(buyPerk(s, "vec")).toBe(true);
  });
});

describe("perk effects on the economy", () => {
  it("incomeMult raises cps; vec doubles the root term", () => {
    const plain = newGame();
    const perked = newGame();
    perked.perks = { spin: 1 }; // +10% on BOTH children and root
    expect(cyclesPerSec(perked).toNumber()).toBeCloseTo(cyclesPerSec(plain).toNumber() * 1.1, 6);
    perked.perks = { vec: 1 };
    expect(cyclesPerSec(perked).toNumber()).toBeCloseTo(2, 6); // root 1 -> 2, no children
  });
  it("tailcall reduces tierCost; oomguard raises the effective RAM cap", () => {
    const s = newGame();
    const cost0 = tierCost(s, 0).toNumber();
    s.perks = { tailcall: 1 };
    expect(tierCost(s, 0).toNumber()).toBeLessThan(cost0);
    expect(ramCapTotal(newGame())).toBe(BASE.ramCap);
    const oom = newGame();
    oom.perks = { oomguard: 1 };
    expect(ramCapTotal(oom)).toBe(BASE.ramCap + 8);
  });
  it("heatsink lowers the heat equilibrium; renice reduces sweep victims but respects the floor", () => {
    const s = newGame();
    s.counts = TIERS.map(() => 4);
    const eq = heatEquilibrium(s);
    s.perks = { heatsink: 1 };
    expect(heatEquilibrium(s)).toBeLessThan(eq);
    const many = newGame();
    many.counts = TIERS.map(() => 10);
    many.nice = 40;
    many.perks = { renice: 1, reaper: 20 }; // drive niceAdd hard against the 0.3 floor
    expect(sweepVictimMult(many)).toBeGreaterThanOrEqual(0.3);
    expect(estimateVictims(many)).toBeGreaterThanOrEqual(0);
  });
  it("cheapfork reduces forkCost but never below the floor", () => {
    const s = newGame();
    s.forks = 3;
    const full = forkCost(s).toNumber();
    s.perks = { cheapfork: 1 };
    expect(forkCost(s).toNumber()).toBeCloseTo(full / 1.1, 6);
    expect(forkCost(s).toNumber()).toBeGreaterThanOrEqual(full * 0.25 - 1e-9);
  });
});

describe("doFork with perks", () => {
  it("awards points from the run, snapshots the run, and keeps perks + points", () => {
    const s = newGame();
    s.perks = { echo: 1 }; // pointsMult = 1 + 0.05*sqrt(1) = 1.05
    s.lineage = 7; // must survive the fork
    s.totalEarned = d(1e6); // == forkCost(0), so canFork is true
    s.playtime = 600; // runSeconds 600 -> base 5; 5*1.05 -> 5
    expect(doFork(s)).toBe(true);
    expect(s.lineage).toBe(12);
    expect(s.perks.echo).toBe(1);
    expect(s.runBaseEarned.toNumber()).toBeCloseTo(1e6, 6);
    expect(s.runStartPlaytime).toBeCloseTo(600, 6);
  });
  it("applies start-of-run grants", () => {
    const s = newGame();
    s.perks = { sigblock: 1, startup: 1 };
    s.totalEarned = d(1e6);
    s.playtime = 600;
    doFork(s);
    expect(s.shields).toBe(1);
    expect(s.cycles.toNumber()).toBe(1000);
  });
  it("still resets the working set", () => {
    const s = newGame();
    s.counts = [5, 0, 0, 0, 0, 0, 0];
    s.totalEarned = d(1e6);
    s.playtime = 600;
    doFork(s);
    expect(s.counts.every((n) => n === 0)).toBe(true);
  });
});

describe("perk effects on legacy daemons", () => {
  it("applies the cache perk's legacyRateMult to legacy income", () => {
    const s = newGame();
    s.legacy = [{ name: "legacy-1", rate: d(1000), crashed: false, respawn: 0 }];
    s.perks = { cache: 1 }; // legacyRateMult = 1 + 0.05*sqrt(1) = 1.05
    const before = s.cycles.toNumber();
    tick(s, 0.001); // tiny dt: the 0.2%/s crash roll is effectively impossible
    const gained = s.cycles.toNumber() - before;
    // root income (1/s) + legacy (1000 * 1.05 /s), over 0.001 s
    expect(gained).toBeCloseTo((1 + 1000 * 1.05) * 0.001, 6);
  });
});

describe("milestone gating", () => {
  it("newGame starts with no milestones and no unlocks", () => {
    const s = newGame();
    expect(s.milestonesDone).toEqual({});
    expect(s.unlocks).toEqual({});
  });
  it("gates nice until `first-blood` fires, then allows it", () => {
    const s = newGame();
    s.cycles = d(1e9);
    expect(buyNice(s)).toBe(false); // locked
    s.sweepsSurvived = 1;
    tick(s, 0); // evaluateMilestones runs at the end of a live tick
    expect(s.unlocks[UNLOCK.nice]).toBe(true);
    expect(buyNice(s)).toBe(true);
  });
  it("gates gc until `grown-up` fires, then allows it", () => {
    const s = newGame();
    s.cycles = d(1e9);
    expect(buyGc(s)).toBe(false); // locked
    s.ramCap = 24;
    tick(s, 0);
    expect(buyGc(s)).toBe(true);
  });
  it("does not fire milestones during an offline tick", () => {
    const s = newGame();
    s.sweepsSurvived = 1;
    tick(s, 0, { offline: true });
    expect(s.milestonesDone["first-blood"]).toBeUndefined();
    tick(s, 0);
    expect(s.milestonesDone["first-blood"]).toBe(true);
  });
});

describe("maxAffordable", () => {
  it("matches a brute-force spawn loop for small counts", () => {
    const s = newGame();
    s.cycles = d(1e4);
    const brute = newGame();
    brute.cycles = d(1e4);
    let n = 0;
    while (spawn(brute, 0)) n++;
    expect(maxAffordable(s, 0)).toBe(n);
    expect(n).toBeGreaterThan(0);
  });
  it("is limited by RAM when cycles are plentiful", () => {
    const s = newGame();
    s.cycles = d("1e100");
    expect(maxAffordable(s, 0)).toBe(BASE.ramCap); // tier 0 costs 1 MB, base cap 8
  });
  it("returns 0 when unaffordable or out of RAM", () => {
    const s = newGame();
    s.cycles = d(0);
    expect(maxAffordable(s, 0)).toBe(0);
    const full = newGame();
    full.cycles = d("1e100");
    full.counts[0] = BASE.ramCap; // fills RAM exactly
    expect(maxAffordable(full, 0)).toBe(0);
  });
});

describe("spawnMax", () => {
  it("refuses while buy-max is locked", () => {
    const s = newGame();
    s.cycles = d(1e6);
    expect(spawnMax(s, 0)).toBe(false);
  });
  it("bulk-buys the max affordable once unlocked, without overspending", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.unlocks = { [UNLOCK.buyMax]: true };
    const expected = maxAffordable(s, 0); // pure, safe to read before the action
    expect(spawnMax(s, 0)).toBe(true);
    expect(s.counts[0]).toBe(expected);
    expect(s.cycles.gte(0)).toBe(true);
    expect(ramUsed(s)).toBeLessThanOrEqual(s.ramCap);
  });
  it("returns false with nothing affordable", () => {
    const s = newGame();
    s.cycles = d(0);
    s.unlocks = { [UNLOCK.buyMax]: true };
    expect(spawnMax(s, 0)).toBe(false);
  });
});

describe("buyMax toggle state", () => {
  it("defaults to false", () => {
    expect(newGame().buyMax).toBe(false);
  });
});

describe("automation state", () => {
  it("defaults the toggles off and the threshold to 16", () => {
    const s = newGame();
    expect([s.autoNice, s.autoMalloc, s.autoFree]).toEqual([false, false, false]);
    expect(s.freeThreshold).toBe(16);
  });
});

describe("runAutomation", () => {
  it("auto-malloc buys when toggled, unlocked, and affordable", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + MALLOC_STEP);
  });
  it("does nothing when toggled off or locked", () => {
    const off = newGame();
    off.cycles = d(1e6);
    off.unlocks = { [UNLOCK.autoMalloc]: true }; // toggled off
    tick(off, 0);
    expect(off.ramCap).toBe(BASE.ramCap);
    const locked = newGame();
    locked.cycles = d(1e6);
    locked.autoMalloc = true; // not unlocked
    tick(locked, 0);
    expect(locked.ramCap).toBe(BASE.ramCap);
  });
  it("auto-nice needs both hands-off and first-blood", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.autoNice = true;
    s.unlocks = { [UNLOCK.autoNice]: true }; // missing the nice unlock
    tick(s, 0);
    expect(s.nice).toBe(0);
    s.unlocks = { [UNLOCK.autoNice]: true, [UNLOCK.nice]: true };
    tick(s, 0);
    expect(s.nice).toBe(1);
  });
  it("auto-free fires at the threshold and not below", () => {
    const s = newGame();
    s.ramCap = 100; // keep the leak below the OOM threshold so only auto-free acts
    s.unlocks = { [UNLOCK.autoFree]: true };
    s.autoFree = true;
    s.freeThreshold = 10;
    s.leak = 9;
    tick(s, 0);
    expect(s.leak).toBe(9); // below
    s.leak = 10;
    tick(s, 0);
    expect(s.leak).toBe(0); // at the threshold
  });
  it("buys at most one level per tick", () => {
    const s = newGame();
    s.cycles = d(1e9);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + MALLOC_STEP);
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + 2 * MALLOC_STEP);
  });
  it("does not run on offline ticks", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0, { offline: true });
    expect(s.ramCap).toBe(BASE.ramCap);
  });
  it("never drives cycles negative", () => {
    const s = newGame();
    s.cycles = mallocCost(s); // exactly affordable
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.cycles.gte(0)).toBe(true);
  });
});

describe("auto-free boundary", () => {
  it("fires on any leak when the threshold is 0", () => {
    const s = newGame();
    s.ramCap = 100;
    s.unlocks = { [UNLOCK.autoFree]: true };
    s.autoFree = true;
    s.freeThreshold = 0;
    s.leak = 0.001;
    tick(s, 0);
    expect(s.leak).toBe(0);
  });
});

describe("nohup offline cap upgrade", () => {
  it("starts at the base cap and grows by the step per level", () => {
    const s = newGame();
    expect(s.offlineCap).toBe(0);
    expect(offlineCapS(s)).toBe(BASE_OFFLINE_CAP_S);
    s.cycles = d(1e12);
    expect(buyOfflineCap(s)).toBe(true);
    expect(s.offlineCap).toBe(1);
    expect(offlineCapS(s)).toBe(BASE_OFFLINE_CAP_S + OFFLINE_CAP_STEP);
  });
  it("refuses when unaffordable and costs grow per level", () => {
    const s = newGame();
    expect(buyOfflineCap(s)).toBe(false); // 0 cycles
    s.cycles = d(1e12);
    buyOfflineCap(s);
    expect(offlineCost(s).gt(d(1e7))).toBe(true); // level 1 costs more than level 0
  });
});

describe("nohup cap saturation", () => {
  it("saturates at the step budget and refuses further purchases", () => {
    const s = newGame();
    s.cycles = d("1e300");
    s.offlineCap = 1000; // far beyond the budget
    expect(offlineCapS(s)).toBe(OFFLINE_MAX_STEPS);
    expect(buyOfflineCap(s)).toBe(false); // saturated: a purchase would buy nothing
  });
});

describe("achievement income hook", () => {
  it("scales live income by (1 + mult) per earned achievement", () => {
    const s = newGame();
    const def = achievementById("first-earnings")!;
    const before = rawCyclesPerSec(s);
    s.achievementsDone[def.id] = true;
    expect(rawCyclesPerSec(s).toNumber()).toBeCloseTo(before.toNumber() * (1 + def.mult), 10);
  });

  it("leaves baseCyclesPerSec (the legacy snapshot source) achievement-free", () => {
    const s = newGame();
    const before = baseCyclesPerSec(s);
    s.achievementsDone["first-earnings"] = true;
    expect(baseCyclesPerSec(s).eq(before)).toBe(true);
  });

  it("does not bake achievements into a forked daemon's rate", () => {
    const withA = newGame();
    const without = newGame();
    for (const s of [withA, without]) {
      s.totalEarned = d(2e6);
      s.ramCap = 1000;
      s.counts = [0, 0, 0, 0, 10, 0, 0];
    }
    withA.achievementsDone["first-earnings"] = true;
    expect(doFork(withA)).toBe(true);
    expect(doFork(without)).toBe(true);
    expect(withA.legacy[0].rate.eq(without.legacy[0].rate)).toBe(true);
  });
});

describe("achievement tick evaluation", () => {
  it("fires on a live tick", () => {
    const s = newGame();
    s.totalEarned = d(1e3);
    tick(s, 0);
    expect(s.achievementsDone["first-earnings"]).toBe(true);
  });

  it("grants none on an offline tick (live-only)", () => {
    const s = newGame();
    s.totalEarned = d(1e3);
    tick(s, 0, { offline: true });
    expect(s.achievementsDone["first-earnings"]).toBeUndefined();
  });
});

// --- repeatables -----------------------------------------------------------

describe("repeatable integration", () => {
  it("scales perked income by incomeMult but leaves baseCyclesPerSec clean", () => {
    const modded = newGame();
    modded.repeatables.overclock = 4; // mag 0.2
    expect(rawCyclesPerSec(modded).toNumber()).toBeCloseTo(
      rawCyclesPerSec(newGame()).toNumber() * 1.2,
      10,
    );
    const clean = newGame();
    clean.repeatables.overclock = 4;
    expect(baseCyclesPerSec(clean).eq(baseCyclesPerSec(newGame()))).toBe(true);
  });

  it("lifts the RAM cap by ramCapAdd", () => {
    const s = newGame();
    s.repeatables.swapfile = 4; // +8
    expect(ramCapTotal(s)).toBe(BASE.ramCap + 8);
  });

  it("lowers heat equilibrium by heatGenMult", () => {
    const base = newGame();
    base.counts = [0, 0, 0, 0, 10, 0, 0];
    const modded = newGame();
    modded.counts = [0, 0, 0, 0, 10, 0, 0];
    modded.repeatables.undervolt = 4; // /1.16
    expect(heatEquilibrium(modded)).toBeCloseTo(heatEquilibrium(base) / 1.16, 8);
  });

  it("discounts tierCost by tierCostMult once bulk is owned, unchanged at level 0", () => {
    const plain = newGame();
    const base = tierCost(plain, 0); // no counts, no repeatables
    expect(tierCost(plain, 0).eq(base)).toBe(true); // identity at level 0
    const bulk = newGame();
    bulk.repeatables.bulk = 4; // /(1 + 0.05 * 2) = /1.1
    expect(tierCost(bulk, 0).div(base).toNumber()).toBeCloseTo(1 / 1.1, 10);
  });
});

describe("buyRepeatable", () => {
  it("spends cycles, levels up, and refuses unaffordable/unknown ids", () => {
    const s = newGame();
    s.cycles = d(1e6);
    expect(buyRepeatable(s, "overclock")).toBe(true);
    expect(s.repeatables.overclock).toBe(1);
    expect(s.cycles.lt(d(1e6))).toBe(true);
    expect(buyRepeatable(s, "nope")).toBe(false);
    expect(buyRepeatable(newGame(), "overclock")).toBe(false);
  });
});

describe("buy-max with the bulk discount", () => {
  it("maxAffordable stays exact for an unlocked tier with bulk owned", () => {
    const s = newGame();
    s.unlocks[UNLOCK.tier5] = true;
    s.cycles = d(1e12);
    s.ramCap = 10_000;
    s.repeatables.bulk = 4;

    const brute = newGame();
    brute.unlocks[UNLOCK.tier5] = true;
    brute.cycles = d(1e12);
    brute.ramCap = 10_000;
    brute.repeatables.bulk = 4;
    let n = 0;
    while (spawn(brute, 5)) n++;
    expect(n).toBeGreaterThan(0);
    expect(maxAffordable(s, 5)).toBe(n);
  });
});
