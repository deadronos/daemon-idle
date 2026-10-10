# 0004 — Numeric watchdog and diagnostics routing

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

Values could silently pass a type boundary: a double losing precision, a `Decimal` turning
`NaN`, a runaway loop inflating a number. The player and the developer would see a wrong
number with no signal. The question was how to detect this early and where it should
surface.

## Decision

Two small pieces, no event bus.

1. **Detection is pure and lives in the sim boundary.** `src/diagnostics.ts` exports
   `checkNumericHealth(state): Alert[]` — deterministic, no DOM, no console. Alerts carry
   `level` (`info|warn|error`), `audience` (`dev|player`), a stable `code`, a message, and
   context.
2. **Routing is a tiny reporter with pluggable sinks.** `src/report.ts` exports
   `makeReporter(sinks)` plus a `consoleSink` and a `logFeedSink`. The shell wires the sinks
   and runs the check on a ~1 s cadence, de-duplicating by `code` so an ongoing condition
   logs once.

Rules after the bignum migration (ADR 0003):

- `NaN` / non-finite Decimals → **error**, audience `player` (gameplay-facing).
- Decimal above a **runaway canary** (1e100) → **warn**, audience `dev` (a design signal,
  not a real limit).
- The remaining **plain-number** fields above `Number.MAX_SAFE_INTEGER` → **warn**, `dev`.

Surfacing: `consoleSink` for everything; player-audience alerts also go to the in-game log
feed and a HUD banner.

## Alternatives considered

- **Event bus / pub-sub** — rejected: one producer (the health check) and a few consumers.
  A reporter fanning out to sinks is enough; a bus earns its keep only with many producers.
- **Throw on breach** — rejected: would crash the game instead of degrading gracefully.
- **No surfacing (log only in dev)** — rejected: a player-facing breach (e.g. NaN progress)
  should be visible to the player, not just the console.

## Consequences

- **Positive:** an early, testable canary; audience routing keeps developer noise out of the
  player's face; the boundary respects doc 000 (pure detection in the sim, impure sinks in
  the shell).
- **Negative:** thresholds must be maintained; the check is a safety net, not a fix — the
  real answer to a boundary is not to reach it.
- **Follow-ups:** add sinks (telemetry) only when a real consumer exists.
