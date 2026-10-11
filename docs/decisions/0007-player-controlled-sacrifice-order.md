# 0007 — Player-controlled sacrifice order

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

Which children the sweep reaped was a frozen per-tier constant: the order came from
`TIERS.priority`, a static ascending list in `src/sim.ts`. `nice` let the player change
**how many** children died, but never **which** — the cheapest tier was always lost first,
regardless of what the player was trying to build. Composition and RAM footprint strategy had
no lever against the sweep besides buying more `nice`.

## Decision

The player owns the reap order. `GameState.sacrificeOrder` is a persisted permutation of the
tier indices (earlier = reaped sooner), defaulting to `DEFAULT_SACRIFICE_ORDER` (the legacy
order: tier indices sorted by ascending `TIERS.priority`).

- `priorityOf(s, tier)` returns a tier's rank, and `priorityOrder(s)` returns the tier
  indices sorted by that rank — the single source of truth the directives select through.
  Nothing else re-derives an order.
- `movePriority(s, tier, delta)` moves a tier one slot earlier (`-1`) or later (`+1`) and
  refuses (returns `false`, mutating nothing) when the move would leave the range.
- `sanitizeSacrificeOrder(order: unknown)` coerces save-decode input: a valid permutation is
  copied, anything else falls back to the default.
- Only `standard`, `sigkill`, and `backpressure` honor the order. `scavenger` (highest
  `baseOutput`) and `group-kill` (densest tier) keep their own selection by design.
- `TIERS.priority` is demoted to the source of the _default_ order only.

## Alternatives considered

- **Presets only** (a few fixed orders the player toggles between) — rejected: less
  expressive than a full permutation for no real UX gain, and the move primitive is simple
  enough to expose directly.
- **Every directive obeying the order** — rejected: it would erase the identity of
  `scavenger` and `group-kill`; part of the roster's tension is that some directives take the
  choice away.
- **Numeric rank inputs** (type a priority number per tier) — rejected: more error-prone and
  harder to keep a valid permutation; discrete up/down moves cannot produce an invalid order.

## Consequences

- **Positive:** composition and footprint strategy gain a second lever beside `nice`; the
  player can protect the tiers their build depends on.
- **Negative:** a new persisted field to keep valid and merge on load; two directives remain
  outside player control by design, which will surprise players who expect the order to
  always apply.
- **Follow-ups:** the order panel and save sanitize landed with this change (#9); further UI
  for victim previews is tracked in #15.

See [`docs/architecture/008-sweep-directives.md`](../architecture/008-sweep-directives.md)
for the current contract.
