# Buy-Max (Repeat Purchase) — Design

- **Issue:** #18 (Epic #6, Phase B)
- **Date:** 2026-10-12
- **Status:** Approved (design) — pending implementation
- **Depends on:** #17 (milestone gating) — stacked on `feat/17-milestones`

## Context

Every purchase is a single click. Spawning is the worst offender: a player who can afford
eighty `cron daemon`s clicks the same button eighty times. The tedium is exactly the late-game
loop the game is built around, so it needs an **earned** remedy, not a free one.

#18 adds bulk buying for **tier spawns** as an unlock: a global `buy max` toggle, gated by a
milestone on #17's `buy-max` unlock id, that buys the maximum affordable units of a tier in one
click — bounded by both `cycles` and remaining RAM.

## Goals

- Add `maxAffordable(s, i)` (pure) and `spawnMax(s, i)` (gated action) in `src/sim.ts`.
- Add a `bulk-buy` milestone that grants the `buy-max` unlock.
- Add a persisted `buyMax` toggle and surface it in the spawn panel only after the unlock.
- Preserve current single-click behavior when the toggle is off, and never overspend `cycles`
  or RAM.

## Non-goals

- Bulk buying **upgrades** (`nice`/`malloc`/`gc`/`cooling`/shields) — scope is tier spawns only.
- Auto-buying (that is #19).
- Any change to `canSpawn`, `tierCost`, or the cost curves.

## Decisions (from the design dialogue)

1. **Scope:** tier spawn buttons only.
2. **Mechanism:** a single global `buy max` toggle (not per-row buttons, not a click modifier).
3. **Algorithm:** closed-form geometric-series solve + a bounded correction loop (not a capped
   brute-force loop).
4. **Toggle** is persisted (`buyMax: boolean`); the **unlock** is separate (`hasUnlock`).

## Design

### Unlock and milestone

`MILESTONES` gains one row (the dependent issue authors its own row on #17's forward id):

| id         | name     | metric        | `at` | unlocks   |
| ---------- | -------- | ------------- | ---- | --------- |
| `bulk-buy` | bulk-buy | `totalEarned` | 1e5  | `buy-max` |

`UNLOCK.buyMax` already exists (declared by #17). The threshold is data.

### State and persistence

| Field    | Type    | Meaning                          | Default | On `doFork` |
| -------- | ------- | -------------------------------- | ------- | ----------- |
| `buyMax` | boolean | The `buy max` toggle preference. | `false` | preserved   |

- `newGame()` defaults `buyMax: false`; `doFork` (which resets only the working set) leaves it
  untouched.
- `decode` coerces it with `Boolean(...)`; `SAVE_VERSION` bumps (3 → 4 on this stack) with an
  additive `if (from < 4)` no-op step.
- The capability is `hasUnlock(s, UNLOCK.buyMax)`; the preference is `s.buyMax`. A corrupt
  save with `buyMax: true` but no unlock shows no toggle and refuses `spawnMax` — the sim
  gate checks the **unlock**, not the boolean.

### Max-affordable

```
maxAffordable(s, i):
  c      = counts[i]
  growth = TIERS[i].costGrowth
  next   = tierCost(s, i)                         // cost of the next unit
  kCyc   = floor( ln(1 + cycles * (growth - 1) / next) / ln(growth) )   // solve the series
  kRam   = floor( (s.ramCap - ramUsed(s)) / TIERS[i].ram )
  k      = max(0, min(kCyc, kRam))                // both terms finite; kRam <= ramCap
  correct k by ±1 until total(k) <= cycles < total(k+1) and c + k fits RAM
  return k
```

where `total(k) = next * (growth^k - 1) / (growth - 1)` is the cost of `k` units, computed in
`Decimal` (break_eternity scales past `1e308`, so the log is taken in `Decimal` too). The
correction loop is bounded to a couple of iterations; it absorbs floating/Decimal rounding so
the result is the _exact_ maximum.

### Action

```
spawnMax(s, i): boolean
  if (!hasUnlock(s, UNLOCK.buyMax)) return false
  k = maxAffordable(s, i)
  if (k <= 0) return false
  s.cycles = s.cycles.sub(total(k))
  s.counts[i] += k
  log(s, `<tier name> x${k}`)
  return true
```

Bulk-applied (O(1)), not a `spawn()` loop. `total(k) <= cycles` and `c + k` fitting RAM are
guaranteed by `maxAffordable`, so `cycles` never goes negative and RAM is never exceeded.

### UI (`src/main.ts`, `index.html`)

- A `buy max` checkbox at the top of the **spawn** panel, rendered only once
  `hasUnlock(state, UNLOCK.buyMax)`; toggling sets `state.buyMax` and re-renders.
- While `state.buyMax` is on, a spawn button's click calls `spawnMax(state, i)` and its cost
  line gains a `×max` marker; when off it calls `spawn(state, i)` as before.
- Buttons keep the existing `canSpawn` disabled gate. `spawnMax` re-checks both the unlock and
  the affordability, so a stale UI can't overspend.

## Testing

- `maxAffordable` equals a brute-force `spawn` loop (small counts) — the correctness anchor.
- Respects the **RAM** bound: with plenty of cycles but little RAM, it returns the RAM-limited
  count.
- Never overspends: after `spawnMax`, `cycles >= 0` and `ramUsed(s) <= s.ramCap`.
- `spawnMax` returns `false` while `buy-max` is locked; `true` after the `bulk-buy` milestone
  fires.
- The `bulk-buy` milestone fires at `totalEarned >= 1e5` and grants `buy-max`.
- `buyMax` round-trips through save/load; a corrupt value coerces to a boolean; a pre-version
  save loads with `buyMax: false`.
- `maxAffordable` with `k = 0` (unaffordable or no RAM) returns 0, and `spawnMax` returns false.

## Docs impact (lockstep)

- `docs/architecture/001-simulation-core.md` — the spawn/buy-max rule, the `buyMax` state row.
- `docs/architecture/002-render-system.md` — the spawn-panel toggle.
- `docs/architecture/010-milestones.md` — add the `bulk-buy` row to the starter set.
- No new architecture doc or ADR: this extends existing systems.

## Risks / open questions

- **Threshold `at = 1e5`** is a first pass; retune if bulk buying arrives too late (or too
  early).
- **Decimal log availability.** The geometric solve needs `ln`/`log` on the bignum wrapper; if
  the wrapper lacks one, the correction loop can start from a `gamespeed`-free estimate (e.g.
  a coarse bisection) — still bounded.
- **Rounding edge.** The correction loop is what makes the result exact; a test compares to
  brute force so an off-by-one cannot pass.
- **Consolidation.** This branch stacks on #17; the `SAVE_VERSION` step becomes `< 4`. The
  Phase B integration merge resolves that (and #22's). #22 also adds `ramCapTotal`; once it is
  folded into the integration branch, the `RAM bound` line should read `ramCapTotal(s)` instead
  of `s.ramCap` so the `oomguard` perk's bonus counts. (`MAX_SANE_COUNT` is deliberately not
  used here — it lives in `persistence.ts`, and importing it into `sim.ts` would create a
  cycle.)
