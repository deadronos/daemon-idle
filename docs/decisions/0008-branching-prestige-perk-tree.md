# 0008 — Branching prestige: the perk tree

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

`fork()` was a single flat rule: `lineageMult = 1 + forks * 0.1`, applied uniformly to all
income, with no player choice, no reset, and no build variety. Phase B (#22) asks for a
branching prestige layer where "at least two meaningfully different fork builds are viable",
perks are data-driven and persist, and the player steers the meta-layer instead of watching
one number rise.

The question was how to _shape_ that choice: how lineage is earned, whether it replaces or
layers on the flat multiplier, whether the tree resets, and how to keep an uncapped
point-generation branch from running away.

## Decision

Add a **permanent, data-driven perk tree** fed by a new spendable **lineage** currency, and
**keep** the existing flat `lineageMult` alongside it.

- **Earning (layered).** `fork()` still grants the compounding `+0.1` multiplier **and**
  awards lineage points. Points scale with a run's depth — a **sqrt** blend of run duration
  and per-run earnings, plus a flat base gated by a minimum run length and earnings (the
  anti-farm guard). Layering keeps Phase A balance intact instead of replacing it.
- **Persistence.** The tree is a **permanent investment**: perks and unspent points
  accumulate across every fork, and only the working set resets. (Explicitly revisitable if a
  future prestige/ascension tier lands.)
- **Three branches** — **growth** (income, tier cost, root output), **survival** (`nice`,
  RAM, heat, start shields), **lineage** (points, fork cost, legacy rate, warm start).
- **Hybrid nodes.** A finite prerequisite DAG of distinct perks **plus** one repeatable sink
  per branch.
- **Curves.** Sub-linear benefit (`perLevel * sqrt(level)`) against geometric cost
  (`costBase * 1.6^level`), so the point-generation node is **uncapped but self-limiting**;
  the `forkCost` reduction is floored at `0.25`.
- **Data-driven.** Types, the roster, and every constant live in `src/config/perks.ts`; pure
  aggregation (`perkMods`, `perkCost`, `canBuyPerk`, `pointsForFork`) in `src/perks.ts`;
  the mutating `buyPerk` and formula hooks in `src/sim.ts`.

## Alternatives considered

- **Replace the flat multiplier with the tree** — rejected: higher balance risk and it would
  discard Phase A's tuning. Layering is strictly additive.
- **Per-run re-spec (roguelite) tree** — rejected: contradicts "persist across forks"; every
  run would restart investment.
- **Flat per-fork points only** — rejected: _when_ you fork should matter, so points blend a
  flat base with depth.
- **All-capped or all-uncapped nodes** — rejected in favour of the hybrid: distinct perks
  give legible builds; a sink absorbs overflow without a hard wall.
- **Purchase-time mutation** (`buyPerk` permanently bumps `ramCap`, adds loose multipliers) —
  rejected: nodes can't be described without side effects, and state piles onto fields
  `doFork` resets.
- **`apply(state, level)` closures per perk** — rejected: pushes logic into per-perk
  functions, so the aggregate is unprovable in one test and special-casing creeps in.
- **No `forkCost` perk / a hard cap on point generation** — rejected in favour of
  self-limiting curves plus a floor and a minimum-run guard.

## Consequences

- **Positive:** `fork()` becomes a decision; the tree is data, so adding or rebalancing nodes
  is additive; every effect folds through one testable aggregate (`perkMods`) that also
  composes with income without double-counting (`baseCyclesPerSec` stays perk-free). The
  Lineage branch exposes generic hooks (`pointsMult`, `legacyRateMult`) that #20 and #21 can
  build on.
- **Negative:** four new persisted fields and a `SAVE_VERSION` bump to 3. That bump required
  splitting `decode`'s single `saveVersion < SAVE_VERSION` check into **staged** migrations —
  otherwise loading a v2 save would re-divide already-lineage-free legacy rates.
- **Follow-ups:** pacing constants (`T_REF`, `E_REF`, `DEPTH_GAIN`, `FLAT_BASE`, `MIN_RUN_*`,
  the per-node costs) are a first pass and want a playtest tune; they are all exported so
  tuning never touches logic. `startup` may become a sink if it reads as dead late-game.

See [`docs/architecture/009-prestige-perk-tree.md`](../architecture/009-prestige-perk-tree.md)
and [`004-prestige-and-legacy.md`](../architecture/004-prestige-and-legacy.md) for the current
contract.
