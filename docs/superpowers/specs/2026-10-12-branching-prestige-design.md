# Branching Prestige — Perk Tree — Design

- **Issue:** #22 (Epic #6, Phase B)
- **Date:** 2026-10-12
- **Status:** Approved (design) — pending implementation

## Context

`fork()` is the meta-layer, and it is a single flat rule: `lineageMult = 1 + forks * 0.1`
(`src/sim.ts`), applied uniformly to all income, with no player choice, no reset, and no
build variety. The only permanent carry-overs are `forks` (and the derived multiplier) and
`sweepsSurvived` (the global `survivalMult`). `IDEA.md` promises that "multiple forks
stack" and that the meta-layer gives the player something to steer; today it gives a single
number going up.

#22's acceptance: *perks are data-driven, persist across forks and reset correctly on
fork; at least two meaningfully different fork builds are viable; perk-tree UI*. This
design delivers a permanent, branching **perk tree** fed by a new spendable **lineage**
currency, layered on top of (not replacing) the existing flat multiplier.

## Goals

- Add a spendable **lineage** currency earned at `fork()`, distinct from the existing
  `forks` count and its multiplier.
- Add a **data-driven, permanent perk tree** across three branches — Growth, Survival,
  Lineage — where the player's investment choices create at least two viable builds
  ("greedy" vs "turtle", with a meta/lineage specialist in between).
- Keep every perk effect a **pure aggregate** (`perkMods`) so it is testable in one place
  and composes with the existing multiplier stack.
- Keep the existing flat `lineageMult` and all Phase A balance exactly as they are.
- Be additive-safe for saves and establish the version-3 migration step.

## Non-goals

