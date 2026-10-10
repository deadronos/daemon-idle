// Big-number boundary for `daemon`.
//
// Every value that can grow without bound goes through this module, so the
// underlying library can be swapped in one place. Backed by break_eternity.js
// (idle-game-native; scales to 10^^1e308). See
// docs/decisions/0003-bignum-break-eternity.md.

import Decimal from "break_eternity.js";

export { Decimal };
export type Num = Decimal;

/** Coerce a number, string, or Decimal into a Decimal (no copy if already one). */
export function d(value: Decimal | number | string): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export const D0 = new Decimal(0);
export const D1 = new Decimal(1);
