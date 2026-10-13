// Pure repeatable-upgrade logic for `daemon`. No DOM and no runtime `GameState` import —
// the helpers read a narrow `RepeatableInput`. Mutating actions and the formula
// integration live in `src/sim.ts`.

import { d, type Decimal } from "./bignum";
import {
  REPEATABLES,
  repeatableById,
  type RepeatableId,
  type RepeatableMods,
} from "./config/repeatables";

export * from "./config/repeatables";

/** The slice of game state the repeatable helpers read. `GameState` satisfies it. */
export interface RepeatableInput {
  repeatables: Record<RepeatableId, number>;
  cycles: Decimal;
}

export type ModOp = "add" | "multiply" | "divide";

/** How each aggregate field is folded from a row's per-level magnitude. */
export const REPEATABLE_MOD_KIND: Record<keyof RepeatableMods, ModOp> = {
  incomeMult: "multiply",
  ramCapAdd: "add",
  tierCostMult: "divide",
  heatGenMult: "divide",
};

/** Aggregate fields that are `Decimal` rather than plain numbers. */
const DECIMAL_MODS = new Set<keyof RepeatableMods>(["incomeMult"]);

/**
 * Fold every owned level into one aggregate. Pure and cheap (4 rows), so callers may
 * invoke it freely. Each row contributes `perLevel * sqrt(level)`; the exponential cost
 * curve keeps the effect sub-linear in total spend.
 */
export function repeatableMods(s: Pick<RepeatableInput, "repeatables">): RepeatableMods {
  const m: RepeatableMods = {
    incomeMult: d(1),
    ramCapAdd: 0,
    tierCostMult: 1,
    heatGenMult: 1,
  };
  const mm = m as unknown as Record<keyof RepeatableMods, Decimal | number>;
  for (const r of REPEATABLES) {
    const level = s.repeatables[r.id] ?? 0;
    if (level <= 0) continue;
    const mag = r.perLevel * Math.sqrt(level);
    const op = REPEATABLE_MOD_KIND[r.mod];
    if (DECIMAL_MODS.has(r.mod)) {
      const cur = mm[r.mod] as Decimal;
      mm[r.mod] = op === "multiply" ? cur.mul(1 + mag) : cur.add(mag);
    } else {
      const cur = mm[r.mod] as number;
      mm[r.mod] =
        op === "multiply" ? cur * (1 + mag) : op === "divide" ? cur / (1 + mag) : cur + mag;
    }
  }
  return m;
}

/** Cost of the next level of `id`; `0` for an unknown id. */
export function repeatableCost(s: Pick<RepeatableInput, "repeatables">, id: RepeatableId): Decimal {
  const def = repeatableById(id);
  if (!def) return d(0);
  const level = s.repeatables[id] ?? 0;
  return d(def.baseCost).mul(d(def.costGrowth).pow(level));
}

/** True when `id` exists and `cycles` covers the next level. Unbounded in level. */
export function canBuyRepeatable(s: RepeatableInput, id: RepeatableId): boolean {
  const def = repeatableById(id);
  if (!def) return false;
  return s.cycles.gte(repeatableCost(s, id));
}
