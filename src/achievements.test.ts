import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { METRICS, type MetricInput } from "./milestones";
import {
  ACHIEVEMENTS,
  achievementById,
  achievementMet,
  achievementMult,
  achievementProgress,
  evaluateAchievements,
  orderedAchievements,
  type AchievementDef,
  type AchievementInput,
} from "./achievements";

const base = (over: Partial<AchievementInput> = {}): AchievementInput => ({
  totalEarned: d(0),
  sweepsSurvived: 0,
  forks: 0,
  playtime: 0,
  counts: [0, 0, 0, 0, 0],
  ramCap: 8,
  achievementsDone: {},
  ...over,
});

describe("achievement roster", () => {
  it("has unique ids, real metrics, positive thresholds, and small positive multipliers", () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.metric in METRICS).toBe(true);
      expect(a.at).toBeGreaterThan(0);
      expect(a.mult).toBeGreaterThan(0);
      expect(a.mult).toBeLessThanOrEqual(0.05);
    }
    expect(achievementById("first-earnings")?.metric).toBe("totalEarned");
  });
});

describe("METRICS reads a bare MetricInput (refactor)", () => {
  it("reads the six readers without milestone/achievement records", () => {
    const m: MetricInput = {
      totalEarned: d(5),
      sweepsSurvived: 1,
      forks: 2,
      playtime: 3,
      counts: [1, 0, 0, 0, 0],
      ramCap: 8,
    };
    expect(METRICS.totalEarned(m)).toBe(5);
    expect(METRICS.children(m)).toBe(1);
    expect(METRICS.forks(m)).toBe(2);
  });
});

describe("achievementMet / achievementProgress", () => {
  const def: AchievementDef = {
    id: "x",
    name: "x",
    desc: "",
    metric: "ramCap",
    at: 64,
    mult: 0.02,
  };
  it("is met at and above the threshold, not below", () => {
    expect(achievementMet(base({ ramCap: 63 }), def)).toBe(false);
    expect(achievementMet(base({ ramCap: 64 }), def)).toBe(true);
  });
  it("clamps progress to [0, 1]", () => {
    expect(achievementProgress(base({ ramCap: 32 }), def)).toBeCloseTo(0.5, 6);
    expect(achievementProgress(base({ ramCap: 128 }), def)).toBe(1);
  });
  it("stays finite and clamped for a huge totalEarned (Decimal overflow)", () => {
    const huge: AchievementDef = {
      id: "h",
      name: "h",
      desc: "",
      metric: "totalEarned",
      at: 1e9,
      mult: 0.02,
    };
    expect(achievementProgress(base({ totalEarned: d("1e400") }), huge)).toBe(1);
  });
});

describe("evaluateAchievements", () => {
  it("fires a met achievement once, is sticky and idempotent", () => {
    const s = base({ totalEarned: d(1e3) });
    expect(evaluateAchievements(s)).toContain("first-earnings");
    expect(s.achievementsDone["first-earnings"]).toBe(true);
    expect(evaluateAchievements(s)).toEqual([]); // idempotent
    s.totalEarned = d(0); // non-monotonic drop
    expect(s.achievementsDone["first-earnings"]).toBe(true); // sticky
  });
});

describe("achievementMult", () => {
  it("is 1 with none earned and the product of (1 + mult) over earned ids", () => {
    expect(achievementMult(base()).toNumber()).toBe(1);
    const a = achievementById("first-earnings")!;
    const b = achievementById("grinder")!;
    const s = base({ achievementsDone: { [a.id]: true, [b.id]: true } });
    expect(achievementMult(s).toNumber()).toBeCloseTo((1 + a.mult) * (1 + b.mult), 10);
  });
});

describe("orderedAchievements", () => {
  it("orders pending by progress descending, then earned last", () => {
    const idx = (ids: string[], id: string) => ids.indexOf(id);
    // ramCap 8 -> headroom pending at 8/64 = 0.125; totalEarned 1e3 -> first-earnings earned
    const done = orderedAchievements(
      base({ totalEarned: d(1e3), achievementsDone: { "first-earnings": true } }),
    ).map((a) => a.id);
    expect(idx(done, "headroom")).toBeLessThan(idx(done, "first-earnings"));
  });
});
