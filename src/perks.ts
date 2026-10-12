// Pure perk-tree logic for `daemon`. No DOM, no `GameState` import at runtime — the
// helpers read a narrow `PerkInput` so they stay testable and cycle-free.
//
// Mutating actions (`buyPerk`) and the formula integration live in `src/sim.ts`.

import { d, type Decimal } from "./bignum";
import { PERKS, FORK_COST_FLOOR, perkById, type PerkId, type PerkMods } from "./config/perks";

export * from "./config/perks";

/** The slice of game state the perk helpers read. `GameState` satisfies it structurally. */
export interface PerkInput {
  perks: Record<PerkId, number>;
  lineage: number;
  playtime: number;
  runStartPlaytime: number;
  totalEarned: Decimal;
  runBaseEarned: Decimal;
}

export type ModOp = "add" | "multiply" | "divide";

/** How each aggregate field is folded from a node's per-level magnitude. */
export const MOD_KIND: Record<keyof PerkMods, ModOp> = {
  incomeMult: "multiply",
  rootMult: "multiply",
  tierCostMult: "divide",
  niceAdd: "add",
  ramCapAdd: "add",
  heatGenMult: "divide",
  startShieldsAdd: "add",
  forkCostMult: "divide",
  pointsMult: "multiply",
  legacyRateMult: "multiply",
  startCycles: "add",
};

/** Aggregate fields that are `Decimal` rather than plain numbers. */
const DECIMAL_MODS = new Set<keyof PerkMods>([
  "incomeMult",
  "rootMult",
  "legacyRateMult",
  "startCycles",
]);

/** Points to buy the next level of `id`; `0` for an unknown id. Integer, rounded up. */
export function perkCost(s: PerkInput, id: PerkId): number {
  const def = perkById(id);
  if (!def) return 0;
  const level = s.perks[id] ?? 0;
  return Math.ceil(def.costBase * def.costRate ** level);
}

/** True when `id` exists, is below its level cap, has its prerequisite, and is affordable. */
export function canBuyPerk(s: PerkInput, id: PerkId): boolean {
  const def = perkById(id);
  if (!def) return false;
  const level = s.perks[id] ?? 0;
  if (level >= def.maxLevel) return false;
  if (def.requires && (s.perks[def.requires] ?? 0) < 1) return false;
  return s.lineage >= perkCost(s, id);
}

/**
 * Fold every purchased perk level into one aggregate. Pure and cheap (<=15 nodes), so
 * callers may invoke it freely. Each node contributes `perLevel * sqrt(level)`; distinct
 * perks only reach level 1, sinks gain sub-linearly forever.
 */
export function perkMods(s: PerkInput): PerkMods {
  const m: PerkMods = {
    incomeMult: d(1),
    rootMult: d(1),
    tierCostMult: 1,
    niceAdd: 0,
    ramCapAdd: 0,
    heatGenMult: 1,
    startShieldsAdd: 0,
    forkCostMult: 1,
    pointsMult: 1,
    legacyRateMult: d(1),
    startCycles: d(0),
  };

  const mm = m as unknown as Record<keyof PerkMods, Decimal | number>;

  for (const p of PERKS) {
    const level = s.perks[p.id] ?? 0;
    if (level <= 0) continue;
    const mag = p.perLevel * Math.sqrt(level);
    const op = MOD_KIND[p.mod];
    if (DECIMAL_MODS.has(p.mod)) {
      const cur = mm[p.mod] as Decimal;
      mm[p.mod] = op === "multiply" ? cur.mul(1 + mag) : cur.add(mag);
    } else {
      const cur = mm[p.mod] as number;
      mm[p.mod] = op === "multiply" ? cur * (1 + mag) : op === "divide" ? cur / (1 + mag) : cur + mag;
    }
  }

  m.forkCostMult = Math.max(FORK_COST_FLOOR, m.forkCostMult);
  return m;
}
