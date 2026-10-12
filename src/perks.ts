// Pure perk-tree logic for `daemon`. No DOM, no `GameState` import at runtime — the
// helpers read a narrow `PerkInput` so they stay testable and cycle-free.
//
// Mutating actions (`buyPerk`) and the formula integration live in `src/sim.ts`.

import type { Decimal } from "./bignum";
import { perkById, type PerkId } from "./config/perks";

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
