import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { PERKS, type PerkInput, perkById, perkCost, canBuyPerk } from "./perks";

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
