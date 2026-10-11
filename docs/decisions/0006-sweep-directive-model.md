# 0006 — Sweep directive model

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The cleanup sweep was a single flat rule: reap a severity-scaled, `nice`-reduced number of
children in a fixed per-tier order, every sweep, forever. The only counter was the `nice`
upgrade, so the sweep never changed shape as the game progressed, and nothing in the UI could
tell the player _what_ was about to happen — only that a sweep was coming. Balance and tests
were pinned to that one rule (`src/sim.ts` `runSweep`, `sweepVictimMult`).

## Decision

Replace the flat rule with a roster of named **directives** (`DIRECTIVES`,
`SweepDirective`, `directiveById` in `src/sim.ts`). Each directive carries its own
`unlockAt`, `ignoresNice`, `budget(s, total)` fraction, `victims(s, budget)` selection, and
an optional `pre(s)` side effect. The five directives are `standard` (unlockAt 0, frac 1,
player order, `nice` applies), `sigkill` (3, frac 1, player order, `nice` ignored),
`scavenger` (6, frac 0.6, highest `baseOutput` first), `group-kill` (10, frac 1, densest tier
first), and `backpressure` (15, frac 0.5, player order, zeroes the leak).

- Escalation is deterministic: the unlocked pool is
  `DIRECTIVES.filter(d => d.unlockAt <= sweepsSurvived)` (thresholds **inclusive**).
- Selection is a seeded, previewable draw: `runSweep` resolves the stored `nextDirective`,
  applies it, then always redraws `nextDirective` from the pool via `pickNextDirective`
  (`nextRng`, a mulberry32-style step over the int32 `rngState`). The preview is visible
  because the next directive is chosen one sweep ahead.
- `standard` reproduces the legacy sweep exactly, so existing balance and tests carry over.
- A directive's `pre` runs even when the process table is empty, so side effects like
  `backpressure` reclaiming the leak are not skipped.
- An unknown id (e.g. from a stale save) falls back to `standard`.

## Alternatives considered

- **Fixed rotation** — rejected: a deterministic cycle the player could memorize and plan
  around completely; no tension, and `sweepsSurvived` would only change pacing, not kind.
- **Pure random selection** — rejected: unpredictable in a way the player cannot preview or
  prepare for, and it would not guarantee the unlock escalation reads as progression.
- **Selection-only directives (no budget variation)** — rejected: every sweep would still
  reap the same count, so directive identity would be cosmetic; the budget fraction is what
  makes `scavenger`/`backpressure` feel different.

## Consequences

- **Positive:** the sweep gets a readable identity and escalates with progression; the
  previewable `nextDirective` gives the player something to react to; the roster is data, so
  new directives are additive.
- **Negative:** the sim now needs a PRNG cursor (`rngState`) and a pending-directive field
  (`nextDirective`) in persisted state, and every new directive must keep the seeded draw
  deterministic.
- **Follow-ups:** re-tuning unlock thresholds and budget fractions is tracked in #7/#14;
  richer per-directive victim UI is tracked in #15.

See [`docs/architecture/008-sweep-directives.md`](../architecture/008-sweep-directives.md)
for the current contract.
