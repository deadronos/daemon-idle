// Repeatable-upgrade data and types for `daemon`.
//
// Pure data + types, no runtime imports (the `Decimal` import is type-only and erased),
// so this stays a leaf module that `src/repeatables.ts` reads.

import type { Decimal } from "../bignum";

export type RepeatableId = string;

/** Aggregate of every owned repeatable, applied by the sim. One field per effect kind. */
export interface RepeatableMods {
  incomeMult: Decimal; // multiply, >= 1
  ramCapAdd: number; // add, >= 0
  tierCostMult: number; // divide in (0, 1]
  heatGenMult: number; // divide in (0, 1]
}

export interface RepeatableDef {
  id: RepeatableId;
  name: string;
  desc: string;
  baseCost: number;
  costGrowth: number; // per-level cost multiplier (exponential)
  mod: keyof RepeatableMods; // which aggregate field this row feeds
  perLevel: number; // magnitude per level (interpreted via REPEATABLE_MOD_KIND)
}

export const REPEATABLES: RepeatableDef[] = [
  {
    id: "overclock",
    name: "overclock",
    desc: "+income, sub-linear",
    baseCost: 1e6,
    costGrowth: 1.6,
    mod: "incomeMult",
    perLevel: 0.1,
  },
  {
    id: "swapfile",
    name: "swapfile",
    desc: "+RAM cap, sub-linear",
    baseCost: 5e6,
    costGrowth: 1.7,
    mod: "ramCapAdd",
    perLevel: 4,
  },
  {
    id: "undervolt",
    name: "undervolt",
    desc: "-heat equilibrium, sub-linear",
    baseCost: 2e6,
    costGrowth: 1.6,
    mod: "heatGenMult",
    perLevel: 0.08,
  },
  {
    id: "bulk",
    name: "bulk discount",
    desc: "spawns get cheaper as you buy in bulk",
    baseCost: 2e6,
    costGrowth: 1.7,
    mod: "tierCostMult",
    perLevel: 0.05,
  },
];

export function repeatableById(id: RepeatableId): RepeatableDef | undefined {
  return REPEATABLES.find((r) => r.id === id);
}
