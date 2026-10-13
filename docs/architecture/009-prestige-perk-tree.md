# 009 — Prestige Perk Tree

The meta-layer branch: a permanent, data-driven perk tree the player invests in with
**lineage** points earned at `fork()`. Data and constants live in `src/config/perks.ts`;
pure logic in `src/perks.ts`; the mutating action (`buyPerk`) and the formula hooks live in
`src/sim.ts`. This doc owns the contract; [doc 004](./004-prestige-and-legacy.md) covers
`fork()` and the flat multiplier that sits alongside it.

## The two meta currencies

`fork()` now carries **two** permanent rewards, deliberately layered rather than merged:

- the **flat multiplier** `lineageMult = 1 + forks * 0.1` (unchanged — see doc 004), and
- **lineage points**, a spendable currency put into the perk tree.

Decoupling them keeps Phase A balance intact: the flat multiplier still scales all income,
while the tree adds targeted, player-chosen modifiers.

## Earning lineage points

At `fork()`, `pointsForFork(s)` awards:

```
runSeconds = max(0, playtime - runStartPlaytime)
runEarned  = max(0, totalEarned - runBaseEarned)          // Decimal
timeFactor = sqrt(runSeconds / T_REF)                      // T_REF = 300
earnFactor = clamp(sqrt(runEarned / E_REF), 0, DEPTH_CAP)  // E_REF = 1e6, DEPTH_CAP = 1000
depth      = timeFactor + earnFactor
qualifies  = runSeconds >= MIN_RUN_SECONDS (60) && runEarned >= MIN_RUN_EARNED (1e3)
points     = min(MAX_POINTS_PER_FORK, floor(DEPTH_GAIN * depth) + (qualifies ? FLAT_BASE : 0))
```

- **Depth is a run score**, not lifetime: `runBaseEarned`/`runStartPlaytime` snapshot
  `totalEarned`/`playtime` at the last fork, so each run is measured from its own start.
- **The sqrt keeps it gentle.** Deep runs pay more, sub-linearly. `earnFactor` is computed in
  `Decimal` and clamped to `DEPTH_CAP` before it reaches a JS number, so a run past `1e308`
  can never yield `Infinity`.
- **Anti-farm.** An instant fork has `depth ≈ 0` and is denied the flat base, so it yields 0.
  `FLAT_BASE` requires both a minimum duration and a minimum earned amount.
- **`pointsMult`** (the `echo`/`recursion` perks) multiplies the award; `MAX_POINTS_PER_FORK`
  caps the result.

A first run of ~600 s earning ~`1e6` yields `depth ≈ 2.41` → **5 points**, enough for two
tier-1 nodes (cost 2 each).

## The tree

15 nodes — **4 distinct perks + 1 repeatable sink per branch**. Every node is a row of
`PERKS`:

```ts
interface PerkDef {
  id;
  branch: "growth" | "survival" | "lineage";
  name;
  desc;
  requires?: PerkId; // prerequisite node (a DAG edge)
  maxLevel: number; // 1 for distinct, Infinity for sinks
  costBase;
  costRate; // costBase * costRate^level
  mod: keyof PerkMods; // which aggregate field it feeds
  perLevel: number; // magnitude per level
}
```

| Branch   | Distinct nodes (cost)                                                                                                    | Sink (cost `3 · 1.6^L`) |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| growth   | `spin` +10% income (2) · `tailcall` −8% tier cost (5) · `prefetch` +15% income (5) · `vec` root ×2 (10)                  | `pipeline` income       |
| survival | `renice` +1 `nice` (2) · `oomguard` +8 MB RAM (5) · `heatsink` −10% heat (5) · `sigblock` +1 start shield (10)           | `reaper` `nice`         |
| lineage  | `echo` +5% points/fork (2) · `cheapfork` −10% forkCost (5) · `cache` legacy ×1.05 (5) · `startup` warm-start cycles (10) | `recursion` points      |

Adding a node is additive: append to `PERKS` with a `requires` edge; the fold, cost, gating,
and UI are all generic over the roster.

## Cost and benefit curves

- **Cost** is an integer for a points currency: `perkCost = ceil(costBase * costRate^level)`,
  where `level` is the _current_ purchased level. Distinct perks use `costRate = 1`
  (`2, 5, 10, 20` by depth); sinks use `SINK_RATE = 1.6`.
- **Benefit.** Every node contributes `perLevel * sqrt(level)`: distinct perks only reach
  `level = 1` (so their flat `perLevel`), sinks gain `≈ perLevel / (2·sqrt(L))` per level.
- **Self-limiting.** Cost is geometric while benefit is sub-linear, so a sink's marginal
  `benefit(L+1) / cost(L+1)` shrinks and its _optimal_ level grows only logarithmically with
  point income. The point-generation branch is uncapped by construction yet cannot run away —
  this is exercised by a test, and `MAX_POINTS_PER_FORK` is the backstop.

## Aggregation — `PerkMods`

`perkMods(s)` folds every purchased level into one struct (pure, cheap, called by each
formula that needs it):

```
multiply: field *= 1 + perLevel*sqrt(level)     increase modifiers
divide:   field /= 1 + perLevel*sqrt(level)     reduction modifiers
add:      field += perLevel*sqrt(level)         flat modifiers
```

| `PerkMods` field  | Kind     | Read by                                                       |
| ----------------- | -------- | ------------------------------------------------------------- |
| `incomeMult`      | multiply | `cyclesPerSec` — children **and** root (Decimal)              |
| `rootMult`        | multiply | `cyclesPerSec` — root term only (Decimal)                     |
| `tierCostMult`    | divide   | `tierCost`                                                    |
| `niceAdd`         | add      | `sweepVictimMult` (adds to `s.nice` before the `max(0.3, …)`) |
| `ramCapAdd`       | add      | `ramCapTotal` (spawn gating, OOM, UI) — Decimal-free          |
| `heatGenMult`     | divide   | `heatEquilibrium`                                             |
| `startShieldsAdd` | add      | `doFork` starting `shields`                                   |
| `forkCostMult`    | divide   | `forkCost`, floored at `FORK_COST_FLOOR = 0.25`               |
| `pointsMult`      | multiply | `doFork` point award                                          |
| `legacyRateMult`  | multiply | legacy daemon income in `tick` (Decimal)                      |
| `startCycles`     | add      | `doFork` starting `cycles` (Decimal)                          |

**`baseCyclesPerSec` stays perk-free.** `doFork` snapshots it into each legacy daemon's rate,
so income perks are applied in `perkedBaseCyclesPerSec` (used only for `cyclesPerSec`) and
legacy daemons receive only `legacyRateMult` — no double-counting.

## `buyPerk`

```
canBuyPerk(s, id) = node exists ∧ level < maxLevel ∧ prerequisite owned ∧ lineage >= cost
buyPerk(s, id)    = spends lineage, level++, logs; false when canBuyPerk is false
```

Perks are permanent (decision: a _permanent_ investment tree), so `doFork` preserves
`lineage` and `perks` and there is no refund path. All four new state fields
(`lineage`, `perks`, `runBaseEarned`, `runStartPlaytime`) and the `SAVE_VERSION = 3` migration
are documented in [doc 003](./003-persistence.md).

## UI

The `prestige` panel (`#perkSection`) is hidden until `forks >= 1` and shows three columns
(`growth | survival | lineage`) built from `PERKS`, ordered by prerequisite depth. Each node
button shows its name, level, next cost, and effect, and is disabled unless `canBuyPerk`. The
header shows `lineage: N pt` and the next-fork preview. See
[doc 002](./002-render-system.md).
