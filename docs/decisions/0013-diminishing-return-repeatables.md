# 0013 — Diminishing-return repeatable upgrades

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Phase A left **five tiers on a uniform curve** with no infinite scaling: once a player owns a
pile of cron daemons, the only long-run growth engines are the global `survivalMult` and the
prestige/perk layers. There is no earned, in-run sink for the huge cycle totals a long session
produces, and no content that unlocks late.

#23 adds **two unlock-gated tiers** (a milestone goal, not just a bigger number) and **infinite
repeatable upgrades** — an in-run sink that must scale without running away. The economy
already has several multipliers (`survivalMult`, `lineageMult`, `achievementMult`, perks) and a
legacy-rate snapshot (`baseCyclesPerSec`) that `doFork` copies into each legacy daemon's rate,
so a new multiplier had to pick its integration sites carefully to avoid double-counting.

## Decision

**Repeatable upgrades are data + pure logic, split like perks, with an exponential cost curve
and a `sqrt` diminishing effect.**

- **Roster and fold.** `src/config/repeatables.ts` is a leaf; `src/repeatables.ts` folds each
  owned level into one `RepeatableMods` aggregate, contributing `perLevel * sqrt(level)` per
  row through a `REPEATABLE_MOD_KIND` op table (`incomeMult` multiply, `ramCapAdd` add,
  `tierCostMult`/`heatGenMult` divide). Identity at level 0. Cost is
  `baseCost * costGrowth^level` (exponential), so effect is sub-linear in total spend.
- **Exactly four integration sites.** `perkedBaseCyclesPerSec` (income), `tierCost` (cost),
  `ramCapTotal` (RAM), `heatEquilibrium` (heat). `repeatableMods(s)` is read nowhere else.
- **`baseCyclesPerSec` stays repeatable-free.** It is the legacy snapshot source; applying a
  repeatable multiplier there would be baked into a forked daemon's rate and applied again.
- **Four live generators.** `overclock` (income), `swapfile` (RAM), `undervolt` (heat), and
  `bulk` (spawn-cost discount, feeding `tierCostMult`). The `tierCost` site is therefore live,
  not reserved.
- **Bought with `cycles`, permanent for the save.** `repeatables` is **not** reset by `doFork` —
  levels persist across runs, unlike the per-run working set; perks (lineage, meta) are the
  deliberate counterpart and use a separate currency. State is `Record<id, number>`, default `{}`.
- **Additive persistence.** `SAVE_VERSION` 7 → 8 with a staged `if (from < 8)` no-op;
  `sanitizeRepeatables` rebuilds the record from the roster and clamps to `MAX_SANE_COUNT`.

## Alternatives considered

- **Linear (non-diminishing) repeatable levels** — rejected: linear levels on an exponential
  cost curve still run away relative to spend; `sqrt` matches the proven perk sinks.
- **A `repeatableMaxLevel` cap** — rejected: repeatables are the long-run sink; a cap defeats
  the purpose. The `sqrt` effect plus exponential cost is the brake.
- **Fold repeatables into `perkMods`** — rejected: perks are prestige/meta and read a different
  input; mixing them conflates two currencies and two lifecycles.
- **Apply `incomeMult` inside `baseCyclesPerSec`** — rejected: `doFork` snapshots that value
  into legacy rates, so it would double-count (the same reason perks apply in `perkedBase`).
- **Gate the new tiers by affordability alone** — rejected: the acceptance requires
  milestone gating (ADR [0009](./0009-milestone-gating-model.md)), so the new tiers are a goal,
  not just a bigger number. The gate is a **sim rule** (`canSpawn`/`maxAffordable`), so
  `spawn`/`spawnMax` cannot bypass it.

## Consequences

- **Positive:** an infinite earned sink that cannot run away; a data-tunable roster; a clean
  legacy snapshot; additive persistence; the numeric watchdog stays quiet at high levels
  (exponential cost + `sqrt` effect keep every value finite).
- **Negative:** `costGrowth`/`perLevel` are first-pass data and will need tuning. Repeatables
  persist across `fork()`, so they **do** compound with the meta layers over a save's life —
  intentional (they are bought with `cycles`, but are permanent once bought), bounded by the
  exponential cost and `sqrt` effect.
- **Persistence:** `repeatables` is additive, so `SAVE_VERSION` 7 → 8 is a staged no-op
  (`if (from < 8)`); `sanitizeRepeatables` rebuilds the record from the roster.
- **Follow-ups:** if legacy income should ever share the repeatable income multiplier, that is
  a new ADR superseding this one.

See [`docs/architecture/012-repeatables.md`](../architecture/012-repeatables.md) for the current
contract.
