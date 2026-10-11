import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { fmt } from "./format";
import {
  BASE,
  DEFAULT_SACRIFICE_ORDER,
  HEAT_THROTTLE_AT,
  MALLOC_STEP,
  MAX_THROTTLE,
  TIERS,
  baseCyclesPerSec,
  buyCooling,
  buyShield,
  canSpawn,
  childOutput,
  childRam,
  coolCost,
  cyclesPerSec,
  directiveById,
  doFork,
  estimateVictims,
  freeMemory,
  heatEquilibrium,
  heatMult,
  lineageMult,
  mallocCost,
  movePriority,
  newGame,
  niceCost,
  pickNextDirective,
  priorityOf,
  priorityOrder,
  ramUsed,
  sanitizeSacrificeOrder,
  shieldCost,
  spawn,
  sweepIntervalFor,
  synergyMult,
  tick,
  tierCost,
  unlockedDirectives,
} from "./sim";

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

  it("mallocCost is 150 * 1.85^step and strictly increasing", () => {
    const s = newGame();
    const costs = [0, 1, 2].map((step) => {
      s.ramCap = BASE.ramCap + step * MALLOC_STEP;
      return mallocCost(s).toNumber();
    });
    expect(costs[0]).toBeCloseTo(150, 5);
    expect(costs[1]).toBeCloseTo(277.5, 5);
    expect(costs[2]).toBeCloseTo(513.375, 5);
    expect(costs[1]).toBeGreaterThan(costs[0]);
    expect(costs[2]).toBeGreaterThan(costs[1]);
  });
});

