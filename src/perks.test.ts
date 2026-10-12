import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  PERKS,
  type PerkInput,
  perkById,
  perkCost,
  canBuyPerk,
  perkMods,
  MOD_KIND,
  pointsForFork,
  DEPTH_CAP,
  MAX_POINTS_PER_FORK,
} from "./perks";

const base = (over: Partial<PerkInput> = {}): PerkInput => ({
  perks: {},
  lineage: 0,
  playtime: 0,
  runStartPlaytime: 0,
  totalEarned: d(0),
  runBaseEarned: d(0),
  ...over,
});

describe("perk roster", () => {
  it("has unique ids and resolves every prerequisite to a real perk", () => {
    const ids = PERKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PERKS) if (p.requires) expect(perkById(p.requires)).toBeDefined();
  });
  it("has exactly one sink (maxLevel Infinity) per branch", () => {
    for (const branch of ["growth", "survival", "lineage"] as const) {
      expect(PERKS.filter((p) => p.branch === branch && p.maxLevel === Infinity)).toHaveLength(1);
    }
  });
});

describe("perkCost", () => {
  it("is flat for distinct perks and ceiling-rounded geometric for sinks", () => {
    const s = base();
    expect(perkCost(s, "spin")).toBe(2);
    expect(perkCost(base({ perks: { spin: 1 } }), "tailcall")).toBe(5);
    expect(perkCost(base({ perks: { pipeline: 0 } }), "pipeline")).toBe(3);
    expect(perkCost(base({ perks: { pipeline: 1 } }), "pipeline")).toBe(5); // ceil(3*1.6)
    expect(perkCost(base({ perks: { pipeline: 3 } }), "pipeline")).toBe(13); // ceil(3*1.6^3)
  });
});

describe("canBuyPerk", () => {
  it("requires the prerequisite, the level cap, and affordable lineage", () => {
    expect(canBuyPerk(base({ lineage: 2 }), "spin")).toBe(true);
    expect(canBuyPerk(base({ lineage: 1 }), "spin")).toBe(false); // unaffordable
    expect(canBuyPerk(base({ lineage: 5 }), "tailcall")).toBe(false); // needs `spin`
    expect(canBuyPerk(base({ perks: { spin: 1 }, lineage: 5 }), "tailcall")).toBe(true);
    expect(canBuyPerk(base({ perks: { spin: 1 }, lineage: 99 }), "spin")).toBe(false); // maxLevel 1
    expect(canBuyPerk(base({ lineage: 99 }), "pipeline")).toBe(false); // sink still needs its prereq
    expect(canBuyPerk(base({ perks: { spin: 1, prefetch: 1 }, lineage: 99 }), "pipeline")).toBe(true); // sink repeatable
    expect(canBuyPerk(base({ lineage: 99 }), "nope")).toBe(false); // unknown id
  });
});

describe("perkMods", () => {
  it("is identity with no perks", () => {
    const m = perkMods(base());
    expect(m.incomeMult.toNumber()).toBe(1);
    expect(m.rootMult.toNumber()).toBe(1);
    expect(m.tierCostMult).toBe(1);
    expect(m.niceAdd).toBe(0);
    expect(m.heatGenMult).toBe(1);
    expect(m.startShieldsAdd).toBe(0);
    expect(m.forkCostMult).toBe(1);
    expect(m.pointsMult).toBe(1);
    expect(m.legacyRateMult.toNumber()).toBe(1);
    expect(m.startCycles.toNumber()).toBe(0);
  });

  it("multiplies increase mods, divides reductions, and adds flat mods", () => {
    const s = base({ perks: { spin: 1, prefetch: 1, tailcall: 1, renice: 1, heatsink: 1 } });
    const m = perkMods(s);
    expect(m.incomeMult.toNumber()).toBeCloseTo(1.1 * 1.15, 6);
    expect(m.tierCostMult).toBeCloseTo(1 / 1.08, 6);
    expect(m.heatGenMult).toBeCloseTo(1 / 1.1, 6);
    expect(m.niceAdd).toBe(1);
  });

  it("uses sqrt for sink levels and floors forkCostMult", () => {
    expect(perkMods(base({ perks: { pipeline: 4 } })).incomeMult.toNumber()).toBeCloseTo(1 + 0.1 * 2, 6);
    const cheap = perkMods(base({ perks: { cheapfork: 1 } }));
    expect(cheap.forkCostMult).toBeLessThan(1);
    expect(cheap.forkCostMult).toBeGreaterThanOrEqual(0.25);
    expect(Object.values(MOD_KIND)).toHaveLength(Object.keys(perkMods(base())).length);
  });

  it("makes `vec` double the root multiplier", () => {
    expect(perkMods(base({ perks: { vec: 1 } })).rootMult.toNumber()).toBe(2);
  });
});

describe("pointsForFork", () => {
  it("grants nothing for an instant fork", () => {
    expect(pointsForFork(base())).toBe(0);
  });

  it("gates only the flat base; a sub-threshold run gets depth alone", () => {
    const below = base({ playtime: 30, totalEarned: d(1e6) }); // 30s < 60 -> no flat base
    expect(pointsForFork(below)).toBe(Math.floor(2 * (Math.sqrt(30 / 300) + 1))); // 2
    const above = base({ playtime: 300, totalEarned: d(1e6) }); // qualifies -> +1
    expect(pointsForFork(above)).toBe(Math.floor(2 * (Math.sqrt(1) + 1)) + 1); // 5
  });

  it("increases monotonically with deeper, longer runs", () => {
    const shallow = pointsForFork(base({ playtime: 300, totalEarned: d(1e6) }));
    const deep = pointsForFork(base({ playtime: 900, totalEarned: d(1e9) }));
    expect(deep).toBeGreaterThan(shallow);
  });

  it("clamps a huge Decimal runEarned and never returns Infinity", () => {
    const s = base({ playtime: 1000, totalEarned: d("1e1000") });
    const p = pointsForFork(s);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThanOrEqual(MAX_POINTS_PER_FORK);
    expect(p).toBe(Math.floor(2 * (Math.sqrt(1000 / 300) + DEPTH_CAP)) + 1);
  });
});