- Replacing or rebalancing the flat `+0.1` lineage multiplier (kept, per decision 1).
- The legacy-daemon rework (#20) and achievements (#21) — the Lineage branch exposes
  generic hooks (`legacyRateMult`, `pointsMult`) those issues will build on, but neither is
  implemented here.
- The Phase C supervisor/ascension endgame. The tree is designed so a future prestige or
  ascension tier can layer on without reworking it.
- Moving `TIERS`/`SYNERGY`/`DIRECTIVES` into `src/config/` — that refactor is out of scope;
  only the perk data lives in config for now.

## Decisions (from the design dialogue)

1. **Keep the compounding `+0.1` `lineageMult` AND add spendable lineage points.**
2. **Points per fork = flat base + depth bonus.** Depth is a blend of run duration and
   per-run earnings, on a **sqrt** curve. Balance anchor: a first playthrough yields enough
   points for ~2 nodes. Exact constants are tunable.
3. **Permanent investment tree** — perks and unspent points accumulate across every fork;
   `doFork` must not clear them. (Revisit if a future prestige/ascension tier lands.)
4. **Three branches:** Growth, Survival, Lineage.
5. **Hybrid nodes:** a finite prerequisite DAG of distinct perks **plus** one repeatable
   "sink" node per branch.
6. **Depth metric:** run duration + earnings-delta blend, sqrt curve; constants tunable.
7. **Sub-linear benefit / geometric cost** — uncapped but self-limiting (no hard cap on
   the point-generation node).
8. **Exploit guard:** the `forkCost`-reduction perk is floored, and the flat base is only
   granted to a run that meets a minimum duration and earnings threshold.

## Design

### File layout

The tree is data, so the data and its constants live in a leaf module; the pure logic sits
next to it; the mutating actions stay in the sim (per the repo's "rules in `sim.ts`"
convention).

| File                  | Owns                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `src/config/perks.ts` | `PerkId`, `Branch`, `PerkDef`, `PerkMods` *types*, the `PERKS` roster, all tunable constants. No runtime imports (a type-only `Decimal` import is erased). |
| `src/perks.ts`        | Pure logic: `perkMods`, `perkCost`, `canBuyPerk`, `pointsForFork`. Imports `config/perks`. |
| `src/sim.ts`          | New `GameState` fields, the `buyPerk` action, `doFork` changes, formula integration. |
| `src/persistence.ts`  | `sanitizePerks`, new fields in `decode`/`encode`/`sanitizeNumericState`, staged migrations. |

Runtime dependency direction is one-way: `config/perks.ts` → (nothing); `perks.ts` →
`config/perks.ts` + `bignum`; `sim.ts` → both; `persistence.ts` → all. No cycles. Type-only
imports (e.g. `Decimal`) are erased at runtime.

### State

Four fields are added to `GameState` (all get `newGame()` defaults, so saves stay
additive-safe):

| Field              | Type                   | Meaning                                                       | On `doFork` |
| ------------------ | ---------------------- | ------------------------------------------------------------ | ----------- |
| `lineage`          | `number`               | Unspent lineage points (integer ≥ 0).                        | preserved   |
| `perks`            | `Record<PerkId, number>` | Purchased level per node; a missing key means level 0.      | preserved   |
| `runBaseEarned`    | `Decimal`              | `totalEarned` snapshot at the last fork.                     | reset       |
| `runStartPlaytime` | `number`               | `playtime` snapshot at the last fork.                        | reset       |

`runEarned = totalEarned - runBaseEarned` and `runSeconds = playtime - runStartPlaytime`
are the per-run depth inputs. `lineage` and `perks` join `forks`/`legacy` in the
"preserved across `doFork`" set; the two run snapshots join the reset set.

`SAVE_VERSION` bumps **2 → 3**.

### Data model (`src/config/perks.ts`)

```ts
export type PerkId = string;
export type Branch = "growth" | "survival" | "lineage";

export interface PerkDef {
  id: PerkId;
  branch: Branch;
  name: string;
  desc: string;          // terminal-flavored flavor text
  requires?: PerkId;     // prerequisite node (DAG edge); undefined = root of its branch
  maxLevel: number;      // 1 for distinct perks; Infinity for sinks
  costBase: number;      // points for level 0 -> 1
  costRate: number;      // per-level cost multiplier: 1 = flat (distinct), 1.6 = sink
  mod: keyof PerkMods;   // which aggregate field this node feeds
  perLevel: number;      // magnitude per level (interpreted via MOD_KIND)
}

export const PERKS: PerkDef[] = [ /* roster below */ ];
export const perkById = (id: PerkId) => PERKS.find((p) => p.id === id);
```

Every node's cost for its **next** level (at current level `L`) is uniform:
`cost(L) = costBase * costRate^L`. Distinct perks use `costRate = 1`; sinks use `1.6`.

### Curves and formulas (`src/perks.ts` + config constants)

All constants below are **exported, named placeholders** so pacing can be tuned without
touching logic.

**Points awarded per fork** (`pointsForFork`):

```ts
// config/perks.ts
export const T_REF = 300;         // seconds for timeFactor = 1
export const E_REF = 1e6;         // cycles for earnFactor = 1
export const DEPTH_GAIN = 2;      // points per unit of depth
export const FLAT_BASE = 1;       // flat points for a qualifying fork
export const MIN_RUN_SECONDS = 60;
export const MIN_RUN_EARNED = 1e3;
export const DEPTH_CAP = 1000;    // bound on each factor before toNumber()
export const MAX_POINTS_PER_FORK = 1e6; // hard ceiling on a single grant
export const SINK_RATE = 1.6;     // per-level cost multiplier used by sink nodes
export const FORK_COST_FLOOR = 0.25; // floor on the forkCost-reduction multiplier

// perks.ts
runSeconds = max(0, playtime - runStartPlaytime);
runEarned  = max(0, totalEarned - runBaseEarned);          // Decimal
timeFactor = sqrt(runSeconds / T_REF);
earnFactor = clamp(Decimal.sqrt(runEarned / E_REF).toNumber(), 0, DEPTH_CAP);
depth      = timeFactor + earnFactor;
qualifies  = runSeconds >= MIN_RUN_SECONDS && runEarned.gte(d(MIN_RUN_EARNED));
points     = min(MAX_POINTS_PER_FORK, floor(DEPTH_GAIN * depth) + (qualifies ? FLAT_BASE : 0));
```

- `runEarned / E_REF` and the `sqrt` are computed in `Decimal` (break_eternity scales past
  `1e308`); the result is clamped to `DEPTH_CAP` **before** `toNumber()`, so it can never
  become `Infinity`.
- Sanity check vs. the anchor: a ~600 s first run earning ~`1e6` → `depth ≈ 1.41 + 1 =
  2.41` → **5 points**; distinct tier-1 nodes cost **2** → **~2 nodes**.
- An instant fork has `runSeconds ≈ 0` and `runEarned ≈ 0` → `depth ≈ 0`, and the flat base
  is denied by `qualifies`, so it yields **0 points** (the Q8 exploit guard).

**Benefit curves.** Every node contributes `perLevel * sqrt(level)` — a sub-linear,
unbounded shape. Distinct perks only ever reach `level = 1` (`sqrt(1) = 1`, i.e. their flat
`perLevel`); sinks keep gaining `~perLevel / (2 sqrt(L))` per level. The cost is geometric
(`1.6^L`), so marginal cost outgrows marginal benefit past a bounded level — the
"uncapped but self-limiting" property from decision 7, proven in a test.

**Aggregation metadata** (`perks.ts`):

```ts
type Op = "add" | "multiply" | "divide";
const MOD_KIND: Record<keyof PerkMods, Op> = { /* ... */ };
```

- `multiply`: `value *= 1 + perLevel * sqrt(L)` (increase modifiers)
- `divide`:   `value /= 1 + perLevel * sqrt(L)` (reduction modifiers, e.g. cost/heat)
- `add`:      `value += perLevel * sqrt(L)`

`perkMods(s)` folds every owned node in `PERKS` order into one `PerkMods`, with Decimal
fields for `incomeMult`, `rootMult`, `legacyRateMult`, `startCycles`. The interface is
declared in `src/config/perks.ts` (shown here for reference):

```ts
export interface PerkMods {
  incomeMult: Decimal;      // multiply, >= 1  (children + root)
  rootMult: Decimal;        // multiply, >= 1  (root baseline only)
  tierCostMult: number;     // divide in (0, 1]
  niceAdd: number;          // add, >= 0  (equivalent extra `nice` levels)
  ramCapAdd: number;        // add, >= 0
  heatGenMult: number;      // divide in (0, 1]  (scales heat equilibrium)
  startShieldsAdd: number;  // add, >= 0
  forkCostMult: number;     // divide, floored at FORK_COST_FLOOR
  pointsMult: number;       // multiply, >= 1
  legacyRateMult: Decimal;  // multiply, >= 1
  startCycles: Decimal;     // add, >= 0
}

export const FORK_COST_FLOOR = 0.25;
```

`forkCostMult = max(FORK_COST_FLOOR, product of divide factors)` — the one genuinely
dangerous multiplier is floored (decision 8).

`PerkInput` is a narrow interface declared in `perks.ts` (the fields the fold and
`pointsForFork` read: `perks`, `lineage`, `playtime`, `runStartPlaytime`, `totalEarned`,
`runBaseEarned`), so `perks.ts` never imports `GameState` at runtime.

### Roster (`PERKS`)

15 nodes: 4 distinct + 1 sink per branch. Costs are points; the effect feeds the named
`PerkMods` field.

**Growth** — more cycles, cheaper herd

| id | name | effect | `mod` | `perLevel` | requires | `maxLevel` | `costBase` | `costRate` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spin` | spin loop | +10% income | `incomeMult` | 0.10 | — | 1 | 2 | 1 |
| `tailcall` | tail-call opt | −8% tier cost | `tierCostMult` | 0.08 | `spin` | 1 | 5 | 1 |
| `prefetch` | prefetcher | +15% income | `incomeMult` | 0.15 | `spin` | 1 | 5 | 1 |
| `vec` | vectorized | root output ×2 | `rootMult` | 1.0 | `tailcall` | 1 | 10 | 1 |
| `pipeline` ∞ | pipelining | income ×(1 + 0.10·√L) | `incomeMult` | 0.10 | `prefetch` | ∞ | 3 | 1.6 |

**Survival** — keep the herd alive

| id | name | effect | `mod` | `perLevel` | requires | `maxLevel` | `costBase` | `costRate` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `renice` | re-nice | +1 effective `nice` | `niceAdd` | 1 | — | 1 | 2 | 1 |
| `oomguard` | oom-guard | +8 MB RAM cap | `ramCapAdd` | 8 | `renice` | 1 | 5 | 1 |
| `heatsink` | heatsink | −10% heat | `heatGenMult` | 0.10 | `renice` | 1 | 5 | 1 |
| `sigblock` | signal mask | +1 starting shield | `startShieldsAdd` | 1 | `oomguard` | 1 | 10 | 1 |
| `reaper` ∞ | lazy sweeper | +1·√L effective `nice` | `niceAdd` | 1 | `heatsink` | ∞ | 3 | 1.6 |

**Lineage** — meta-carryover (the risky branch)

| id | name | effect | `mod` | `perLevel` | requires | `maxLevel` | `costBase` | `costRate` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `echo` | lineage echo | +5% points/fork | `pointsMult` | 0.05 | — | 1 | 2 | 1 |
| `cheapfork` | cheap fork | −10% forkCost (floored) | `forkCostMult` | 0.10 | `echo` | 1 | 5 | 1 |
| `cache` | ancestor cache | legacy rate ×1.05 | `legacyRateMult` | 0.05 | `echo` | 1 | 5 | 1 |
| `startup` | warm start | start each run with 1 000 cycles | `startCycles` | 1000 | `cheapfork` | 1 | 10 | 1 |
| `recursion` ∞ | recursion | points ×(1 + 0.05·√L) | `pointsMult` | 0.05 | `cache` | ∞ | 3 | 1.6 |

Adding a node is additive: append to `PERKS` with a `requires` edge, and the fold, cost,
gating, and UI all pick it up.

### Sim integration (`src/sim.ts`)

**Pure and cheap.** `perkMods(s)` is a pure fold over ≤15 entries, so it can be called
freely — no caching or invalidation is needed.

Perk effects are applied **inside the formula that owns them**: each formula calls
`perkMods(s)` itself (pure and cheap — ≤15 lookups), so no signatures change and nothing
has to be threaded through `tick`. The one rule that matters is that `baseCyclesPerSec`
stays **perk-free**, because `doFork` snapshots it into the legacy rate; income perks go in
a thin wrapper used only for live income:

```ts
// new: live income wraps the perk-free base, so the legacy snapshot never bakes perks in
function perkedBaseCyclesPerSec(s: GameState): Decimal {
  const m = perkMods(s);
  const children = childOutput(s).mul(survivalMult(s)).mul(m.incomeMult);
  const root = d(BASE.rootOutput).mul(m.incomeMult).mul(m.rootMult);
  return children.add(root);
}
export function cyclesPerSec(s: GameState): Decimal {
  return perkedBaseCyclesPerSec(s).mul(lineageMult(s)).mul(heatMult(s));
}

// legacy daemons (in tick): perk income does NOT apply — the Lineage branch's
// legacyRateMult is the only perk channel here, applied once
legacyGain = dm.rate.mul(mods.legacyRateMult).mul(lineageMult(s)).mul(dt);
```

| Formula               | Change                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `cyclesPerSec`        | children `· mods.incomeMult`; root term additionally `· mods.rootMult` |
| `tierCost(s, i)`      | `· mods.tierCostMult`                                               |
| `ramCap` reads        | `ramCap + mods.ramCapAdd` (spawn gating / OOM)                      |
| `sweepVictimMult`     | reads `s.nice + mods.niceAdd` (existing `max(0.3, …)` floor holds)  |
| `heatEquilibrium`     | `· mods.heatGenMult` (lower equilibrium → less throttle)            |
| `forkCost`            | `· mods.forkCostMult` (floored at `FORK_COST_FLOOR`)                |
| legacy income         | `· mods.legacyRateMult` (does **not** get `incomeMult`)             |
| `baseCyclesPerSec`    | **unchanged / perk-free** — keeps the legacy snapshot clean         |

**`doFork` additions**, in order:

1. `grant = floor(pointsForFork(s) * mods.pointsMult)`; `s.lineage += min(MAX_POINTS_PER_FORK, grant)`.
   (`mods` here is recomputed for the pre-reset state, so earning perks apply to the fork
   that earns.)
2. Run the existing reset (counts, leak, heat, cooling, shields, nice, gc, sweep cadence) —
   **plus** `s.runBaseEarned = s.totalEarned` and `s.runStartPlaytime = s.playtime`.
3. Apply start-of-run grants from `mods`: `s.shields = mods.startShieldsAdd` (replaces the
   current `shields = 0`), and `s.cycles = mods.startCycles` (replaces `cycles = 0`).
4. Preserve `forks`, `legacy`, `lineage`, `perks` (the decision-3 guarantee — covered by a
   test).

**New action** (`sim.ts` actions section, like every mutator):

```ts
export function buyPerk(s: GameState, id: PerkId): boolean {
  if (!canBuyPerk(s, id)) return false;
  s.lineage -= perkCost(s, id);
  s.perks[id] = (s.perks[id] ?? 0) + 1;
  log(s, `lineage: bought ${perkById(id).name} (L${s.perks[id]})`);
  return true;
}
```

`canBuyPerk(s, id)` = node exists ∧ `perks[id] ?? 0 < maxLevel` ∧ prerequisite owned ∧
`lineage >= perkCost(s, id)`. Perks never reset, so there is no refund path.

**Determinism:** nothing in the perk path uses RNG — `pointsForFork` and `perkMods` are
pure functions of state, so replays and `applyOffline` stay reproducible.

### Persistence and migration (`src/persistence.ts`)

- `encode` must stringify the new `Decimal`: `runBaseEarned: s.runBaseEarned.toString()`
  (alongside `cycles`/`totalEarned`/each legacy `rate`).
- `decode` coerces the new fields:
  - `lineage` → `coerceCount`,
  - `runBaseEarned` → `coerceDecimal(parsed.runBaseEarned, d(0))`,
  - `perks` → `sanitizePerks(parsed.perks)`.
- `sanitizePerks(raw)`: for each `PERKS` entry, read `raw?.[id]`, run `coerceCount`, clamp
  to `[0, maxLevel]` (so a hand-edited or stale level can't exceed the cap); unknown keys
  are dropped (the result is rebuilt from `PERKS`, so stale ids never survive).
- `sanitizeNumericState` adds: `lineage = coerceCount(...)`, and
  `runStartPlaytime = max(0, coerceFinite(...))`. The existing `ramCap >= BASE.ramCap`
  clamp stays (perk RAM is added at read time, not stored into `ramCap`).

**Staged migration — a required fix, not optional.** Today `decode` applies the
legacy-rate fixup under a single `parsed.saveVersion < SAVE_VERSION` check. Once
`SAVE_VERSION = 3`, that check would also fire for v2 saves and **re-divide rates that were
already lineage-free**, corrupting them. The migration must be split into per-step stages,
each keyed to the version it upgrades *from*:

```ts
const from = coerceFinite(parsed.saveVersion, 0);
if (from < 2) { /* divide baked lineage out of each legacy rate, as today */ }
if (from < 3) { /* additive only: new fields come from newGame() defaults; no-op */ }
s.saveVersion = SAVE_VERSION;
```

A test must pin that a v2 save is **not** re-divided when loaded under `SAVE_VERSION = 3`,
and that a pre-versioning save still is.

### UI (`src/main.ts`)

A new **prestige / perks panel**, built the way `renderLegacy()` builds its DOM (data →
elements, no framework):

- **Visibility:** hidden until `forks >= 1` (the first fork creates claimable points).
- **Layout:** three columns — `growth | survival | lineage` — each ordered by prerequisite
  depth. A node renders as a button line:

  ```
  [spin loop]                L1    +10% income
  [pipeline]  ← prefetch     L3    3pt    ×1.18 income
  ```

  showing name, current level, next cost (`perkCost`), the effect line, and its
  prerequisite. A node is **disabled/dimmed** when the prerequisite is not owned or
  `lineage < cost`.
- **Header:** `lineage: N pt` and a preview `next fork grants ≈ P pt` (from
  `pointsForFork`) so the earning loop is legible. The existing HUD `×N.N` lineage
  multiplier is unchanged.
- **Actions:** clicking a node calls `buyPerk`; the panel re-renders on the existing render
  cadence (no new timers). Terminal flavor lives in `name`/`desc`. Reuses `style.css`
  conventions.

UI verification is manual: drive the dev server, fork once, buy nodes, screenshot, and
report the values the panel shows (AGENTS.md's UI-verification rule).

## Testing

New `src/perks.test.ts` plus additions to `src/sim.test.ts` and
`src/persistence.test.ts`. The sim is pure, so all of this is node-testable.

- **`pointsForFork`:** flat base gated by `MIN_RUN_SECONDS`/`MIN_RUN_EARNED`; an instant
  fork yields 0; longer/deeper runs yield more (monotonic); a huge `runEarned` clamps at
  `DEPTH_CAP` and never returns `Infinity`; the grant never exceeds `MAX_POINTS_PER_FORK`.
- **`perkCost` / `canBuyPerk` / `buyPerk`:** prerequisite gating; affordability; spends
  exactly once; `maxLevel` respected for distinct nodes; sinks repeatable; the `forkCost`
  floor holds at `FORK_COST_FLOOR`.
- **`perkMods`:** each `Op` folds correctly; multiple nodes compose; Decimal fields stay
  finite.
- **Soft cap:** the sink's marginal `benefit(L+1) / cost(L+1)` falls below its level-1
  value and below the flat tier-1 perks past a bounded level (proves "uncapped but
  self-limiting").
- **`doFork`:** preserves `perks` + `lineage`; resets `runBaseEarned`/`runStartPlaytime`;
  applies `startShieldsAdd`/`startCycles`; the awarded points use `pointsMult`.
- **Persistence:** round-trip of all four new fields; `sanitizePerks` drops unknown ids and
  clamps levels; a pre-version save loads with defaults; a **v2** save loads **without**
  re-dividing legacy rates while a pre-version save still is; `applyOffline` totals are
  correct with perks active.

## Docs impact (lockstep)

- **New** `docs/architecture/009-prestige-perk-tree.md` — the tree contract: branches,
  curve shapes, the earning formula, the soft-cap rationale, and the `mod` → formula
  mapping. Register it in the `docs/architecture/README.md` index.
- **Rewrite** `docs/architecture/004-prestige-and-legacy.md` — `fork()` also awards points
  and applies start grants; `lineageMult` is unchanged; legacy identity retained.
- **Touch** `001-simulation-core.md` (income composition, `tierCost`, `ramCap`, heat, the
  sweep budget/`nice`), `003-persistence.md` (new fields, `SAVE_VERSION` 3, staged
  migration), and `002-render-system.md` (the new panel).
- **ADR** `docs/decisions/0008-branching-prestige-perk-tree.md` — records the chosen model
  and the rejected alternatives.
- `npm run check` green; a browser screenshot of the panel with the values it shows.

## Risks / open questions

- **Pacing constants.** `T_REF`, `E_REF`, `DEPTH_GAIN`, `FLAT_BASE`, `MIN_RUN_*`,
  `SINK_RATE`, and every `costBase`/`perLevel` are a first pass; expect a tuning pass after
  playtesting (deferred by decision 6). They are all exported so tuning does not touch
  logic.
- **`startup` scaling.** A flat 1 000-cycle grant is a real head start early and negligible
  late; if it feels dead late-game, promote it to a per-branch sink (additive change).
- **Branch parity.** If playtesting shows one branch dominates, retune `perLevel`/costs
  rather than restructure — the tree is data.
- **`niceAdd` and heat interactions.** `renice`/`reaper` stack with the `nice` upgrade and
  share its `max(0.3, …)` floor, and `heatsink` lowers the heat equilibrium — confirm the
  sweep still reads as "lowest priority first" and that the `nice` floor plus the sweep
  budget keep Phase A's directives meaningful rather than trivial (a very high `niceAdd`
  with a low budget reaps almost nothing).
- **Lineage runaway.** The sub-linear benefit caps the *optimal* investment, but
  `pointsMult` and `legacyRateMult` still compound; the `MAX_POINTS_PER_FORK` ceiling and
  the soft-cap test are the guards. Revisit if the watchdog sees explosive growth.

## Alternatives considered

- **Replace the flat `lineageMult` with the tree** (earning model A/B) — rejected in favor
  of layering (decision 1): lower balance risk, keeps Phase A numbers intact.
- **Per-run re-spec (roguelite) tree** — rejected (decision 3): contradicts "persist across
  forks," and every run would restart investment.
- **All uncapped / all capped nodes** — rejected in favor of the hybrid (decision 5):
  distinct perks give legible builds; sinks absorb overflow without a hard wall.
- **Purchase-time mutation** (`buyPerk` permanently bumps `ramCap`, adds loose multipliers)
  — rejected: can't describe a node without side effects, piles state onto fields `doFork`
  resets, and has no single testable aggregate.
- **`apply(state, level)` closures per perk** — rejected: pushes logic into per-perk
  functions, so the aggregate is unprovable in one test and special-casing creeps in.
- **No `forkCost` perk / hard cap on point generation** — rejected (decisions 7–8) in favor
  of curves that are self-limiting by construction plus a floor + minimum-run guard.
