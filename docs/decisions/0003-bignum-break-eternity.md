# 0003 — Big-number core: break_eternity.js

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The simulation stored every value as a JS `number` (double). Doubles stop representing
integers exactly past 2^53 (~9.007e15), and an idle game's whole design is unbounded growth
(`1.15^n` costs, exponential income, prestige multipliers). The game was only at ~1e6, so
nothing was broken yet — but any extension pushes toward the precision cliff, and the
retrofit cost only grows as more mechanics depend on the numeric type.

## Decision

Adopt **break_eternity.js 2.1.3** as the numeric core, wrapped behind `src/bignum.ts` so the
library is swappable in one place.

- **Decimal** (from `bignum`) for unbounded values: `cycles`, `totalEarned`, tier costs,
  child output, upgrade costs, legacy daemon rates, the lineage multiplier.
- **Plain `number`** for bounded values: `counts`, `ramCap`, `leak`, `nice`, `gc`, timers,
  `playtime`.
- Save format serializes Decimals as strings (see doc 003).

**Important property:** break_eternity is a _float mantissa + exponent_ representation
(`sign`/`mag`/`layer`), not arbitrary precision. It gives enormous **range** (up to
10^^1e308) with ~15 significant digits. It does **not** keep exact integers past 2^53 — and
for an idle game that is the right trade: you care about magnitude, not the low digits.

## Alternatives considered

- **break_infinity.js** — the classic idle lib, but last published 2023 and a smaller range;
  break_eternity is its maintained successor and a superset.
- **decimal.js / big.js** — arbitrary precision, but decimal-oriented (no cheap huge
  exponent) and heavier/slower per op. Wrong shape for an idle game.
- **BigInt** — exact, but no fractional or exponent representation; every scaling op would
  need hand-rolled logic.
- **Do nothing** — acceptable short-term, rejected because the retrofit cost rises with
  every new mechanic.

## Consequences

- **Positive:** unbounded scaling with no precision cliff; the boundary is one module, so a
  future library swap touches only `src/bignum.ts`; the test suite guards the refactor.
- **Negative:** a dependency, and the production bundle grew from ~10 KB to ~69 KB
  (~19 KB gzipped); every arithmetic op is heavier (fine at a 20 Hz tick); values carry ~15
  significant digits, so low-digit exactness is not preserved; saves now store Decimals as
  strings.
- **Follow-ups:** the numeric watchdog (ADR 0004) was re-scoped: the "exceeds double
  precision" rule is retired, replaced by NaN/Infinity, a runaway canary, and checks on the
  remaining plain-number fields.
