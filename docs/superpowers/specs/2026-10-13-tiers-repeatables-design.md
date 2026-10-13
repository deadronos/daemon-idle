# More Tiers + Infinite Repeatable Upgrades — Design

- **Issue:** #23 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design) — pending implementation
- **Depends on:** A5, B1 (#17 milestones), stacked on `feat/phase-b`

## Context

Phase A left **five tiers on a uniform curve** (`TIERS` in `src/sim.ts`) with no way to
scale indefinitely: once a player owns a pile of cron daemons, the only long-run growth
engine is the global `survivalMult` and the prestige/perk layers. There is no content that
unlocks late, and no repeatable sink for the huge cycle totals a long run produces.

#23 closes both gaps:

- **Two new tiers** (`k8s pod`, `bare-metal node`) that extend the curve and are gated by
  **milestones** (B1's unlock model), not affordability alone — so they are a *goal*, not
  just a bigger number.
- **Four infinite repeatable upgrades** with **diminishing returns** (`perLevel * sqrt(level)`)
  so a long run has somewhere to keep spending without runaway growth.

The repeatables mirror the perk tree's proven shape: a leaf data module, a pure logic
module with a narrow input, a `MOD_KIND` fold, and integration into existing formulas at
exactly four documented sites. They are the *earned, in-run* counterpart to perks (which
are *meta, prestige*).

## Goals

- Append tiers 5 and 6, both **unlock-gated** (`tier:5`, `tier:6`) by new milestones.
- Gate both `spawn` **and** `spawnMax`/buy-max behind the tier unlock (a locked tier cannot
  be bulk-bought).
- Extend the existing "higher tier boosts the tier below" `SYNERGY` pattern to the new tiers.
- Four infinite repeatables (income, RAM, heat, spawn cost) with an exponential cost curve
  and a `sqrt` diminishing effect.
- Integrate repeatables into the four documented formula sites; keep `baseCyclesPerSec`
  repeatable-free so the legacy-rate snapshot stays clean.
- Persist repeatable levels additively at `SAVE_VERSION` 8; old saves pad the two new tiers
  with `0` counts and default `repeatables` to `{}`.
- Keep the numeric watchdog quiet at high repeatable levels.
- Minimal UI: locked spawn rows reuse the `🔒 <name> · <unlockSource>` pattern; repeatables
  are four `addUpgrade(...)` rows labelled `<name> L<level>`.

## Non-goals

- A new architecture for gating. Tiers reuse the milestone `unlocks` model (ADR 0009).
- A repeatable reset, cap, or prestige interaction. Levels are permanent for the save.
- New metrics, new unlock record shapes, or a second income hook.
- Multiplying legacy-daemon income by repeatables (`baseCyclesPerSec` stays clean).
- Tier-specific traits. Both new tiers are `trait: "none"`.

## Decisions

1. **`TierDef.unlock?: string`.** Two rows appended (indices 5, 6), both `unlock`-gated; tiers
   0–4 carry no `unlock` and stay ungated. Numbers are tunable data; the curve stays steeper
   than tier 4's `1.22`.

   | # | name            | baseCost | costGrowth | baseOutput | ram | priority | trait | unlock   |
   | - | --------------- | -------- | ---------- | ---------- | --- | -------- | ----- | -------- |
   | 5 | k8s pod         | 1e6      | 1.25       | 3e4        | 24  | 5        | none  | `tier:5` |
   | 6 | bare-metal node | 1e8      | 1.3        | 5e5        | 32  | 6        | none  | `tier:6` |

2. **One gate helper.** `tierUnlocked(s, i) = !def.unlock || hasUnlock(s, def.unlock)`.
   `canSpawn` returns `false` when locked; `maxAffordable` returns `0` when locked — so
   `spawnMax` (buy-max) cannot bypass the gate, because it consumes `maxAffordable`.

3. **Tier unlocks are milestone-granted.** Two new `MILESTONES` rows:
   `tier-5` (`metric: "totalEarned"`, `at: 1e7`, `unlocks: ["tier:5"]`) and
   `tier-6` (`metric: "totalEarned"`, `at: 1e9`, `unlocks: ["tier:6"]`). Matching `UNLOCK`
   entries (`UNLOCK.tier5 = "tier:5"`, `UNLOCK.tier6 = "tier:6"`) keep the stable-id
   convention; the milestone `unlocks` array stays the source of truth.

4. **Synergy extends the same pattern.** Add `{ tier: 4, from: 5, pct: 0.03 }` (k8s pod
   boosts the cron daemon) and `{ tier: 5, from: 6, pct: 0.05 }` (bare-metal node boosts the
   k8s pod). Data edit only — `synergyMult` is already a loop over `SYNERGY`.

5. **Spawn UI lock.** A locked tier renders `🔒 <name> · <unlockSource(unlock)>` and is
   disabled, reusing the existing `unlockSource(id)` helper (which finds the granting
   milestone by name). Non-locked tiers are unchanged.

6. **Repeatables are data + pure logic, split like perks.** New leaf
   `src/config/repeatables.ts` (`RepeatableId`, `RepeatableDef { id, name, desc, baseCost,
   costGrowth, mod: keyof RepeatableMods, perLevel }`, `REPEATABLES`, `repeatableById`) and
   new pure `src/repeatables.ts` (`RepeatableMods`, `RepeatableInput`,
   `REPEATABLE_MOD_KIND`, `repeatableMods`, `repeatableCost`, `canBuyRepeatable`). No DOM,
   no runtime `sim.ts` import — a narrow `RepeatableInput` keeps it cycle-free.

7. **Diminishing-return fold, mirroring `perkMods`.** Magnitude is `perLevel * sqrt(level)`.
   `incomeMult` multiplies (`cur.mul(1 + mag)`), `ramCapAdd` adds, `tierCostMult` divides,
   `heatGenMult` divides. `RepeatableMods = { incomeMult: Decimal; ramCapAdd: number;
   tierCostMult: number; heatGenMult: number }`, identity at level 0. The exponential cost
   curve keeps the `sqrt` effect sub-linear in total spend.

8. **Roster: four rows.**

   | id          | effect            | `mod`          | baseCost | costGrowth | `perLevel` |
   | ----------- | ----------------- | -------------- | -------- | ---------- | ---------- |
   | `overclock` | +income           | `incomeMult`   | 1e6      | 1.6        | 0.1        |
   | `swapfile`  | +RAM cap          | `ramCapAdd`    | 5e6      | 1.7        | 4          |
   | `undervolt` | −heat equilibrium | `heatGenMult`  | 2e6      | 1.6        | 0.08       |
   | `bulk`      | −spawn cost       | `tierCostMult` | 2e6      | 1.7        | 0.05       |

   `bulk` makes the `tierCostMult` generator live: it feeds the `tierCost` discount, so the
   cost-reduction site is not dead wiring.

9. **Integration at exactly four sites (documented):**
   - `perkedBaseCyclesPerSec` multiplies income by `repeatableMods(s).incomeMult`.
   - `tierCost` multiplies by `repeatableMods(s).tierCostMult`.
   - `ramCapTotal` adds `repeatableMods(s).ramCapAdd`.
   - `heatEquilibrium` multiplies by `repeatableMods(s).heatGenMult`.

   `baseCyclesPerSec` is deliberately **not** touched, so `doFork`'s legacy-rate snapshot
   never bakes a repeatable multiplier in. Multiplying `tierCost` by a constant factor keeps
   `maxAffordable`'s closed form valid (it is linear in the next cost).

10. **State + action.** Add `repeatables: Record<string, number>` (default `{}`) to
    `GameState`/`newGame()`, and `buyRepeatable(s, id): boolean` in `sim.ts` (cost check,
    subtract, level++, log), mirroring `buyPerk`.

11. **Persistence.** `SAVE_VERSION` 7 → 8 with a **staged** `if (from < 8)` no-op;
    `sanitizeRepeatables(raw)` rebuilt from `REPEATABLES`, non-negative integer, capped at
    `MAX_SANE_COUNT` (drops zeros, mirrors `sanitizePerks`). `sanitizeCounts` already maps
    over `TIERS`, so a pre-v8 save's short `counts` array pads the new tiers with `0` — this
    is verified, not changed.

12. **UI.** Register the four repeatables as `addUpgrade(...)` rows in the existing upgrades
    panel, each labelled `<name> L${level}` with its cost and affordability (mirrors the
    `cooling` level-label pattern). No new HTML/CSS is required.

13. **Watchdog.** Exponential cost + `sqrt` effect keep every value finite; a test asserts
    `checkNumericHealth` is clean at a high repeatable level.

## Design

### Tiers and gating (`src/sim.ts`)

```ts
export interface TierDef {
  // ...existing fields...
  /** Milestone unlock id gating this tier; undefined = always available. */
  unlock?: string;
}

export function tierUnlocked(s: GameState, i: number): boolean {
  const def = TIERS[i];
  if (!def) return false;
  return !def.unlock || hasUnlock(s, def.unlock);
}

export function canSpawn(s: GameState, i: number): boolean {
  if (!tierUnlocked(s, i)) return false;
  const ramOk = ramUsed(s) + TIERS[i].ram <= ramCapTotal(s);
  return s.cycles.gte(tierCost(s, i)) && ramOk;
}

export function maxAffordable(s: GameState, i: number): number {
  const def = TIERS[i];
  if (!def || !tierUnlocked(s, i)) return 0;
  // ...unchanged closed form...
}
```

`DEFAULT_SACRIFICE_ORDER` and `sanitizeSacrificeOrder` are derived from `TIERS.length`, so
they pick up the two new tiers automatically. A pre-existing save's 5-element
`sacrificeOrder` fails the permutation check and is reset to the 7-element default (safe).

### Tier unlock milestones (`src/config/milestones.ts`)

```ts
export const UNLOCK = {
  // ...existing ids...
  tier5: "tier:5",
  tier6: "tier:6",
} as const;

// appended to MILESTONES:
{ id: "tier-5", name: "k8s pod", desc: "earn 10,000,000 cycles", metric: "totalEarned", at: 1e7, unlocks: [UNLOCK.tier5] },
{ id: "tier-6", name: "bare-metal node", desc: "earn 1,000,000,000 cycles", metric: "totalEarned", at: 1e9, unlocks: [UNLOCK.tier6] },
```

### Repeatables data (`src/config/repeatables.ts`)

```ts
import type { Decimal } from "../bignum"; // type-only: stays a leaf

export type RepeatableId = string;

/** Aggregate of every owned repeatable, applied by the sim. One field per effect kind. */
export interface RepeatableMods {
  incomeMult: Decimal; // multiply, >= 1
  ramCapAdd: number;   // add, >= 0
  tierCostMult: number; // divide in (0, 1]
  heatGenMult: number;  // divide in (0, 1]
}

export interface RepeatableDef {
  id: RepeatableId;
  name: string;
  desc: string;
  baseCost: number;
  costGrowth: number;          // per-level cost multiplier (exponential)
  mod: keyof RepeatableMods;   // which aggregate field this row feeds
  perLevel: number;            // magnitude per level (interpreted via REPEATABLE_MOD_KIND)
}

export const REPEATABLES: RepeatableDef[] = [ /* four rows above */ ];
export function repeatableById(id: RepeatableId): RepeatableDef | undefined { /* find */ }
```

### Repeatables logic (`src/repeatables.ts`)

```ts
export interface RepeatableInput {
  repeatables: Record<RepeatableId, number>;
  cycles: Decimal;
}

export type ModOp = "add" | "multiply" | "divide";
export const REPEATABLE_MOD_KIND: Record<keyof RepeatableMods, ModOp> = {
  incomeMult: "multiply",
  ramCapAdd: "add",
  tierCostMult: "divide",
  heatGenMult: "divide",
};

/** Fold every owned level; each contributes `perLevel * sqrt(level)`. Pure and cheap. */
export function repeatableMods(s: Pick<RepeatableInput, "repeatables">): RepeatableMods {
  // identity init: incomeMult d(1), ramCapAdd 0, tierCostMult 1, heatGenMult 1
  // for each REPEATABLES row with level > 0: apply REPEATABLE_MOD_KIND[mod] with mag = perLevel * sqrt(level)
}

/** Cost of the next level of `id`; `0` for an unknown id. */
export function repeatableCost(s: Pick<RepeatableInput, "repeatables">, id: RepeatableId): Decimal {
  const def = repeatableById(id);
  if (!def) return d(0);
  const level = s.repeatables[id] ?? 0;
  return d(def.baseCost).mul(d(def.costGrowth).pow(level));
}

/** True when `id` exists and `cycles` covers the next level. Unbounded in level. */
export function canBuyRepeatable(s: RepeatableInput, id: RepeatableId): boolean {
  const def = repeatableById(id);
  if (!def) return false;
  return s.cycles.gte(repeatableCost(s, id));
}
```

The fold is data-driven over `REPEATABLES` (a stale key in `repeatables` cannot affect the
aggregate), exactly like `perkMods` over `PERKS`.

### State, action, and integration (`src/sim.ts`)

```ts
/** Purchased level per repeatable id; a missing key means level 0. */
repeatables: Record<RepeatableId, number>;   // newGame(): {}

export function buyRepeatable(s: GameState, id: RepeatableId): boolean {
  if (!canBuyRepeatable(s, id)) return false;
  s.cycles = s.cycles.sub(repeatableCost(s, id));
  s.repeatables[id] = (s.repeatables[id] ?? 0) + 1;
  log(s, `repeatable: ${repeatableById(id)?.name ?? id} (L${s.repeatables[id]})`);
  return true;
}
```

Integration (four sites):

```
perkedBase = childOutput * survivalMult * perkIncomeMult * repeatableIncomeMult
           + rootOutput * perkIncomeMult * perkRootMult * repeatableIncomeMult
tierCost   = baseCost * costGrowth^count * perkTierCostMult * repeatableTierCostMult
ramCapTotal= ramCap + perkRamCapAdd + repeatableRamCapAdd
heatEq     = childRam * HEAT_PER_RAM / (HEAT_DECAY_RATE * (1 + cooling*0.5))
             * perkHeatGenMult * repeatableHeatGenMult
```

`baseCyclesPerSec` (the legacy snapshot source) is unchanged: repeatables are an in-run
earned layer, like perks, and must not be baked into a forked daemon's rate.

### Persistence (`src/persistence.ts`, `src/sim.ts`)

- `SAVE_VERSION` 7 → 8; extend the comment and add `if (from < 8)` (no-op, additive).
- `sanitizeRepeatables(raw)` mirrors `sanitizePerks`:
  ```ts
  export function sanitizeRepeatables(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    const rec = raw as Record<string, unknown>;
    for (const r of REPEATABLES) {
      const level = Math.min(MAX_SANE_COUNT, coerceCount(rec[r.id]));
      if (level > 0) out[r.id] = level;
    }
    return out;
  }
  ```
- `decode` wires `s.repeatables = sanitizeRepeatables(parsed.repeatables)`.
- **Tier padding:** `sanitizeCounts` already maps over `TIERS`, so `arr[5]`/`arr[6]` on a
  short array become `0`. No code change; a test pins it.

### UI (`src/main.ts`)

- **Spawn rows:** in the render loop, a locked tier sets its `.name` to
  `🔒 <name> <small><unlockSource(unlock)></small>` (guarded by a `dataset` signature so it
  is written once) and `enabled()` is already `false` via `canSpawn`.
- **Repeatable rows:** after the `nohup` upgrade,
  ```ts
  for (const r of REPEATABLES) {
    addUpgrade(
      () => `${r.name} L${state.repeatables[r.id] ?? 0}  ·  ${r.desc}`,
      () => repeatableCost(state, r.id),
      () => canBuyRepeatable(state, r.id),
      () => buyRepeatable(state, r.id),
    );
  }
  ```
  `addUpgrade`'s cost closure already returns a `Decimal`, so no HTML/CSS change is needed.

## Testing

- **Tier data:** `TIERS.length === 7`; indices 5/6 carry the right name/stats/`unlock`; 0–4
  have no `unlock`; `newGame().counts` has seven zeros.
- **Gate:** a locked tier refuses `spawn`, `canSpawn`, and `maxAffordable` even when
  affordable and RAM is free; `spawnMax` refuses with `buy-max` granted but the tier locked;
  granting the unlock enables `spawn` and increments the count.
- **Synergy:** `synergyMult` picks up the two new links.
- **Milestones:** `UNLOCK.tier5`/`tier6` values; `tier-5`/`tier-6` metric/`at`/`unlocks`;
  firing grants the unlock; roster uniqueness still holds.
- **Repeatables logic:** roster shape (unique ids, real mods, `costGrowth > 1`,
  `perLevel > 0`); identity at level 0; the `perLevel * sqrt(level)` fold for
  multiply/add/divide; `repeatableCost` exponential growth and `0` for unknown ids;
  `canBuyRepeatable` affordability and unbounded level.
- **Integration:** `rawCyclesPerSec` scales by `incomeMult` while `baseCyclesPerSec` is
  unchanged; `ramCapTotal` adds `ramCapAdd`; `heatEquilibrium` divides by `heatGenMult`;
  `tierCost` divides by `tierCostMult` (identity at level 0, discounted once `bulk` is owned).
- **Action:** `buyRepeatable` spends cycles, levels up, logs, and refuses unknown/affordable
  misses.
- **Watchdog:** `checkNumericHealth` is `[]` at a high repeatable level.
- **Persistence:** round-trip; `sanitizeRepeatables` roster-rebuild/clamp/drop-zeros/junk;
  pre-v8 save defaults `repeatables` to `{}` and stamps 8; a pre-v8 short `counts` array
  pads to seven entries with zeros.
- **UI:** drive the dev server, confirm a locked tier shows the `🔒 … <milestone>` hint and
  the four repeatable rows show `L<n>` with live cost/affordability; screenshot.

## Docs impact (lockstep)

- **New** `docs/architecture/012-repeatables.md` (data, logic, four integration sites,
  persistence, UI) and register it in `docs/architecture/README.md`.
- `docs/architecture/001-simulation-core.md` — the tier table (+2 rows + `unlock` column),
  the gate (`tierUnlocked`), the `SYNERGY` rows, the four repeatable integration sites, the
  `repeatables` state row, and `buyRepeatable`.
- `docs/architecture/002-render-system.md` — the locked spawn row and the repeatable upgrade
  rows.
- `docs/architecture/003-persistence.md` — `sanitizeRepeatables`, the version-8 row, "Why
  v8", and the tier-count padding note.
- `docs/architecture/010-milestones.md` — the two tier-grant milestones and the
  `UNLOCK.tier5`/`tier6` ids.
- **ADR** `docs/decisions/0013-diminishing-return-repeatables.md` — the exponential-cost /
  `sqrt`-effect design, the four integration sites, and why `baseCyclesPerSec` stays clean;
  register it in `docs/decisions/README.md`.
- `npm run check` green; a browser screenshot reporting the values.

## Risks / open questions

- **Curve tuning.** `costGrowth` 1.6–1.7 and `perLevel` magnitudes are first-pass data; the
  intent is that no single repeatable dominates and none runs away. The `tierCostMult`
  generator is live via the `bulk` row.
- **Bulk-buy interaction.** Because `maxAffordable` is gated, a locked tier cannot be
  bulk-bought; the closed form is linear in `tierCost`, so multiplying by `tierCostMult`
  stays correct if a future row sets it.
- **Test ripple.** `TIERS.length` 5 → 7 invalidates hardcoded `counts` literals in
  `src/sim.test.ts` and `src/persistence.test.ts`; they are padded to seven (mechanical).
- **Old sacrifice order.** A pre-v8 5-element `sacrificeOrder` resets to the 7-element
  default on load (documented, safe).

## Alternatives considered

- **Affordability-only tiers.** Rejected: the acceptance requires unlock-gating (B1), so the
  new tiers are a milestone goal, not just a bigger number.
- **A `repeatableMaxLevel` cap.** Rejected: repeatables are the long-run sink; a cap defeats
  the purpose. The `sqrt` effect plus exponential cost is the brake.
- **Linear (non-diminishing) repeatables.** Rejected: linear levels on an exponential cost
  curve still run away relative to spend; `sqrt` matches the proven perk sinks.
- **Apply `incomeMult` inside `baseCyclesPerSec`.** Rejected: `doFork` snapshots that value
  into legacy rates, so it would double-count — the same reason perks are applied in
  `perkedBase`.
- **Fold repeatables into `perkMods`.** Rejected: perks are prestige/meta and read a
  different input; mixing them conflates two currencies and two lifecycles.
- **A new `tierUnlocked` in the UI only.** Rejected: the gate must be a sim rule so
  `spawn`/`spawnMax` cannot bypass it; the UI mirrors the sim.
