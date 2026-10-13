# 012 — Repeatable Upgrades

The long-run, **in-run** sink: infinite upgrades with **diminishing returns**. Data and types
live in `src/config/repeatables.ts`; pure logic in `src/repeatables.ts`; the state field,
the `buyRepeatable` action, and the four formula integrations live in `src/sim.ts`; the
upgrade-panel rows live in `src/main.ts`.

Repeatables are the earned counterpart to the **prestige** perk tree (doc
[009](./009-prestige-perk-tree.md)): perks are meta (bought with lineage across runs),
repeatables are bought with `cycles` — the in-run currency — and, once bought, **persist across
`fork()`** (levels are permanent for the save). They share the same shape — a leaf data module,
a narrow input, a `MOD_KIND` fold, and integration at documented sites — but keep separate
currencies (ADR [0013](../decisions/0013-diminishing-return-repeatables.md)).

## Data model (`src/config/repeatables.ts`)

```ts
export interface RepeatableMods {
  incomeMult: Decimal; // multiply, >= 1
  ramCapAdd: number; // add, >= 0
  tierCostMult: number; // divide in (0, 1]
  heatGenMult: number; // divide in (0, 1]
}

export interface RepeatableDef {
  id: string;
  name: string;
  desc: string;
  baseCost: number;
  costGrowth: number; // per-level cost multiplier (exponential)
  mod: keyof RepeatableMods; // which aggregate field this row feeds
  perLevel: number; // magnitude per level (interpreted via REPEATABLE_MOD_KIND)
}
```

The config module is a **leaf**: its only import is the type-only `Decimal`, so it never
creates a runtime cycle with `sim.ts`.

### Roster

| id          | effect            | `mod`          | baseCost | costGrowth | `perLevel` |
| ----------- | ----------------- | -------------- | -------- | ---------- | ---------- |
| `overclock` | +income           | `incomeMult`   | 1e6      | 1.6        | 0.1        |
| `swapfile`  | +RAM cap          | `ramCapAdd`    | 5e6      | 1.7        | 4          |
| `undervolt` | −heat equilibrium | `heatGenMult`  | 2e6      | 1.6        | 0.08       |
| `bulk`      | −spawn cost       | `tierCostMult` | 2e6      | 1.7        | 0.05       |

All four generators are live: `bulk` feeds the `tierCost` discount (`tierCostMult`). The
`costGrowth`/`perLevel` numbers are first-pass data, tunable without code changes.

## Pure logic (`src/repeatables.ts`)

`repeatableMods(s)` folds every owned level into one `RepeatableMods` aggregate. Each row
contributes a magnitude of `perLevel * sqrt(level)`, applied by the operation named in
`REPEATABLE_MOD_KIND`:

```ts
REPEATABLE_MOD_KIND = {
  incomeMult: "multiply", // cur * (1 + mag)
  ramCapAdd: "add", // cur + mag
  tierCostMult: "divide", // cur / (1 + mag)
  heatGenMult: "divide", // cur / (1 + mag)
};
```

The fold is **data-driven over `REPEATABLES`**, exactly like `perkMods` over `PERKS`, so a
stale key in `state.repeatables` can never affect the aggregate. It is identity at level 0
(`incomeMult = 1`, `ramCapAdd = 0`, `tierCostMult = 1`, `heatGenMult = 1`).

- `repeatableCost(s, id) = baseCost * costGrowth^level` — exponential, so the `sqrt` effect is
  **sub-linear in total spend**. `0` for an unknown id.
- `canBuyRepeatable(s, id)` — true when the id exists and `cycles >= repeatableCost`. There is
  **no level cap**; the `sqrt` curve plus exponential cost is the brake.
- `repeatableById(id)` — roster lookup.

`src/repeatables.ts` reads a narrow `RepeatableInput` (`repeatables`, `cycles`), a structural
subset of `GameState`, so it never imports `sim.ts` at runtime — no cycle.

## State and action (`src/sim.ts`)

`GameState.repeatables: Record<string, number>` maps a repeatable id to its purchased level
(a missing key means level 0); `newGame()` defaults it to `{}`. `doFork` does **not** touch it —
repeatable levels persist across `fork()` for the life of the save, unlike the per-run working
set (`counts`, `nice`, `gc`, `cooling`, `ramCap`, `heat`).

```ts
buyRepeatable(s, id) {
  if (!canBuyRepeatable(s, id)) return false;
  s.cycles = s.cycles.sub(repeatableCost(s, id));
  s.repeatables[id] = (s.repeatables[id] ?? 0) + 1;
  log(s, `repeatable: ${name} (L${level})`);
  return true;
}
```

Like every mutating action it returns `boolean` (false = refused).

## Integration — exactly four sites

`repeatableMods(s)` is read in place by four formulas; nothing else in the sim consults it:

| site                     | fold                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `perkedBaseCyclesPerSec` | children and root both multiply by `repeatableMods.incomeMult` |
| `tierCost`               | multiply by `repeatableMods.tierCostMult`                      |
| `ramCapTotal`            | add `repeatableMods.ramCapAdd`                                 |
| `heatEquilibrium`        | multiply by `repeatableMods.heatGenMult`                       |

`baseCyclesPerSec` is deliberately **not** touched: `doFork` snapshots it into a legacy
daemon's rate, so baking a repeatable multiplier in would double-count it (the same reason
perks apply in `perkedBase`, doc [004](./004-prestige-and-legacy.md)). Multiplying `tierCost`
by a constant factor keeps `maxAffordable`'s closed form valid — the formula is linear in the
next cost, so a constant `tierCostMult` cancels out.

## Persistence

`repeatables` is a plain object (no `Decimal`). It persists at `SAVE_VERSION = 8` and is
rebuilt on load by `sanitizeRepeatables`, which reads each `REPEATABLES` row's level, clamps
to `MAX_SANE_COUNT`, and drops zeros and unknown ids — so a stale id never survives. A
pre-v8 save loads with `repeatables: {}` (additive; doc [003](./003-persistence.md)).

## UI (`src/main.ts`)

After the `nohup` row, `main.ts` registers one `addUpgrade(...)` row per `REPEATABLES` entry:
the label is `<name> L<level> · <desc>`, the cost is `repeatableCost(state, id)`, and the
button is enabled by `canBuyRepeatable`. The row is disabled while unaffordable and turns
green (`.ok`) when affordable — the same pattern as `cooling` (doc
[002](./002-render-system.md)). No new HTML or CSS is required.
