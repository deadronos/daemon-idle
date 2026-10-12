import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  MILESTONES,
  UNLOCK,
  METRICS,
  evaluateMilestones,
  hasUnlock,
  milestoneById,
  milestoneMet,
  milestoneProgress,
  orderedMilestones,
  type MilestoneInput,
} from "./milestones";

const base = (over: Partial<MilestoneInput> = {}): MilestoneInput => ({
  totalEarned: d(0),
  sweepsSurvived: 0,
  forks: 0,
  playtime: 0,
  counts: [0, 0, 0, 0, 0],
  ramCap: 8,
  milestonesDone: {},
  unlocks: {},
  ...over,
});

describe("milestone roster", () => {
  it("has unique ids, real metrics, positive thresholds, and non-empty unlocks", () => {
    const ids = MILESTONES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MILESTONES) {
      expect(m.metric in METRICS).toBe(true);
      expect(m.at).toBeGreaterThan(0);
      expect(m.unlocks.length).toBeGreaterThan(0);
    }
    expect(milestoneById("first-blood")?.unlocks).toEqual([UNLOCK.nice]);
    expect(milestoneById("grown-up")?.unlocks).toEqual([UNLOCK.gc]);
  });
});

describe("METRICS", () => {
  it("reads the expected value from state", () => {
    const s = base({
      totalEarned: d(1234),
      sweepsSurvived: 3,
      forks: 2,
      playtime: 9,
      counts: [1, 2, 0, 0, 0],
      ramCap: 24,
    });
    expect(METRICS.totalEarned(s)).toBe(1234);
    expect(METRICS.sweepsSurvived(s)).toBe(3);
    expect(METRICS.forks(s)).toBe(2);
    expect(METRICS.playtime(s)).toBe(9);
    expect(METRICS.children(s)).toBe(3);
    expect(METRICS.ramCap(s)).toBe(24);
  });
});

describe("milestoneMet / milestoneProgress", () => {
  it("is met at and above the threshold, not below", () => {
    const def = milestoneById("first-blood")!; // sweepsSurvived >= 1
    expect(milestoneMet(base({ sweepsSurvived: 0 }), def)).toBe(false);
    expect(milestoneMet(base({ sweepsSurvived: 1 }), def)).toBe(true);
    expect(milestoneMet(base({ sweepsSurvived: 5 }), def)).toBe(true);
  });

  it("clamps progress to [0, 1] and is finite for a huge totalEarned", () => {
    const grown = milestoneById("grown-up")!; // ramCap >= 24
    expect(milestoneProgress(base({ ramCap: 0 }), grown)).toBe(0);
    expect(milestoneProgress(base({ ramCap: 12 }), grown)).toBeCloseTo(0.5, 6);
    expect(milestoneProgress(base({ ramCap: 48 }), grown)).toBe(1);
    const earn = {
      id: "x",
      name: "x",
      desc: "",
      metric: "totalEarned" as const,
      at: 100,
      unlocks: ["u"],
    };
    const p = milestoneProgress(base({ totalEarned: d("1e1000") }), earn);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBe(1);
  });
});

describe("evaluateMilestones", () => {
  it("fires a met milestone once, grants its unlocks, and is idempotent", () => {
    const s = base({ sweepsSurvived: 1 });
    expect(evaluateMilestones(s)).toEqual(["first-blood"]);
    expect(s.milestonesDone["first-blood"]).toBe(true);
    expect(s.unlocks.nice).toBe(true);
    expect(evaluateMilestones(s)).toEqual([]); // already done
  });

  it("does not fire an unmet milestone", () => {
    const s = base();
    expect(evaluateMilestones(s)).toEqual([]);
    expect(hasUnlock(s, "nice")).toBe(false);
  });

  it("stays fired when a non-monotonic metric later drops", () => {
    const s = base({ sweepsSurvived: 1 });
    evaluateMilestones(s);
    s.sweepsSurvived = 0; // metric drops below the threshold
    expect(evaluateMilestones(s)).toEqual([]);
    expect(s.milestonesDone["first-blood"]).toBe(true);
    expect(hasUnlock(s, "nice")).toBe(true);
  });
});

describe("orderedMilestones", () => {
  it("orders pending by progress descending, then achieved last", () => {
    const idx = (ids: string[], id: string) => ids.indexOf(id);
    // ramCap 0 -> first-blood and grown-up both pending at 0 progress -> roster order
    const flat = orderedMilestones(base({ ramCap: 0 })).map((m) => m.id);
    expect(idx(flat, "first-blood")).toBeLessThan(idx(flat, "grown-up"));
    // ramCap 12 -> grown-up is closer to firing -> ahead of first-blood
    const closer = orderedMilestones(base({ ramCap: 12 })).map((m) => m.id);
    expect(idx(closer, "grown-up")).toBeLessThan(idx(closer, "first-blood"));
    // achieved goals sort below pending ones
    const done = orderedMilestones(
      base({ ramCap: 12, milestonesDone: { "first-blood": true } }),
    ).map((m) => m.id);
    expect(idx(done, "grown-up")).toBeLessThan(idx(done, "first-blood"));
  });
});
