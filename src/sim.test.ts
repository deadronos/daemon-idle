import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { fmt } from "./format";
import {
  BASE,
  COST_GROWTH,
  DEFAULT_SACRIFICE_ORDER,
  TIERS,
  canSpawn,
  cyclesPerSec,
  directiveById,
  doFork,
  freeMemory,
  lineageMult,
  movePriority,
  newGame,
  pickNextDirective,
  priorityOf,
  priorityOrder,
  ramUsed,
  sanitizeSacrificeOrder,
  spawn,
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
  it("grows a tier cost by COST_GROWTH per purchase", () => {
    const s = newGame();
    s.cycles = d(1e6);
    const first = tierCost(s, 0);
    spawn(s, 0);
    expect(tierCost(s, 0).div(first).toNumber()).toBeCloseTo(COST_GROWTH, 5);
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
    const a = newGame(); a.rngState = 12345; a.sweepsSurvived = 20;
    const b = newGame(); b.rngState = 12345; b.sweepsSurvived = 20;
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
    s.counts = [10, 0, 0, 0, 0]; s.ramCap = 1000; s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(s.nextDirective);
  });

  it("still advances with no children to reap", () => {
    const s = newGame();
    s.sweepsSurvived = 20; s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(s.nextDirective);
  });

  it("falls back to standard for an unknown loaded directive id", () => {
    const s = newGame();
    (s as unknown as { nextDirective: string }).nextDirective = "bogus";
    s.counts = [10, 0, 0, 0, 0]; s.ramCap = 1000; s.sweepTimer = 0.001;
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
  it("grows the leak at 1% of footprint per second", () => {
    const s = newGame();
    s.counts = [10, 0, 0, 0, 0]; // 10 MB footprint
    s.ramCap = 100;
    tick(s, 10);
    expect(s.leak).toBeCloseTo(10 * 0.01 * 10, 3);
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
    s.counts = [10, 0, 0, 0, 0];
    s.ramCap = 100;
    s.gc = 2;
    tick(s, 10);
    expect(s.leak).toBeLessThan(0.2);
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
});

// --- prestige --------------------------------------------------------------

describe("prestige", () => {
  it("refuses to fork below the threshold", () => {
    const s = newGame();
    expect(doFork(s)).toBe(false);
    expect(s.forks).toBe(0);
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
