import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { fmt } from "./format";
import {
  BASE,
  COST_GROWTH,
  TIERS,
  canSpawn,
  cyclesPerSec,
  directiveById,
  doFork,
  freeMemory,
  lineageMult,
  newGame,
  ramUsed,
  spawn,
  tick,
  tierCost,
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
