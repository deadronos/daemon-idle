// Numeric health checks. Pure: reads a GameState, returns Alerts. No DOM, no console.
// Surfacing is the shell's job (see ./report.ts and main.ts).

import type { Decimal } from "./bignum";
import { TIERS, type GameState, cyclesPerSec, ramUsed, tierCost } from "./sim";

export type Level = "info" | "warn" | "error";
export type Audience = "dev" | "player";

export interface Alert {
  level: Level;
  /** Who should see it: `dev` is a design/canary signal, `player` is gameplay-facing. */
  audience: Audience;
  code: string;
  message: string;
  context?: Record<string, string | number>;
}

/** Number-typed fields stop being exact past this. */
const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER; // 2^53 - 1
/** A canary far above intended play — flags runaway growth, not a real limit. */
const RUNAWAY = 1e100;

/**
 * Inspect the unbounded (Decimal) and bounded (number) values in a game state.
 *
 * After the bignum migration, large Decimals are expected — the "exceeds double
 * precision" rule is retired. What remains: NaN/Infinity (always a bug), runaway
 * growth (a canary), and the plain-number fields that are still bounded.
 */
export function checkNumericHealth(s: GameState): Alert[] {
  const alerts: Alert[] = [];

  const checkDecimal = (name: string, v: Decimal): void => {
    if (v.isNan()) {
      alerts.push({
        level: "error",
        audience: "player",
        code: `numeric.nan.${name}`,
        message: `${name} is NaN`,
        context: { [name]: "NaN" },
      });
      return;
    }
    if (!v.isFinite()) {
      alerts.push({
        level: "error",
        audience: "player",
        code: `numeric.infinite.${name}`,
        message: `${name} is not finite`,
        context: { [name]: v.toString() },
      });
      return;
    }
    if (v.gt(RUNAWAY)) {
      alerts.push({
        level: "warn",
        audience: "dev",
        code: `numeric.runaway.${name}`,
        message: `${name} passed the runaway canary (${RUNAWAY})`,
        context: { [name]: v.toString() },
      });
    }
  };

  const checkNumber = (name: string, n: number): void => {
    if (!Number.isFinite(n)) {
      alerts.push({
        level: "error",
        audience: "player",
        code: `numeric.nan.${name}`,
        message: `${name} is not finite`,
        context: { [name]: String(n) },
      });
      return;
    }
    if (n > MAX_SAFE_INT) {
      alerts.push({
        level: "warn",
        audience: "dev",
        code: `numeric.precision.${name}`,
        message: `${name} exceeded Number.MAX_SAFE_INTEGER`,
        context: { [name]: n },
      });
    }
  };

  // unbounded values (Decimal)
  checkDecimal("cycles", s.cycles);
  checkDecimal("totalEarned", s.totalEarned);
  checkDecimal("cyclesPerSec", cyclesPerSec(s));
  checkDecimal("topTierCost", tierCost(s, TIERS.length - 1));
  for (const dm of s.legacy) checkDecimal(`legacy.${dm.name}`, dm.rate);

  // bounded values (number) — still worth guarding
  checkNumber("ramUsed", ramUsed(s));
  checkNumber("leak", s.leak);
  checkNumber("playtime", s.playtime);
  checkNumber("sweepTimer", s.sweepTimer);

  return alerts;
}