describe("tier identity", () => {
  it("gives every tier an explicit costGrowth and trait", () => {
    expect(TIERS.map((t) => t.costGrowth)).toEqual([1.12, 1.15, 1.15, 1.18, 1.22]);
    expect(TIERS.map((t) => t.trait)).toEqual(["leak-immune", "none", "none", "none", "none"]);
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

// --- cross-tier synergy ----------------------------------------------------

describe("cross-tier synergy", () => {
  // tier indices: 2 = worker thread, 3 = microservice, 4 = cron daemon
  it("boosts workers 2% per microservice (10 workers + 5 microservices = 1.10x)", () => {
    const alone = newGame();
    alone.counts = [0, 0, 10, 0, 0];
    const mixed = newGame();
    mixed.counts = [0, 0, 10, 5, 0];

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
    s.counts = [0, 0, 0, 10, 4]; // 10 microservices, 4 cron daemons
    expect(synergyMult(s, 3)).toBeCloseTo(1 + 0.05 * 4, 10);

    const microComponent = d(TIERS[3].baseOutput).mul(10).mul(synergyMult(s, 3));
    const cronComponent = d(TIERS[4].baseOutput).mul(4);
    expect(childOutput(s).toNumber()).toBeCloseTo(microComponent.add(cronComponent).toNumber(), 6);
  });

  it("leaves tiers without a booster at 1x regardless of unrelated counts", () => {
    const s = newGame();
    s.counts = [5, 5, 5, 5, 5]; // every tier populated
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
    s.counts = [10, 10, 0, 0, 0];
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(1);
    expect(s.counts[0]).toBeLessThan(10); // tier 0 (priority 0) is hit first
    expect(s.counts[1]).toBe(10); // tier 1 untouched while tier 0 remains
  });

  it("reduces victims as `nice` rises", () => {
    const base = newGame();
    base.ramCap = 1000;
    base.counts = [100, 0, 0, 0, 0];
    base.sweepTimer = 0.001;
    tick(base, 0.01);
    const withoutNice = 100 - base.counts[0];

    const nice = newGame();
    nice.ramCap = 1000;
    nice.counts = [100, 0, 0, 0, 0];
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
    s.counts = [10, 10, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it("standard budget matches the severity formula", () => {
    const s = newGame(); // sweepsSurvived 0 -> severity 0.15, nice 0 -> mult 1
    s.counts = [100, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.budget(s, 100)).toBe(15);
  });

  it("never returns more victims than are owned", () => {
    const s = newGame();
    s.counts = [2, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 50)).toEqual([0, 0]);
  });
});

describe("sweep directives", () => {
  it("sigkill ignores nice entirely", () => {
    const noNice = newGame();
    noNice.counts = [100, 0, 0, 0, 0];
    const nice = newGame();
    nice.counts = [100, 0, 0, 0, 0];
    nice.nice = 20; // well past the floor
    const d = directiveById.get("sigkill")!;
    expect(d.budget(noNice, 100)).toBe(15);
    expect(d.budget(nice, 100)).toBe(d.budget(noNice, 100)); // nice does not reduce it
  });

  it("scavenger reaps the highest-output tier first", () => {
    const s = newGame();
    s.counts = [10, 10, 10, 10, 10];
    const d = directiveById.get("scavenger")!;
    expect(d.victims(s, 3)).toEqual([4, 4, 4]); // tier 4 has the highest baseOutput
  });

  it("group-kill reaps the densest tier first", () => {
    const s = newGame();
    s.counts = [0, 9, 2, 0, 0]; // tier 1 is densest
    const d = directiveById.get("group-kill")!;
    expect(d.victims(s, 11)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  });

  it("backpressure reclaims the leak and reaps half the usual budget", () => {
    const s = newGame();
    s.counts = [100, 0, 0, 0, 0];
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
    bare.counts = [0, 20, 0, 0, 0];
    bare.sweepTimer = 0.001;
    tick(bare, 0.01);

    const shielded = newGame();
    shielded.ramCap = 1000;
    shielded.counts = [0, 20, 0, 0, 0];
    shielded.shields = 2;
    shielded.sweepTimer = 0.001;
    tick(shielded, 0.01);

    expect(20 - bare.counts[1]).toBe(3); // standard budget at severity 0.15
    expect(20 - shielded.counts[1]).toBe(1); // exactly two victims absorbed
  });

  it("consumes charges, floors at zero, and reaps nothing when it covers the budget", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 20, 0, 0, 0];
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
    s.counts = [10, 10, 0, 0, 0];
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
    s.counts = [3, 3, 3, 3, 3];
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
    s.counts = [0, 20, 0, 0, 0]; // standard budget = round(20 * 0.15) = 3
    s.shields = 2;
    expect(estimateVictims(s)).toBe(1);

    s.shields = 100; // more charges than the budget
    expect(estimateVictims(s)).toBe(0);
    expect(estimateVictims(s)).toBeGreaterThanOrEqual(0);
  });

  it("does not mutate state", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 20, 0, 0, 0];
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
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4]);
    expect(priorityOf(s, 0)).toBe(0);
  });

  it("standard reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(s.sacrificeOrder).toEqual([1, 0, 2, 3, 4]);
    expect(directiveById.get("standard")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("sigkill reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(directiveById.get("sigkill")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("backpressure reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(directiveById.get("backpressure")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("refuses to move past either end", () => {
    const s = newGame();
    expect(movePriority(s, 0, -1)).toBe(false);
    expect(movePriority(s, 4, 1)).toBe(false);
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4]); // unchanged
  });

  it("priorityOrder reflects priorityOf", () => {
    const s = newGame();
    movePriority(s, 4, -1); // [0, 1, 2, 4, 3]
    expect(priorityOrder(s)).toEqual([0, 1, 2, 4, 3]);
  });

  it("scavenger and group-kill ignore the sacrifice order", () => {
    const s = newGame();
    s.counts = [5, 5, 5, 5, 5];
    for (let i = 0; i < 4; i++) movePriority(s, 4, -1); // tier 4 first in the player's order
    expect(s.sacrificeOrder[0]).toBe(4);
    expect(directiveById.get("scavenger")!.victims(s, 3)).toEqual([4, 4, 4]); // by output, not order
    expect(directiveById.get("group-kill")!.victims(s, 3)).toEqual([0, 0, 0]); // densest tie-break
  });
});

describe("sanitizeSacrificeOrder", () => {
  it("keeps a valid permutation", () => {
    expect(sanitizeSacrificeOrder([2, 0, 1, 3, 4])).toEqual([2, 0, 1, 3, 4]);
  });
  it("returns a fresh array, not the input or shared default", () => {
    const input = [2, 0, 1, 3, 4];
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
    s.counts = [10, 0, 0, 0, 0];
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
    s.counts = [10, 0, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    expect(() => tick(s, 0.01)).not.toThrow();
    // the fallback was actually applied: standard budget at severity 0.15, nice 0
    expect(s.counts[0]).toBe(8); // 10 - round(10 * 0.15 * 1) = 8
    expect(s.log[0]).toMatch(/^cleanup sweep \[standard\]:/);
  });

  it("applies the drawn directive end-to-end (scavenger reaps the highest-output tier)", () => {
    const s = newGame();
    s.sweepsSurvived = 6; // scavenger unlocks exactly here
    s.nextDirective = "scavenger";
    s.ramCap = 1000;
    s.counts = [1, 1, 1, 1, 1];
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
    s.counts = [0, 10, 0, 0, 0]; // 10 fork()s = 20 MB, all leak-prone
    s.ramCap = 100;
    tick(s, 10);
    expect(s.leak).toBeCloseTo(20 * 0.01 * 10, 3);
  });

  it("a leak-immune tier consumes RAM but never feeds the leak", () => {
    const s = newGame();
    s.counts = [10, 0, 0, 0, 0]; // 10 noop loops = 10 MB, leak-immune
    s.ramCap = 100;
    expect(childRam(s)).toBe(10);
    tick(s, 30); // under the sweep interval, so the counts are stable
    expect(s.leak).toBe(0);
    expect(ramUsed(s)).toBe(10); // still counted against the RAM ceiling
  });

  it("only the non-immune share of a mixed footprint leaks", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0]; // 10 MB immune + 20 MB leak-prone
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
    s.counts = [0, 10, 0, 0, 0];
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
    s.counts = [0, 0, 0, 0, 2]; // two cron daemons (16 MB each)
    s.ramCap = 16; // room for one
    tick(s, 0.01);
    expect(s.oomCount).toBe(1);
    expect(s.counts[4]).toBeLessThan(2);
    expect(ramUsed(s)).toBeLessThanOrEqual(s.ramCap);
  });

  it("applies a ~10% cycle penalty", () => {
    const s = newGame();
    s.cycles = d(1000);
    s.counts = [0, 0, 0, 0, 2];
    s.ramCap = 16;
    tick(s, 0.01);
    expect(s.cycles.toNumber()).toBeGreaterThan(890);
    expect(s.cycles.toNumber()).toBeLessThan(915);
  });

  it("bulk-drains a huge count without stalling", () => {
    const s = newGame();
    s.counts = [1e9, 0, 0, 0, 0]; // noop loop, 1 MB each
    s.ramCap = 8;
    tick(s, 0.01);
    expect(s.oomCount).toBe(1);
    expect(ramUsed(s)).toBeLessThanOrEqual(s.ramCap);
  });

  it("does not OOM when RAM is exactly at the cap", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 1]; // one cron daemon, exactly 16 MB
    s.ramCap = 16;
    tick(s, 0.01);
    expect(s.oomCount).toBe(0);
  });

  it("does not compound the penalty while a full bar leaks past the cap", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 1]; // one cron daemon = 16 MB = ramCap
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
    s.counts = [0, 0, 0, 0, 5]; // 5 cron daemons = 80 MB
    expect(heatEquilibrium(s)).toBe(80);

    s.cooling = 2; // 1 + 2 * 0.5 = 2 -> half the equilibrium
    expect(heatEquilibrium(s)).toBe(40);
  });

  it("settles at an interior equilibrium and shows a partial throttle", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 5]; // 80 MB -> equilibrium 80
    s.sweepTimer = 1e9; // freeze the sweep so the footprint is stable
    tick(s, 600); // residual 80 * e^-12
    expect(s.heat).toBeCloseTo(80, 0);
    expect(heatMult(s)).toBeCloseTo(0.75, 4);
  });

  it("a large footprint approaches saturation", () => {
    const s = newGame();
    s.ramCap = 1000;
    s.counts = [0, 0, 0, 0, 8]; // 128 MB -> equilibrium 128, above the cap
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
    s.counts = [0, 0, 0, 0, 5]; // 80 MB
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
    s.counts = [0, 0, 0, 0, 5]; // 80 MB -> equilibrium 80
    s.heat = 0;
    s.sweepTimer = 1e9;
    tick(s, 10); // 80 * (1 - e^-0.2)
    expect(s.heat).toBeCloseTo(14.5, 1);
  });

  it("clamps to [0, 100]", () => {
    const hot = newGame();
    hot.ramCap = 1000;
    hot.counts = [0, 0, 0, 0, 10]; // 160 MB -> equilibrium above the cap
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
    s.counts = [0, 0, 0, 0, 10]; // big footprint -> heat-throttled board
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
    s.counts = [0, 0, 0, 0, 10]; // childOutput 4000, +root 1 => base 4001
    expect(doFork(s)).toBe(true);
    // 4001 * 0.1, not 4001 * 1.2 * 0.1 = 480.12 (the double-count bug)
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(400.1, 5);
  });

  it("resets the working set and grants lineage plus a legacy daemon", () => {
    const s = newGame();
    s.totalEarned = d(2e6);
    s.counts = [5, 5, 0, 0, 0];
    expect(doFork(s)).toBe(true);
    expect(s.forks).toBe(1);
    expect(lineageMult(s).toNumber()).toBeCloseTo(1.1, 5);
    expect(s.counts).toEqual([0, 0, 0, 0, 0]);
    expect(s.cycles.eq(0)).toBe(true);
    expect(s.ramCap).toBe(BASE.ramCap);
    expect(s.legacy).toHaveLength(1);
    expect(s.legacy[0].rate.toNumber()).toBeGreaterThan(0);
  });

  it("clears per-run heat, cooling, and shields on fork", () => {
    const s = newGame();
    s.totalEarned = d(2e6);
    s.ramCap = 1000;
    s.counts = [5, 5, 0, 0, 0];
    s.heat = 75; // would otherwise throttle the fresh run
    s.cooling = 3;
    s.shields = 4;
    expect(doFork(s)).toBe(true);
    expect(s.heat).toBe(0);
    expect(s.cooling).toBe(0);
    expect(s.shields).toBe(0);
    expect(s.counts).toEqual([0, 0, 0, 0, 0]);
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
