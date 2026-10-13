import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  REPEATABLES,
  REPEATABLE_MOD_KIND,
  canBuyRepeatable,
  repeatableById,
  repeatableCost,
  repeatableMods,
  type RepeatableInput,
} from "./repeatables";

const s = (over: Partial<RepeatableInput> = {}): RepeatableInput => ({
  repeatables: {},
  cycles: d(0),
  ...over,
});

describe("repeatable roster", () => {
  it("has unique ids, real mods, and an exponential cost curve", () => {
    const ids = REPEATABLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(REPEATABLES).toHaveLength(4);
    for (const r of REPEATABLES) {
      expect(r.mod in REPEATABLE_MOD_KIND).toBe(true);
      expect(r.costGrowth).toBeGreaterThan(1);
      expect(r.perLevel).toBeGreaterThan(0);
    }
    expect(repeatableById("overclock")?.mod).toBe("incomeMult");
    expect(repeatableById("bulk")?.mod).toBe("tierCostMult");
  });
});

describe("repeatableMods (diminishing returns)", () => {
  it("is identity at level 0", () => {
    const m = repeatableMods(s());
    expect(m.incomeMult.toNumber()).toBe(1);
    expect(m.ramCapAdd).toBe(0);
    expect(m.tierCostMult).toBe(1);
    expect(m.heatGenMult).toBe(1);
  });

  it("folds perLevel * sqrt(level) with the right op per mod", () => {
    const m = repeatableMods(
      s({ repeatables: { overclock: 4, swapfile: 4, undervolt: 4, bulk: 4 } }),
    );
    expect(m.incomeMult.toNumber()).toBeCloseTo(1 + 0.1 * 2, 10); // 1.2
    expect(m.ramCapAdd).toBeCloseTo(4 * 2, 10); // 8
    expect(m.heatGenMult).toBeCloseTo(1 / (1 + 0.08 * 2), 10);
    expect(m.tierCostMult).toBeCloseTo(1 / (1 + 0.05 * 2), 10);
  });
});

describe("repeatableCost", () => {
  it("grows exponentially with level and is 0 for an unknown id", () => {
    expect(repeatableCost(s(), "overclock").toNumber()).toBeCloseTo(1e6, 0);
    expect(
      repeatableCost(s({ repeatables: { overclock: 3 } }), "overclock").toNumber(),
    ).toBeCloseTo(1e6 * 1.6 ** 3, 0);
    expect(repeatableCost(s(), "nope").toNumber()).toBe(0);
  });
});

describe("canBuyRepeatable", () => {
  it("is affordability-gated, unbounded in level, and refuses unknown ids", () => {
    expect(canBuyRepeatable(s({ cycles: d(1e6) }), "overclock")).toBe(true);
    expect(canBuyRepeatable(s({ cycles: d(1e6 - 1) }), "overclock")).toBe(false);
    expect(canBuyRepeatable(s({ cycles: d(1e9) }), "nope")).toBe(false);
  });
});
