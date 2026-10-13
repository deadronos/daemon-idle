# More Tiers + Infinite Repeatable Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append two unlock-gated tiers and four infinite, diminishing-return repeatable upgrades; persist repeatable levels additively at `SAVE_VERSION` 8; keep the numeric watchdog quiet.

**Architecture:** `TIERS`/`TierDef` gain an `unlock?: string` gate enforced by a new `tierUnlocked` in `src/sim.ts`, granted by two new `MILESTONES` rows. New leaf `src/config/repeatables.ts` (data + types) and pure `src/repeatables.ts` (narrow `RepeatableInput`, `MOD_KIND`-style fold) mirror the perk tree. `src/sim.ts` owns the state field, `buyRepeatable`, and the four integration sites; `src/persistence.ts` sanitizes and migrates (v8); `src/main.ts` renders the locked spawn rows and four upgrade rows.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-13-tiers-repeatables-design.md`](../specs/2026-10-13-tiers-repeatables-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on — no dead imports.
- Unbounded values use `Decimal` from `src/bignum.ts`; `RepeatableDef.baseCost`/`perLevel` are plain numbers.
- `src/repeatables.ts` has **no DOM** and **no runtime `GameState` import** — narrow `RepeatableInput` only; `repeatables → config/repeatables` is the only import direction.
- Tiers reuse the milestone `unlocks` model (ADR 0009); no new gating mechanism.
- The gate is a **sim rule**: `canSpawn` false and `maxAffordable` 0 for a locked tier, so `spawnMax` cannot bypass it.
- Repeatables integrate at **exactly four** sites; `baseCyclesPerSec` stays repeatable-free (legacy snapshot).
- New persistent field `repeatables` defaults to `{}` in `newGame()` (additive-safe).
- `SAVE_VERSION` bumps 7 → 8 with a **staged** `if (from < 8)` no-op; never a single `< SAVE_VERSION` check.
- Run commands must not be piped; `npm run check` green.

## Review Focus

Failure modes the spec implies — each gets a test in its owning task:

1. **Locked-tier gate:** a locked tier refuses `canSpawn`, `spawn`, `maxAffordable`, and `spawnMax` (even with `buy-max` granted); granting the unlock enables `spawn` (Task 1).
2. **Tier milestones:** `tier-5`/`tier-6` grant `tier:5`/`tier:6`; roster uniqueness and non-empty unlocks still hold (Task 2).
3. **Repeatable cost + diminishing fold:** exponential cost; `perLevel * sqrt(level)` for multiply/add/divide; identity at level 0 (Task 3).
4. **Integration at all four sites:** `rawCyclesPerSec` scales by `incomeMult` while `baseCyclesPerSec` is unchanged; `ramCapTotal` adds `ramCapAdd`; `heatEquilibrium` divides by `heatGenMult`; `tierCost` divides by `tierCostMult` (identity at level 0; discounted once `bulk` is owned) (Task 4).
5. **Watchdog quiet:** `checkNumericHealth` is `[]` at a high repeatable level (Task 4).
6. **Old saves:** a pre-v8 short `counts` array pads the two new tiers with `0`; `repeatables` defaults to `{}`; the staged `if (from < 8)` step and `SAVE_VERSION === 8` (Task 5).
7. **UI:** a locked tier shows `🔒 <name> · <milestone>` and is disabled; four repeatable rows show `L<n>` with live cost/affordability (Tasks 1, 4).

---

### Task 1: Tiers — data, gating, synergy, spawn-panel lock

**Files:**
- Modify: `src/sim.ts`, `src/main.ts`
- Test: `src/sim.test.ts`, `src/persistence.test.ts` (count-length expectations only)

**Interfaces:**
- Produces: `TierDef.unlock?: string`; `TIERS` indices 5–6; `tierUnlocked(s, i): boolean`; gated `canSpawn`/`maxAffordable`; two new `SYNERGY` links.
- Consumes: `UNLOCK.tier5`/`UNLOCK.tier6` (added in Task 2 — for this task use the literal `"tier:5"`/`"tier:6"` and switch to `UNLOCK.*` in Task 2; the tests below reference `UNLOCK.tier5` and so run **after** Task 2's constants exist — see the ordering note).

> **Ordering note:** the tests below reference `UNLOCK.tier5`/`tier6`. Add those two constants to `src/config/milestones.ts` (the `UNLOCK` object only) as the first step of Task 1; Task 2 adds the milestone rows. This keeps Task 1 runnable on its own.

- [ ] **Step 1: Write the failing tests** in `src/sim.test.ts` (add `tierUnlocked` to the `./sim` import list):

```ts
describe("tier unlocks", () => {
  it("appends two unlock-gated tiers and leaves 0-4 ungated", () => {
    expect(TIERS.length).toBe(7);
    expect(TIERS[5]).toMatchObject({ name: "k8s pod", unlock: UNLOCK.tier5 });
    expect(TIERS[6]).toMatchObject({ name: "bare-metal node", unlock: UNLOCK.tier6 });
    for (let i = 0; i < 5; i++) expect(TIERS[i].unlock).toBeUndefined();
  });

  it("starts with one zero count per tier", () => {
    expect(newGame().counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses spawn and buy-max for a locked tier even when affordable", () => {
    const s = newGame();
    s.cycles = d(1e12);
    s.ramCap = 1000;
    s.unlocks[UNLOCK.buyMax] = true; // isolate the tier gate from the buy-max gate
    expect(tierUnlocked(s, 5)).toBe(false);
    expect(canSpawn(s, 5)).toBe(false);
    expect(maxAffordable(s, 5)).toBe(0);
    expect(spawn(s, 5)).toBe(false);
    expect(spawnMax(s, 5)).toBe(false);
    expect(s.counts[5]).toBe(0);
  });

  it("allows spawn once the unlock is granted", () => {
    const s = newGame();
    s.cycles = d(1e12);
    s.ramCap = 1000;
    s.unlocks[UNLOCK.tier5] = true;
    expect(tierUnlocked(s, 5)).toBe(true);
    expect(canSpawn(s, 5)).toBe(true);
    expect(spawn(s, 5)).toBe(true);
    expect(s.counts[5]).toBe(1);
  });

  it("links the new tiers into SYNERGY (higher boosts lower)", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 0, 0, 10]; // 10 bare-metal nodes
    expect(synergyMult(s, 5)).toBeCloseTo(1 + 0.05 * 10, 10);
    s.counts = [0, 0, 0, 0, 0, 10, 0]; // 10 k8s pods
    expect(synergyMult(s, 4)).toBeCloseTo(1 + 0.03 * 10, 10);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/sim.test.ts > /tmp/tiers.log 2>&1; echo exit=$?`
  → FAIL: `TIERS.length` is 5 and `tierUnlocked` is not exported.

- [ ] **Step 3: Implement**

- `src/config/milestones.ts` — add the two ids (rows come in Task 2):
  ```ts
  export const UNLOCK = {
    // ...existing ids...
    tier5: "tier:5",
    tier6: "tier:6",
  } as const;
  ```
- `src/sim.ts` — extend `TierDef` and append two rows to `TIERS`:
  ```ts
  export interface TierDef {
    // ...existing fields...
    /** Milestone unlock id gating this tier; undefined = always available. */
    unlock?: string;
  }
  // appended:
  { name: "k8s pod", desc: "it has a namespace and everything", baseCost: 1e6, costGrowth: 1.25,
    baseOutput: 3e4, ram: 24, priority: 5, trait: "none", unlock: UNLOCK.tier5 },
  { name: "bare-metal node", desc: "you own the rack now", baseCost: 1e8, costGrowth: 1.3,
    baseOutput: 5e5, ram: 32, priority: 6, trait: "none", unlock: UNLOCK.tier6 },
  ```
  (`UNLOCK` is already imported by `sim.ts`.)
- `src/sim.ts` — add the gate helper and use it:
  ```ts
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
    // ...rest unchanged...
  }
  ```
- `src/sim.ts` — extend `SYNERGY` (data only):
  ```ts
  { tier: 4 /* cron daemon */, from: 5 /* k8s pod */, pct: 0.03 },
  { tier: 5 /* k8s pod */, from: 6 /* bare-metal node */, pct: 0.05 },
  ```
- `src/main.ts` — import `tierUnlocked`; in the spawn render loop (inside `render()`, the
  `for (let i = 0; i < spawnButtons.length; i++)` block) write the lock label once:
  ```ts
  const locked = !tierUnlocked(state, i);
  const nameEl = b.el.querySelector(".name") as HTMLElement;
  const lockSig = locked ? "1" : "0";
  if (nameEl.dataset.locked !== lockSig) {
    nameEl.dataset.locked = lockSig;
    nameEl.innerHTML = locked
      ? `🔒 ${TIERS[i].name} <small>${unlockSource(TIERS[i].unlock!)}</small>`
      : `${TIERS[i].name} <small>${TIERS[i].desc}</small>`;
  }
  ```
- **Test ripple (mechanical):** pad every hardcoded `counts`/`sacrificeOrder` literal in
  `src/sim.test.ts` and `src/persistence.test.ts` to length 7:
  - `counts` literals `[100,0,0,0,0]`, `[10,0,0,0,0]`, `[10,10,0,0,0]`, `[5,5,5,5,5]`,
    `[0,0,0,0,0]` → append `, 0, 0` (or `[0,0,0,0,0,0,0]`).
  - sacrifice-order literals `[0,1,2,3,4]` → `[0,1,2,3,4,5,6]`; `[1,0,2,3,4]` →
    `[1,0,2,3,4,5,6]`; `movePriority(s, 4, 1)` (was "past the end") → `movePriority(s, 6, 1)`;
    the `movePriority(s, 4, -1)` expectation → `[0,1,2,4,3,5,6]`.
  - **Leave** the `victims` index expectation `[0, 0, 0, 0, 0]` alone — it is tier indices,
    not counts.
  - `src/persistence.test.ts` lines asserting `s.counts).toEqual([0, 0, 0, 0, 0])` → seven zeros.

- [ ] **Step 4: Run to verify it passes** — the `TIERS.length` change ripples, so run the whole suite:
  `npx vp test run > /tmp/tiers.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/main.ts src/config/milestones.ts src/sim.test.ts src/persistence.test.ts
git commit -m "feat(tiers): two unlock-gated tiers, gated spawn/buy-max, synergy, locked UI (#23)"
```

---

### Task 2: Tier unlock milestones

**Files:**
- Modify: `src/config/milestones.ts`
- Test: `src/milestones.test.ts`

**Interfaces:**
- Consumes: `UNLOCK.tier5`/`tier6` (Task 1), `evaluateMilestones`/`hasUnlock` (existing).
- Produces: `MILESTONES` rows `tier-5` (`totalEarned >= 1e7` → `tier:5`) and `tier-6` (`totalEarned >= 1e9` → `tier:6`).

- [ ] **Step 1: Write the failing tests** in `src/milestones.test.ts` (imports already include `milestoneById`, `evaluateMilestones`, `hasUnlock`, `UNLOCK`; add `d` is already imported):

```ts
describe("tier unlock milestones", () => {
  it("declares tier unlock ids", () => {
    expect(UNLOCK.tier5).toBe("tier:5");
    expect(UNLOCK.tier6).toBe("tier:6");
  });

  it("grants tier:5 at 1e7 and tier:6 at 1e9 totalEarned", () => {
    expect(milestoneById("tier-5")).toMatchObject({
      metric: "totalEarned",
      at: 1e7,
      unlocks: [UNLOCK.tier5],
    });
    expect(milestoneById("tier-6")).toMatchObject({
      metric: "totalEarned",
      at: 1e9,
      unlocks: [UNLOCK.tier6],
    });
  });

  it("fires the tier-5 milestone and grants the unlock", () => {
    const s = base({ totalEarned: d(1e7) });
    expect(evaluateMilestones(s)).toContain("tier-5");
    expect(hasUnlock(s, UNLOCK.tier5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/milestones.test.ts > /tmp/tier-ms.log 2>&1; echo exit=$?`
  → FAIL: `milestoneById("tier-5")` is `undefined`.

- [ ] **Step 3: Implement** — append two rows to `MILESTONES` in `src/config/milestones.ts`:
  ```ts
  {
    id: "tier-5",
    name: "k8s pod",
    desc: "earn 10,000,000 cycles",
    metric: "totalEarned",
    at: 1e7,
    unlocks: [UNLOCK.tier5],
  },
  {
    id: "tier-6",
    name: "bare-metal node",
    desc: "earn 1,000,000,000 cycles",
    metric: "totalEarned",
    at: 1e9,
    unlocks: [UNLOCK.tier6],
  },
  ```
  (The existing roster-shape test requires `unlocks.length > 0` — both rows satisfy it.)

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/milestones.test.ts src/sim.test.ts > /tmp/tier-ms.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/milestones.ts src/milestones.test.ts
git commit -m "feat(milestones): tier-5/tier-6 unlock milestones (#23)"
```

---

### Task 3: Repeatables — data and pure logic

**Files:**
- Create: `src/config/repeatables.ts`, `src/repeatables.ts`
- Test: `src/repeatables.test.ts`

**Interfaces:**
- Produces (config): `RepeatableId`, `RepeatableMods`, `RepeatableDef { id, name, desc, baseCost, costGrowth, mod, perLevel }`, `REPEATABLES`, `repeatableById`.
- Produces (logic): `RepeatableInput { repeatables, cycles }`, `REPEATABLE_MOD_KIND`, `repeatableMods(s): RepeatableMods`, `repeatableCost(s, id): Decimal`, `canBuyRepeatable(s, id): boolean`.

- [ ] **Step 1: Write the failing tests** in `src/repeatables.test.ts` (new file):

```ts
import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  REPEATABLES,
  REPEATABLE_MOD_KIND,
  canBuyRepeatable,
  repeatableById,
  repeatableCost,
  repeatableMods,
  type RepeatableInput,
} from "./repeatables";

const s = (over: Partial<RepeatableInput> = {}): RepeatableInput => ({
  repeatables: {},
  cycles: d(0),
  ...over,
});

describe("repeatable roster", () => {
  it("has unique ids, real mods, and an exponential cost curve", () => {
    const ids = REPEATABLES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(REPEATABLES).toHaveLength(4);
    for (const r of REPEATABLES) {
      expect(r.mod in REPEATABLE_MOD_KIND).toBe(true);
      expect(r.costGrowth).toBeGreaterThan(1);
      expect(r.perLevel).toBeGreaterThan(0);
    }
    expect(repeatableById("overclock")?.mod).toBe("incomeMult");
    expect(repeatableById("bulk")?.mod).toBe("tierCostMult");
  });
});

describe("repeatableMods (diminishing returns)", () => {
  it("is identity at level 0", () => {
    const m = repeatableMods(s());
    expect(m.incomeMult.toNumber()).toBe(1);
    expect(m.ramCapAdd).toBe(0);
    expect(m.tierCostMult).toBe(1);
    expect(m.heatGenMult).toBe(1);
  });

  it("folds perLevel * sqrt(level) with the right op per mod", () => {
    const m = repeatableMods(
      s({ repeatables: { overclock: 4, swapfile: 4, undervolt: 4, bulk: 4 } }),
    );
    expect(m.incomeMult.toNumber()).toBeCloseTo(1 + 0.1 * 2, 10); // 1.2
    expect(m.ramCapAdd).toBeCloseTo(4 * 2, 10); // 8
    expect(m.heatGenMult).toBeCloseTo(1 / (1 + 0.08 * 2), 10);
    expect(m.tierCostMult).toBeCloseTo(1 / (1 + 0.05 * 2), 10);
  });
});

describe("repeatableCost", () => {
  it("grows exponentially with level and is 0 for an unknown id", () => {
    expect(repeatableCost(s(), "overclock").toNumber()).toBeCloseTo(1e6, 0);
    expect(repeatableCost(s({ repeatables: { overclock: 3 } }), "overclock").toNumber()).toBeCloseTo(
      1e6 * 1.6 ** 3,
      0,
    );
    expect(repeatableCost(s(), "nope").toNumber()).toBe(0);
  });
});

describe("canBuyRepeatable", () => {
  it("is affordability-gated, unbounded in level, and refuses unknown ids", () => {
    expect(canBuyRepeatable(s({ cycles: d(1e6) }), "overclock")).toBe(true);
    expect(canBuyRepeatable(s({ cycles: d(1e6 - 1) }), "overclock")).toBe(false);
    expect(canBuyRepeatable(s({ cycles: d(1e9) }), "nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/repeatables.test.ts > /tmp/repeat.log 2>&1; echo exit=$?`
  → FAIL: `./repeatables` does not exist.

- [ ] **Step 3: Implement**

- `src/config/repeatables.ts` — the leaf data module:
  ```ts
  // Repeatable-upgrade data and types for `daemon`.
  //
  // Pure data + types, no runtime imports (the `Decimal` import is type-only and erased),
  // so this stays a leaf module that `src/repeatables.ts` reads.

  import type { Decimal } from "../bignum";

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
    costGrowth: number;        // per-level cost multiplier (exponential)
    mod: keyof RepeatableMods; // which aggregate field this row feeds
    perLevel: number;          // magnitude per level (interpreted via REPEATABLE_MOD_KIND)
  }

  export const REPEATABLES: RepeatableDef[] = [
    { id: "overclock", name: "overclock", desc: "+income, sub-linear", baseCost: 1e6, costGrowth: 1.6, mod: "incomeMult", perLevel: 0.1 },
    { id: "swapfile", name: "swapfile", desc: "+RAM cap, sub-linear", baseCost: 5e6, costGrowth: 1.7, mod: "ramCapAdd", perLevel: 4 },
    { id: "undervolt", name: "undervolt", desc: "-heat equilibrium, sub-linear", baseCost: 2e6, costGrowth: 1.6, mod: "heatGenMult", perLevel: 0.08 },
    { id: "bulk", name: "bulk discount", desc: "spawns get cheaper as you buy in bulk", baseCost: 2e6, costGrowth: 1.7, mod: "tierCostMult", perLevel: 0.05 },
  ];

  export function repeatableById(id: RepeatableId): RepeatableDef | undefined {
    return REPEATABLES.find((r) => r.id === id);
  }
  ```
- `src/repeatables.ts` — the pure logic:
  ```ts
  // Pure repeatable-upgrade logic for `daemon`. No DOM and no runtime `GameState` import —
  // the helpers read a narrow `RepeatableInput`. Mutating actions and the formula
  // integration live in `src/sim.ts`.

  import { d, type Decimal } from "./bignum";
  import {
    REPEATABLES,
    repeatableById,
    type RepeatableId,
    type RepeatableMods,
  } from "./config/repeatables";

  export * from "./config/repeatables";

  /** The slice of game state the repeatable helpers read. `GameState` satisfies it. */
  export interface RepeatableInput {
    repeatables: Record<RepeatableId, number>;
    cycles: Decimal;
  }

  export type ModOp = "add" | "multiply" | "divide";

  /** How each aggregate field is folded from a row's per-level magnitude. */
  export const REPEATABLE_MOD_KIND: Record<keyof RepeatableMods, ModOp> = {
    incomeMult: "multiply",
    ramCapAdd: "add",
    tierCostMult: "divide",
    heatGenMult: "divide",
  };

  /** Aggregate fields that are `Decimal` rather than plain numbers. */
  const DECIMAL_MODS = new Set<keyof RepeatableMods>(["incomeMult"]);

  /**
   * Fold every owned level into one aggregate. Pure and cheap (4 rows), so callers may
   * invoke it freely. Each row contributes `perLevel * sqrt(level)`; the exponential cost
   * curve keeps the effect sub-linear in total spend.
   */
  export function repeatableMods(s: Pick<RepeatableInput, "repeatables">): RepeatableMods {
    const m: RepeatableMods = {
      incomeMult: d(1),
      ramCapAdd: 0,
      tierCostMult: 1,
      heatGenMult: 1,
    };
    const mm = m as unknown as Record<keyof RepeatableMods, Decimal | number>;
    for (const r of REPEATABLES) {
      const level = s.repeatables[r.id] ?? 0;
      if (level <= 0) continue;
      const mag = r.perLevel * Math.sqrt(level);
      const op = REPEATABLE_MOD_KIND[r.mod];
      if (DECIMAL_MODS.has(r.mod)) {
        const cur = mm[r.mod] as Decimal;
        mm[r.mod] = op === "multiply" ? cur.mul(1 + mag) : cur.add(mag);
      } else {
        const cur = mm[r.mod] as number;
        mm[r.mod] = op === "multiply" ? cur * (1 + mag) : op === "divide" ? cur / (1 + mag) : cur + mag;
      }
    }
    return m;
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

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/repeatables.test.ts > /tmp/repeat.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/repeatables.ts src/repeatables.ts src/repeatables.test.ts
git commit -m "feat(repeatables): data-driven roster and diminishing-return pure logic (#23)"
```

---

### Task 4: Repeatables — state, four-site integration, action, and UI rows

**Files:**
- Modify: `src/sim.ts`, `src/main.ts`
- Test: `src/sim.test.ts`, `src/diagnostics.test.ts`

**Interfaces:**
- Consumes: `repeatableMods`, `repeatableCost`, `canBuyRepeatable`, `repeatableById`, `REPEATABLES` (Task 3).
- Produces: `GameState.repeatables: Record<string, number>` (default `{}`); `buyRepeatable(s, id): boolean`; the four integration sites; four upgrade rows.

- [ ] **Step 1: Write the failing tests** in `src/sim.test.ts` (add `buyRepeatable` to the `./sim` import):

```ts
describe("repeatable integration", () => {
  it("scales perked income by incomeMult but leaves baseCyclesPerSec clean", () => {
    const modded = newGame();
    modded.repeatables.overclock = 4; // mag 0.2
    expect(rawCyclesPerSec(modded).toNumber()).toBeCloseTo(
      rawCyclesPerSec(newGame()).toNumber() * 1.2,
      10,
    );
    const clean = newGame();
    clean.repeatables.overclock = 4;
    expect(baseCyclesPerSec(clean).eq(baseCyclesPerSec(newGame()))).toBe(true);
  });

  it("lifts the RAM cap by ramCapAdd", () => {
    const s = newGame();
    s.repeatables.swapfile = 4; // +8
    expect(ramCapTotal(s)).toBe(BASE.ramCap + 8);
  });

  it("lowers heat equilibrium by heatGenMult", () => {
    const base = newGame();
    base.counts = [0, 0, 0, 0, 10, 0, 0];
    const modded = newGame();
    modded.counts = [0, 0, 0, 0, 10, 0, 0];
    modded.repeatables.undervolt = 4; // /1.16
    expect(heatEquilibrium(modded)).toBeCloseTo(heatEquilibrium(base) / 1.16, 8);
  });
});

describe("buyRepeatable", () => {
  it("spends cycles, levels up, and refuses unaffordable/unknown ids", () => {
    const s = newGame();
    s.cycles = d(1e6);
    expect(buyRepeatable(s, "overclock")).toBe(true);
    expect(s.repeatables.overclock).toBe(1);
    expect(s.cycles.lt(d(1e6))).toBe(true);
    expect(buyRepeatable(s, "nope")).toBe(false);
    expect(buyRepeatable(newGame(), "overclock")).toBe(false);
  });
});
```

And in `src/diagnostics.test.ts`:

```ts
describe("repeatables and the watchdog", () => {
  it("stays quiet at a high repeatable level", () => {
    const s = newGame();
    s.repeatables = { overclock: 1e6, swapfile: 1e6, undervolt: 1e6 };
    s.cycles = d(1e12);
    s.counts = [0, 0, 0, 0, 0, 0, 0];
    expect(checkNumericHealth(s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/sim.test.ts src/diagnostics.test.ts > /tmp/repeat-int.log 2>&1; echo exit=$?`
  → FAIL: `repeatables` is missing and `buyRepeatable` is not exported.

- [ ] **Step 3: Implement** in `src/sim.ts`:

- Imports:
  ```ts
  import { type RepeatableId } from "./config/repeatables";
  import { canBuyRepeatable, repeatableById, repeatableCost, repeatableMods } from "./repeatables";
  ```
- `GameState` (beside `perks`):
  ```ts
  /** Purchased level per repeatable id; a missing key means level 0. */
  repeatables: Record<RepeatableId, number>;
  ```
- `newGame()`: `repeatables: {},`.
- Integration (four sites):
  ```ts
  // tierCost
  export function tierCost(s: GameState, i: number): Decimal {
    return d(TIERS[i].baseCost)
      .mul(d(TIERS[i].costGrowth).pow(s.counts[i]))
      .mul(perkMods(s).tierCostMult)
      .mul(repeatableMods(s).tierCostMult);
  }

  // ramCapTotal
  export function ramCapTotal(s: GameState): number {
    return s.ramCap + perkMods(s).ramCapAdd + repeatableMods(s).ramCapAdd;
  }

  // heatEquilibrium — append to the product
  //   ... * perkMods(s).heatGenMult * repeatableMods(s).heatGenMult

  // perkedBaseCyclesPerSec
  function perkedBaseCyclesPerSec(s: GameState): Decimal {
    const m = perkMods(s);
    const r = repeatableMods(s);
    const children = childOutput(s).mul(survivalMult(s)).mul(m.incomeMult).mul(r.incomeMult);
    const root = d(BASE.rootOutput).mul(m.incomeMult).mul(m.rootMult).mul(r.incomeMult);
    return children.add(root);
  }
  ```
  Leave `baseCyclesPerSec` untouched (repeatable-free legacy snapshot).
- Action (beside `buyPerk`):
  ```ts
  export function buyRepeatable(s: GameState, id: RepeatableId): boolean {
    if (!canBuyRepeatable(s, id)) return false;
    s.cycles = s.cycles.sub(repeatableCost(s, id));
    s.repeatables[id] = (s.repeatables[id] ?? 0) + 1;
    log(s, `repeatable: ${repeatableById(id)?.name ?? id} (L${s.repeatables[id]})`);
    return true;
  }
  ```
- `src/main.ts` — imports:
  ```ts
  import { buyRepeatable } from "./sim";
  import { REPEATABLES, canBuyRepeatable, repeatableCost } from "./repeatables";
  ```
  Register the rows after the `nohup` `addUpgrade(...)` call (before `// --- render ---`):
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

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/sim.test.ts src/diagnostics.test.ts > /tmp/repeat-int.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/main.ts src/sim.test.ts src/diagnostics.test.ts
git commit -m "feat(sim): repeatable state, four-site integration, action, and UI rows (#23)"
```

---

### Task 5: Persistence — sanitize, staged v8, old-save padding

**Files:**
- Modify: `src/sim.ts` (the `SAVE_VERSION` constant + comment only), `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `REPEATABLES` (Task 3), `GameState.repeatables` (Task 4), `sanitizeCounts` (existing).
- Produces: `SAVE_VERSION === 8`; `sanitizeRepeatables(raw): Record<string, number>`; `decode` wires the record and runs the staged `if (from < 8)` no-op.

- [ ] **Step 1: Write the failing tests** in `src/persistence.test.ts` (add `sanitizeRepeatables` to the `./persistence` import):

```ts
describe("repeatables persistence", () => {
  it("round-trips repeatable levels", () => {
    const s = newGame();
    s.repeatables.overclock = 3;
    expect(decode(encode(s)).repeatables).toEqual({ overclock: 3 });
  });

  it("sanitizeRepeatables rebuilds from the roster, clamps, and drops zeros/junk", () => {
    expect(sanitizeRepeatables({ overclock: 3, bogus: 9 })).toEqual({ overclock: 3 });
    expect(sanitizeRepeatables({ overclock: 0 })).toEqual({});
    expect(sanitizeRepeatables({ overclock: 1e9 })).toEqual({ overclock: MAX_SANE_COUNT });
    expect(sanitizeRepeatables(null)).toEqual({});
    expect(sanitizeRepeatables([])).toEqual({});
  });

  it("loads a pre-v8 save with defaults and stamps version 8", () => {
    const s = decode('{"saveVersion":7}');
    expect(s.repeatables).toEqual({});
    expect(s.saveVersion).toBe(8);
    expect(SAVE_VERSION).toBe(8);
  });

  it("pads a pre-v8 save's short counts array with zeros for the new tiers", () => {
    const s = decode('{"saveVersion":7,"counts":[1,2,3,4,5]}');
    expect(s.counts).toEqual([1, 2, 3, 4, 5, 0, 0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/persistence.test.ts > /tmp/repeat-persist.log 2>&1; echo exit=$?`
  → FAIL: `sanitizeRepeatables` is not exported and `SAVE_VERSION` is still 7.

- [ ] **Step 3: Implement**

- `src/sim.ts` — bump the version and extend the comment:
  ```ts
  /**
   * ... Version 7 added `achievementsDone` (additive). Version 8 added `repeatables`
   * (additive). Versions 3–8 are additive.
   */
  export const SAVE_VERSION = 8;
  ```
- `src/persistence.ts`:
  - Import the roster: `import { REPEATABLES } from "./config/repeatables";`.
  - Add the sanitizer (mirrors `sanitizePerks`; no `maxLevel`, so only `MAX_SANE_COUNT`):
    ```ts
    /**
     * Repeatable levels: read each known row's level, clamp to `MAX_SANE_COUNT`, and drop
     * zeros and unknown ids (the result is rebuilt from `REPEATABLES`, so a stale id never
     * survives). A non-object (including an array) yields `{}`.
     */
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
  - In `decode`, beside `s.perks = sanitizePerks(parsed.perks)`:
    ```ts
    s.repeatables = sanitizeRepeatables(parsed.repeatables);
    ```
  - Extend the staged-migration comment block:
    ```ts
    // from < 8: `repeatables` is additive too — newGame() defaults it to {} and the roster
    // rebuilds it in `sanitizeRepeatables`; short `counts` arrays pad the new tiers with 0
    // in `sanitizeCounts`.
    ```
  - **Existing-test update:** the achievements migration test
    (`"loads a pre-v7 save with an empty record and stamps version 7"`) currently asserts
    `SAVE_VERSION === 7`; update it to `8` and rename it to pre-v8. (`decode('{"saveVersion":6}')`
    still yields `achievementsDone: {}`.)

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/persistence.test.ts > /tmp/repeat-persist.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): sanitize repeatables and stage v8 (#23)"
```

---

### Task 6: Docs lockstep + ADR

**Files:**
- Create: `docs/architecture/012-repeatables.md`, `docs/decisions/0013-diminishing-return-repeatables.md`
- Modify: `docs/architecture/README.md`, `docs/architecture/001-simulation-core.md`,
  `docs/architecture/002-render-system.md`, `docs/architecture/003-persistence.md`,
  `docs/architecture/010-milestones.md`, `docs/decisions/README.md`

- [ ] **Step 1: `012-repeatables.md`** — the roster table, `RepeatableDef`/`RepeatableMods`, the
  pure logic (`repeatableMods`/`repeatableCost`/`canBuyRepeatable`), the **four integration
  sites**, `buyRepeatable`, persistence (v8), and the upgrade-panel rows. Register it in
  `docs/architecture/README.md` (`012-repeatables.md`).
- [ ] **Step 2: `001`** — extend the tier table with rows 5–6 and an `unlock` column; document
  `tierUnlocked` and the `canSpawn`/`maxAffordable` gate; add the two `SYNERGY` rows to the
  synergy table; add the `repeatables` state row; add the four repeatable factors to the
  income/RAM/heat/`tierCost` formulas; add `buyRepeatable`; note `baseCyclesPerSec` stays
  repeatable-free.
- [ ] **Step 3: `002`** — the locked spawn row (`🔒 <name> · <milestone>`) and the four
  repeatable `addUpgrade` rows (`<name> L<n>`, level-label pattern like `cooling`).
- [ ] **Step 4: `003`** — the `repeatables → sanitizeRepeatables` coercion bullet, the
  `| < 8 | 8 | Additive only … |` table row, a "Why v8" paragraph, and a note that
  `sanitizeCounts` pads short `counts` arrays for the two new tiers; update the
  `SAVE_VERSION = 8` stamp sentence.
- [ ] **Step 5: `010`** — add the `tier-5`/`tier-6` rows to the starter-set table and document
  the `UNLOCK.tier5`/`tier6` ids (the `tier:<index>` convention).
- [ ] **Step 6: ADR `0013-diminishing-return-repeatables.md`** — Context (five uniform tiers,
  no infinite scaling), Decision (exponential cost + `perLevel * sqrt(level)` fold; four
  integration sites; `baseCyclesPerSec` clean; data-driven roster), rejected alternatives
  (linear levels, a level cap, folding into `perkMods`, applying in `baseCyclesPerSec`), and
  Consequences (v8 additive; `tierCostMult` live via `bulk`). Register it in
  `docs/decisions/README.md`.
- [ ] **Step 7: Run `npm run check`** —
  `npm run check > /tmp/check.log 2>&1; echo exit=$?` → typecheck + lint + tests all PASS.
- [ ] **Step 8: Verify in the browser.** Run `npm run dev`, open `http://127.0.0.1:5173` with
  the browser tool. Confirm the two locked tier rows show `🔒 <name> · k8s pod`-style hints
  and are disabled; seed `state.unlocks["tier:5"] = true` (or `totalEarned`) in the console and
  confirm the row enables; confirm the four repeatable rows show `L0` with live cost and turn
  green when affordable. Screenshot and report the values.
- [ ] **Step 9: Commit**

```bash
git add docs
git commit -m "docs: repeatables, tier gating, and ADR 0013 (#23)"
```

---

## Self-Review

**Spec coverage:** decisions 1–2 (tier data + gate) and 5 (spawn UI) → Task 1; decision 3
(tier milestones) → Task 2; decisions 6–8 (repeatable data + logic + roster) → Task 3;
decisions 9–13 (integration, state, action, UI, watchdog) → Task 4; decisions 10–11
(persistence/version) → Task 5; decision 12/docs → Task 6. Review Focus items 1–7 map to
Tasks 1, 2, 3/4, 4, 4, 1/5, 1/4.

**Type consistency:** `TierDef.unlock` is `string | undefined`; `tierUnlocked` is spelled
identically in `sim.ts`, `main.ts`, and the docs. `RepeatableId`/`RepeatableDef`/
`REPEATABLES`/`repeatableById` are defined once in `src/config/repeatables.ts` and
re-exported by `src/repeatables.ts`; `RepeatableMods` field names (`incomeMult`, `ramCapAdd`,
`tierCostMult`, `heatGenMult`) match `REPEATABLE_MOD_KIND` and the four integration sites.
`repeatables` and `SAVE_VERSION = 8` are spelled consistently across `sim.ts`,
`persistence.ts`, `main.ts`, and the docs.

**Decisions pinned where the spec was silent:** the gate tests grant `buy-max` but not the
tier, so `spawnMax`'s refusal isolates the tier gate from the buy-max gate; the integration
tests use the empty board (root = 1 cycle/s) so `rawCyclesPerSec` scales cleanly and
`baseCyclesPerSec` is compared directly; the heat test gives both boards ten cron daemons so
the equilibrium is non-zero; the watchdog test uses level `1e6` (income ×101, finite) so
`checkNumericHealth` stays well under the `RUNAWAY = 1e100` canary.

**Test ripple pinned:** `TIERS.length` 5 → 7 invalidates hardcoded `counts`/`sacrificeOrder`
literals in `src/sim.test.ts` and `src/persistence.test.ts`; Task 1 pads them to length 7
(leaving the `victims` index expectation alone). The existing `SAVE_VERSION === 7` assertion
is updated in Task 5.

**Known follow-ups (not this plan):** the `costGrowth`/`perLevel` numbers are first-pass
data; `tierCostMult` is live via the `bulk` row; if legacy income should ever share
the repeatable income multiplier, that is a new ADR superseding 0013.
