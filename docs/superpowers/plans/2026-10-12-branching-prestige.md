# Branching Prestige — Perk Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `fork()`'s single flat bonus with a permanent, data-driven perk tree fed by a new spendable `lineage` currency, without changing the existing flat multiplier or Phase A balance.

**Architecture:** Data and constants live in a leaf `src/config/perks.ts`; pure logic (`perkMods`, `perkCost`, `canBuyPerk`, `pointsForFork`) lives in `src/perks.ts`; the mutating action and formula integration stay in `src/sim.ts`. Each formula applies perks in place by calling `perkMods(s)` itself, so no signatures are threaded. Persistence gains four fields and a staged migration.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`) toolchain, Vitest via `vite-plus/test`, break_eternity `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-12-branching-prestige-design.md`](../specs/2026-10-12-branching-prestige-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on — no dead imports.
- Unbounded values use `Decimal` from `src/bignum.ts`; never import the big-number library directly outside `bignum.ts`.
- Every mutating sim action returns `boolean` (`false` = refused).
- New persistent fields get a sane default in `newGame()`; saves merge over defaults (additive-safe).
- `SAVE_VERSION` is bumped **2 → 3**, and the migration is **staged per step** (`if (from < 2) …`, `if (from < 3) …`) — never a single `< SAVE_VERSION` check.
- `FORK_COST_FLOOR = 0.25`; every pacing constant is exported and named so it can be retuned without touching logic.
- Docs change in lockstep; `npm run check` (typecheck + lint + test) must pass.
- Keep `baseCyclesPerSec` **perk-free** (it is the legacy-rate snapshot source).
- Node cost is an integer: `Math.ceil(costBase * costRate ** level)`.

## Review Focus

Input classes / failure modes the spec implies but individual task tests might miss — each has a test added in the owning task below:

1. **Huge `runEarned` (Decimal beyond double range).** `pointsForFork` must clamp before `toNumber()` and never return `Infinity`/`NaN` (Task 3).
2. **A v2 save** whose legacy rates were already fixed. Loading under `SAVE_VERSION = 3` must **not** re-divide them; a pre-versioning save still must (Task 7).
3. **Corrupt/hand-edited `perks`.** Unknown ids, levels above `maxLevel`, and non-numeric values must all sanitize without throwing (Task 7).
4. **Fork must not lose meta progress.** `lineage` and `perks` survive `doFork` while the working set resets (Task 6).
5. **Stacked `niceAdd` sinks** driving the sweep victim multiplier to its `0.3` floor must not produce a negative/absurd victim budget (Task 5).

---

### Task 1: Perk config and cost/gating core

**Files:**
- Create: `src/config/perks.ts`
- Create: `src/perks.ts`
- Test: `src/perks.test.ts`

**Interfaces:**
- Consumes: `src/bignum.ts` (`d`, `Decimal`).
- Produces:
  - `type PerkId = string`, `type Branch = "growth" | "survival" | "lineage"`
  - `interface PerkMods` (fields exactly as in the spec: `incomeMult`, `rootMult`, `tierCostMult`, `niceAdd`, `ramCapAdd`, `heatGenMult`, `startShieldsAdd`, `forkCostMult`, `pointsMult`, `legacyRateMult`, `startCycles`)
  - `interface PerkDef { id; branch; name; desc; requires?; maxLevel; costBase; costRate; mod: keyof PerkMods; perLevel }`
  - `const PERKS: PerkDef[]`, `perkById(id: PerkId): PerkDef | undefined`
  - constants `T_REF=300, E_REF=1e6, DEPTH_GAIN=2, FLAT_BASE=1, MIN_RUN_SECONDS=60, MIN_RUN_EARNED=1e3, DEPTH_CAP=1000, MAX_POINTS_PER_FORK=1e6, SINK_RATE=1.6, FORK_COST_FLOOR=0.25`
  - `interface PerkInput { perks: Record<PerkId, number>; lineage: number; playtime: number; runStartPlaytime: number; totalEarned: Decimal; runBaseEarned: Decimal }`
  - `perkCost(s: PerkInput, id: PerkId): number`
  - `canBuyPerk(s: PerkInput, id: PerkId): boolean`

- [ ] **Step 1: Write the failing tests** in `src/perks.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { PERKS, type PerkInput, perkById, perkCost, canBuyPerk } from "./perks";

const base = (over: Partial<PerkInput> = {}): PerkInput => ({
  perks: {}, lineage: 0, playtime: 0, runStartPlaytime: 0,
  totalEarned: d(0), runBaseEarned: d(0), ...over,
});

describe("perk roster", () => {
  it("has unique ids and resolves every prerequisite to a real perk", () => {
    const ids = PERKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PERKS) if (p.requires) expect(perkById(p.requires)).toBeDefined();
  });
  it("has exactly one sink (maxLevel Infinity) per branch", () => {
    for (const branch of ["growth", "survival", "lineage"] as const) {
      expect(PERKS.filter((p) => p.branch === branch && p.maxLevel === Infinity)).toHaveLength(1);
    }
  });
});

describe("perkCost", () => {
  it("is flat for distinct perks and ceiling-rounded geometric for sinks", () => {
    const s = base();
    expect(perkCost(s, "spin")).toBe(2);
    expect(perkCost(base({ perks: { spin: 1 } }), "tailcall")).toBe(5);
    expect(perkCost(base({ perks: { pipeline: 0 } }), "pipeline")).toBe(3);
    expect(perkCost(base({ perks: { pipeline: 1 } }), "pipeline")).toBe(5); // ceil(3*1.6)
    expect(perkCost(base({ perks: { pipeline: 3 } }), "pipeline")).toBe(13); // ceil(3*1.6^3)
  });
});

describe("canBuyPerk", () => {
  it("requires the prerequisite, the level cap, and affordable lineage", () => {
    expect(canBuyPerk(base({ lineage: 2 }), "spin")).toBe(true);
    expect(canBuyPerk(base({ lineage: 1 }), "spin")).toBe(false);       // unaffordable
    expect(canBuyPerk(base({ lineage: 5 }), "tailcall")).toBe(false);   // needs `spin`
    expect(canBuyPerk(base({ perks: { spin: 1 }, lineage: 5 }), "tailcall")).toBe(true);
    expect(canBuyPerk(base({ perks: { spin: 1 }, lineage: 99 }), "spin")).toBe(false); // maxLevel 1
    expect(canBuyPerk(base({ lineage: 99 }), "pipeline")).toBe(true);   // sink repeatable
    expect(canBuyPerk(base({ lineage: 99 }), "nope")).toBe(false);      // unknown id
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/perks.test.ts`
Expected: FAIL — `Cannot find module './perks'`.

- [ ] **Step 3: Create `src/config/perks.ts`** with the types, the `PERKS` roster (exact values below), `perkById`, and the constants.

Roster (append in this order; `mod` is a `PerkMods` key):

| id | branch | name | requires | maxLevel | costBase | costRate | mod | perLevel |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spin` | growth | spin loop | — | 1 | 2 | 1 | `incomeMult` | 0.10 |
| `tailcall` | growth | tail-call opt | `spin` | 1 | 5 | 1 | `tierCostMult` | 0.08 |
| `prefetch` | growth | prefetcher | `spin` | 1 | 5 | 1 | `incomeMult` | 0.15 |
| `vec` | growth | vectorized | `tailcall` | 1 | 10 | 1 | `rootMult` | 1.0 |
| `pipeline` | growth | pipelining | `prefetch` | Infinity | 3 | 1.6 | `incomeMult` | 0.10 |
| `renice` | survival | re-nice | — | 1 | 2 | 1 | `niceAdd` | 1 |
| `oomguard` | survival | oom-guard | `renice` | 1 | 5 | 1 | `ramCapAdd` | 8 |
| `heatsink` | survival | heatsink | `renice` | 1 | 5 | 1 | `heatGenMult` | 0.10 |
| `sigblock` | survival | signal mask | `oomguard` | 1 | 10 | 1 | `startShieldsAdd` | 1 |
| `reaper` | survival | lazy sweeper | `heatsink` | Infinity | 3 | 1.6 | `niceAdd` | 1 |
| `echo` | lineage | lineage echo | — | 1 | 2 | 1 | `pointsMult` | 0.05 |
| `cheapfork` | lineage | cheap fork | `echo` | 1 | 5 | 1 | `forkCostMult` | 0.10 |
| `cache` | lineage | ancestor cache | `echo` | 1 | 5 | 1 | `legacyRateMult` | 0.05 |
| `startup` | lineage | warm start | `cheapfork` | 1 | 10 | 1 | `startCycles` | 1000 |
| `recursion` | lineage | recursion | `cache` | Infinity | 3 | 1.6 | `pointsMult` | 0.05 |

- [ ] **Step 4: Create `src/perks.ts`** with `PerkInput`, `perkCost`, `canBuyPerk`, and `export * from "./config/perks"` (so tests and `sim.ts` import from `./perks`). `perkCost` returns `Math.ceil(costBase * costRate ** level)` with `level = s.perks[id] ?? 0`, and `0` for an unknown id. `canBuyPerk` = `def !== undefined && level < def.maxLevel && (!def.requires || (s.perks[def.requires] ?? 0) >= 1) && s.lineage >= perkCost(s, id)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vp test run src/perks.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/perks.ts src/perks.ts src/perks.test.ts
git commit -m "feat(perks): config roster, cost curve, and buy gating (#22)"
```

---

### Task 2: `perkMods` aggregate

**Files:**
- Modify: `src/perks.ts`
- Test: `src/perks.test.ts`

**Interfaces:**
- Consumes: `PERKS`, `PerkMods`, `PerkInput`, `FORK_COST_FLOOR` (Task 1).
- Produces: `perkMods(s: PerkInput): PerkMods`, `MOD_KIND: Record<keyof PerkMods, "add" | "multiply" | "divide">`.

- [ ] **Step 1: Write the failing tests**

```ts
import { perkMods, MOD_KIND } from "./perks";

describe("perkMods", () => {
  it("is identity with no perks", () => {
    const m = perkMods(base());
    expect(m.incomeMult.toNumber()).toBe(1);
    expect(m.rootMult.toNumber()).toBe(1);
    expect(m.tierCostMult).toBe(1);
    expect(m.niceAdd).toBe(0);
    expect(m.heatGenMult).toBe(1);
    expect(m.startShieldsAdd).toBe(0);
    expect(m.forkCostMult).toBe(1);
    expect(m.pointsMult).toBe(1);
    expect(m.legacyRateMult.toNumber()).toBe(1);
    expect(m.startCycles.toNumber()).toBe(0);
  });

  it("multiplies increase mods, divides reductions, and adds flat mods", () => {
    const s = base({ perks: { spin: 1, prefetch: 1, tailcall: 1, renice: 1, heatsink: 1 } });
    const m = perkMods(s);
    expect(m.incomeMult.toNumber()).toBeCloseTo(1.1 * 1.15, 6);
    expect(m.tierCostMult).toBeCloseTo(1 / 1.08, 6);
    expect(m.heatGenMult).toBeCloseTo(1 / 1.1, 6);
    expect(m.niceAdd).toBe(1);
  });

  it("uses sqrt for sink levels and floors forkCostMult", () => {
    expect(perkMods(base({ perks: { pipeline: 4 } })).incomeMult.toNumber()).toBeCloseTo(1 + 0.1 * 2, 6);
    const cheap = perkMods(base({ perks: { cheapfork: 1 } }));
    expect(cheap.forkCostMult).toBeLessThan(1);
    expect(cheap.forkCostMult).toBeGreaterThanOrEqual(0.25);
    expect(Object.values(MOD_KIND)).toHaveLength(Object.keys(perkMods(base())).length);
  });

  it("makes `vec` double the root multiplier", () => {
    expect(perkMods(base({ perks: { vec: 1 } })).rootMult.toNumber()).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/perks.test.ts`
Expected: FAIL — `perkMods is not a function`.

- [ ] **Step 3: Implement `MOD_KIND` and `perkMods` in `src/perks.ts`**

Algorithm: initialise `PerkMods` (`incomeMult`/`rootMult`/`legacyRateMult` = `d(1)`, `startCycles` = `d(0)`, numeric muls = `1`, adds = `0`). For each perk with `level = s.perks[id] ?? 0` and `level > 0`, compute `factor = 1 + def.perLevel * Math.sqrt(level)` and apply `MOD_KIND[def.mod]`: `multiply → *= factor`, `divide → /= factor`, `add → += def.perLevel * Math.sqrt(level)` (Decimal fields via `Decimal` ops). After the fold, clamp `forkCostMult = Math.max(FORK_COST_FLOOR, forkCostMult)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/perks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/perks.ts src/perks.test.ts
git commit -m "feat(perks): fold purchased levels into PerkMods (#22)"
```

---

### Task 3: `pointsForFork`

**Files:**
- Modify: `src/perks.ts`
- Test: `src/perks.test.ts`

**Interfaces:**
- Consumes: constants and `PerkInput` (Task 1).
- Produces: `pointsForFork(s: PerkInput): number` (integer ≥ 0).

- [ ] **Step 1: Write the failing tests**

```ts
import { pointsForFork, DEPTH_CAP, MAX_POINTS_PER_FORK } from "./perks";

describe("pointsForFork", () => {
  it("grants nothing for an instant fork", () => {
    expect(pointsForFork(base())).toBe(0);
  });

  it("gates only the flat base; a sub-threshold run gets depth alone", () => {
    const below = base({ playtime: 30, totalEarned: d(1e6) }); // 30s < 60 → no flat base
    expect(pointsForFork(below)).toBe(Math.floor(2 * (Math.sqrt(30 / 300) + 1))); // 2
    const above = base({ playtime: 300, totalEarned: d(1e6) }); // qualifies → +1
    expect(pointsForFork(above)).toBe(Math.floor(2 * (Math.sqrt(1) + 1)) + 1); // 5
  });

  it("increases monotonically with deeper, longer runs", () => {
    const shallow = pointsForFork(base({ playtime: 300, totalEarned: d(1e6) }));
    const deep = pointsForFork(base({ playtime: 900, totalEarned: d(1e9) }));
    expect(deep).toBeGreaterThan(shallow);
  });

  it("clamps a huge Decimal runEarned and never returns Infinity", () => {
    const s = base({ playtime: 1000, totalEarned: d("1e1000") });
    const p = pointsForFork(s);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThanOrEqual(MAX_POINTS_PER_FORK);
    expect(p).toBe(Math.floor(2 * (Math.sqrt(1000 / 300) + DEPTH_CAP)) + 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/perks.test.ts`
Expected: FAIL — `pointsForFork is not a function`.

- [ ] **Step 3: Implement `pointsForFork` in `src/perks.ts`** exactly as the spec's formula: `runSeconds = max(0, playtime - runStartPlaytime)`; `runEarned = max(0, totalEarned - runBaseEarned)` (Decimal, compare via `.gt`); `timeFactor = Math.sqrt(runSeconds / T_REF)`; `earnFactor = clamp(Decimal.sqrt(runEarned.div(E_REF)).toNumber(), 0, DEPTH_CAP)`; `qualifies = runSeconds >= MIN_RUN_SECONDS && runEarned.gte(d(MIN_RUN_EARNED))`; return `Math.min(MAX_POINTS_PER_FORK, Math.floor(DEPTH_GAIN * (timeFactor + earnFactor)) + (qualifies ? FLAT_BASE : 0))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/perks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/perks.ts src/perks.test.ts
git commit -m "feat(perks): depth-based point award with anti-farm gating (#22)"
```

---

### Task 4: `GameState` fields, defaults, version bump, and `buyPerk`

**Files:**
- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**
- Consumes: `PerkId`, `perkCost`, `canBuyPerk`, `perkById` (Tasks 1–2).
- Produces: `GameState.lineage`, `GameState.perks`, `GameState.runBaseEarned`, `GameState.runStartPlaytime`; `SAVE_VERSION === 3`; `buyPerk(s: GameState, id: PerkId): boolean`.

- [ ] **Step 1: Write the failing tests** (add to `src/sim.test.ts`; add `buyPerk`, `perkCost`, `lineage` fixtures to the import list)

```ts
describe("lineage perks", () => {
  it("newGame starts with no points and no perks", () => {
    const s = newGame();
    expect(s.lineage).toBe(0);
    expect(s.perks).toEqual({});
    expect(s.runBaseEarned.toNumber()).toBe(0);
    expect(s.runStartPlaytime).toBe(0);
  });
  it("buyPerk spends points, adds a level, and refuses when broke or gated", () => {
    const s = newGame();
    expect(buyPerk(s, "spin")).toBe(false); // 0 points
    s.lineage = 2;
    expect(buyPerk(s, "spin")).toBe(true);
    expect(s.lineage).toBe(0);
    expect(s.perks.spin).toBe(1);
    expect(buyPerk(s, "spin")).toBe(false); // maxLevel 1 already reached
    s.lineage = 5;
    expect(buyPerk(s, "tailcall")).toBe(true); // prereq `spin` owned, costs 5
    expect(s.lineage).toBe(0);
    s.lineage = 4;
    expect(buyPerk(s, "vec")).toBe(false); // prereq owned but costs 10
    s.lineage = 10;
    expect(buyPerk(s, "vec")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL — `buyPerk is not a function`.

- [ ] **Step 3: Implement in `src/sim.ts`**

Add the four fields to `interface GameState` (`lineage: number`, `perks: Record<PerkId, number>`, `runBaseEarned: Decimal`, `runStartPlaytime: number`), default them in `newGame()` (`lineage: 0`, `perks: {}`, `runBaseEarned: d(0)`, `runStartPlaytime: 0`), change `export const SAVE_VERSION = 2;` to `3`, and add `buyPerk` in the actions section:

```ts
export function buyPerk(s: GameState, id: PerkId): boolean {
  if (!canBuyPerk(s, id)) return false;
  s.lineage -= perkCost(s, id);
  s.perks[id] = (s.perks[id] ?? 0) + 1;
  log(s, `lineage: bought ${perkById(id)?.name ?? id} (L${s.perks[id]})`);
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat(sim): lineage points state, save version 3, and buyPerk (#22)"
```

---

### Task 5: Apply `perkMods` across the economy formulas

**Files:**
- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**
- Consumes: `perkMods` (Task 2), the new fields (Task 4).
- Produces: exported `ramCapTotal(s: GameState): number`; perk-aware `cyclesPerSec`, `tierCost`, `heatEquilibrium`, `sweepVictimMult`, `forkCost`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("perk effects on the economy", () => {
  it("incomeMult raises cps; vec doubles the root term", () => {
    const plain = newGame();
    const perked = newGame();
    perked.perks = { spin: 1 }; // +10% on BOTH children and root
    expect(cyclesPerSec(perked).toNumber()).toBeCloseTo(cyclesPerSec(plain).toNumber() * 1.1, 6);
    perked.perks = { vec: 1 };
    expect(cyclesPerSec(perked).toNumber()).toBeCloseTo(2, 6); // root 1 -> 2, no children
  });
  it("tailcall reduces tierCost; oomguard raises the effective RAM cap", () => {
    const s = newGame();
    const cost0 = tierCost(s, 0).toNumber();
    s.perks = { tailcall: 1 };
    expect(tierCost(s, 0).toNumber()).toBeLessThan(cost0);
    expect(ramCapTotal(newGame())).toBe(BASE.ramCap);
    const oom = newGame();
    oom.perks = { oomguard: 1 };
    expect(ramCapTotal(oom)).toBe(BASE.ramCap + 8);
  });
  it("heatsink lowers the heat equilibrium; renice reduces sweep victims but respects the floor", () => {
    const s = newGame();
    s.counts = TIERS.map(() => 4);
    const eq = heatEquilibrium(s);
    s.perks = { heatsink: 1 };
    expect(heatEquilibrium(s)).toBeLessThan(eq);
    const many = newGame();
    many.counts = TIERS.map(() => 10);
    many.nice = 40;
    many.perks = { renice: 1, reaper: 20 }; // drive niceAdd hard against the 0.3 floor
    expect(sweepVictimMult(many)).toBeGreaterThanOrEqual(0.3);
    expect(estimateVictims(many)).toBeGreaterThanOrEqual(0);
  });
  it("cheapfork reduces forkCost but never below the floor", () => {
    const s = newGame();
    s.forks = 3;
    const full = forkCost(s).toNumber();
    s.perks = { cheapfork: 1 };
    expect(forkCost(s).toNumber()).toBeCloseTo(full / 1.1, 6);
    expect(forkCost(s).toNumber()).toBeGreaterThanOrEqual(full * 0.25 - 1e-9);
  });
});
```

> Add `ramCapTotal`, `forkCost`, `sweepVictimMult`, and `estimateVictims` to the `./sim` import list in `src/sim.test.ts` (`estimateVictims`, `tierCost`, `heatEquilibrium`, `cyclesPerSec`, `BASE`, `TIERS`, `newGame` are already imported).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL — `ramCapTotal is not a function` / assertions fail.

- [ ] **Step 3: Implement in `src/sim.ts`**

- Add `export function ramCapTotal(s: GameState): number { return s.ramCap + perkMods(s).ramCapAdd; }`.
- Replace `s.ramCap` with `ramCapTotal(s)` in: `canSpawn` (line 523), the offline leak clamp (line 667), the memory-pressure latch (lines 703–709), and `runOom` (lines 758–767). Leave `mallocCost`/`buyMalloc`/the `doFork` reset on `s.ramCap`.
- `cyclesPerSec`: introduce a private `perkedBaseCyclesPerSec(s)` = `childOutput(s).mul(survivalMult(s)).mul(m.incomeMult).add(d(BASE.rootOutput).mul(m.incomeMult).mul(m.rootMult))`; set `rawCyclesPerSec(s) = perkedBaseCyclesPerSec(s).mul(lineageMult(s))` and `cyclesPerSec(s) = rawCyclesPerSec(s).mul(heatMult(s))`. **Leave `baseCyclesPerSec` unchanged** (perk-free, used by `doFork`).
- `tierCost`: multiply by `perkMods(s).tierCostMult`.
- `heatEquilibrium`: multiply by `perkMods(s).heatGenMult`.
- `sweepVictimMult`: use `(s.nice + perkMods(s).niceAdd)` in place of `s.nice` (keep `max(0.3, …)`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat(sim): apply perkMods to income, cost, RAM, heat, sweep, forkCost (#22)"
```

---

### Task 6: `doFork` awards points, snapshots the run, and applies start grants

**Files:**
- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**
- Consumes: `pointsForFork` (Task 3), `perkMods` (Task 2), fields (Task 4).
- Produces: perk-aware `doFork`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("doFork with perks", () => {
  it("awards points from the run, snapshots the run, and keeps perks + points", () => {
    const s = newGame();
    s.perks = { echo: 1 };                    // pointsMult = 1 + 0.05*sqrt(1) = 1.05
    s.lineage = 7;                            // must survive the fork
    s.totalEarned = d(1e6);                   // == forkCost(0), so canFork is true
    s.playtime = 600;                         // runSeconds 600 -> base 5; 5*1.05 -> 5
    expect(doFork(s)).toBe(true);
    expect(s.lineage).toBe(12);
    expect(s.perks.echo).toBe(1);
    expect(s.runBaseEarned.toNumber()).toBeCloseTo(1e6, 6);
    expect(s.runStartPlaytime).toBeCloseTo(600, 6);
  });
  it("applies start-of-run grants", () => {
    const s = newGame();
    s.perks = { sigblock: 1, startup: 1 };
    s.totalEarned = d(1e6);
    s.playtime = 600;
    doFork(s);
    expect(s.shields).toBe(1);
    expect(s.cycles.toNumber()).toBe(1000);
  });
  it("still resets the working set", () => {
    const s = newGame();
    s.counts = [5, 0, 0, 0, 0];
    s.totalEarned = d(1e6);
    s.playtime = 600;
    doFork(s);
    expect(s.counts.every((n) => n === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `doFork`** (order matters)

1. `const m = perkMods(s);` then `s.lineage += Math.min(MAX_POINTS_PER_FORK, Math.floor(pointsForFork(s) * m.pointsMult));` **before** the reset (uses the pre-reset run).
2. In the existing reset block, set `s.runBaseEarned = s.totalEarned` and `s.runStartPlaytime = s.playtime`.
3. Replace `s.shields = 0` with `s.shields = m.startShieldsAdd`, and `s.cycles = d(0)` with `s.cycles = m.startCycles`.
4. `forks`, `legacy`, `lineage`, `perks` are untouched (already the case).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat(sim): doFork awards lineage points and applies start grants (#22)"
```

---

### Task 7: Persistence — new fields, sanitizing, and staged migration

**Files:**
- Modify: `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `PERKS` (Task 1), `SAVE_VERSION`/fields (Task 4).
- Produces: `sanitizePerks(raw: unknown): Record<string, number>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("perk persistence", () => {
  it("round-trips the new fields", () => {
    const s = newGame();
    s.lineage = 12;
    s.perks = { spin: 1, pipeline: 4 };
    s.runBaseEarned = d(1e6);
    s.runStartPlaytime = 123;
    const out = decode(encode(s));
    expect(out.lineage).toBe(12);
    expect(out.perks).toEqual({ spin: 1, pipeline: 4 });
    expect(out.runBaseEarned.toNumber()).toBe(1e6);
    expect(out.runStartPlaytime).toBe(123);
  });
  it("sanitizes corrupt perks without throwing", () => {
    expect(sanitizePerks({ spin: 99, pipeline: 3.7, ghost: 5, tailcall: "x" })).toEqual({ spin: 1, pipeline: 3 });
    expect(sanitizePerks(null)).toEqual({});
    expect(sanitizePerks([1, 2])).toEqual({});
  });
  it("does NOT re-divide legacy rates for a v2 save under SAVE_VERSION 3", () => {
    const s = newGame();
    s.saveVersion = 2;
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: false, respawn: 0 }];
    const out = decode(JSON.stringify({ ...s, cycles: "0", totalEarned: "0", legacy: [{ name: "legacy-1", rate: "10", crashed: false, respawn: 0 }] }));
    expect(out.legacy[0].rate.toNumber()).toBe(10);
  });
  it("still divides baked lineage out of a pre-versioning save", () => {
    const raw = JSON.stringify({ cycles: "0", totalEarned: "0", legacy: [{ name: "legacy-1", rate: "11", crashed: false, respawn: 0 }] });
    expect(decode(raw).legacy[0].rate.toNumber()).toBeCloseTo(10, 6); // /1.1
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/persistence.test.ts`
Expected: FAIL — `sanitizePerks is not a function`.

- [ ] **Step 3: Implement in `src/persistence.ts`**

- Add `export function sanitizePerks(raw: unknown): Record<string, number>`: for each `PERKS` entry, read `raw?.[id]`, `coerceCount`, clamp to `[0, def.maxLevel]`; include only ids with a present, non-zero level; return `{}` for a non-object `raw`.
- `encode`: add `runBaseEarned: s.runBaseEarned.toString()` to the stringified fields.
- `decode`: set `s.perks = sanitizePerks(parsed.perks)`, `s.runBaseEarned = coerceDecimal(parsed.runBaseEarned, d(0))`, `s.lineage = coerceCount(parsed.lineage)`.
- `sanitizeNumericState`: add `s.lineage = coerceCount(s.lineage)` and `s.runStartPlaytime = Math.max(0, coerceFinite(s.runStartPlaytime, 0))`.
- Replace the single `if (coerceFinite(parsed.saveVersion, 0) < SAVE_VERSION) { … }` block with staged migrations:
  `const from = coerceFinite(parsed.saveVersion, 0); if (from < 2) { /* existing legacy-rate division */ } if (from < 3) { /* additive: defaults already applied; no-op */ }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): lineage/perk fields, sanitizing, staged migration (#22)"
```

---

### Task 8: Perk-tree UI panel

**Files:**
- Modify: `index.html`, `src/main.ts`, `src/style.css`

**Interfaces:**
- Consumes: `PERKS`, `perkCost`, `canBuyPerk`, `pointsForFork`, `buyPerk`, `ramCapTotal`.

- [ ] **Step 1: Add the panel container** to `index.html` inside `<main>`, after the "sacrifice order" section:

```html
<section class="panel" id="perkSection" hidden>
  <h2>prestige <span id="lineageText">0 pt</span></h2>
  <p class="hint">spend lineage on permanent perks; next fork grants ≈ <span id="lineageNext">0</span> pt</p>
  <div id="perkPanel" class="perks"></div>
</section>
```

- [ ] **Step 2: Wire it in `src/main.ts`**

- Extend the imports from `./sim` with `buyPerk`, `ramCapTotal`, and from `./perks` with `PERKS`, `perkCost`, `canBuyPerk`, `pointsForFork`, `perkMods`.
- Add `perkSection: $("perkSection")`, `lineageText: $("lineageText")`, `lineageNext: $("lineageNext")`, `perkPanel: $("perkPanel")` to `el`.
- Implement `renderPerks()`: hide `#perkSection` while `state.forks < 1`; set `lineageText` to `${state.lineage} pt` and `lineageNext` to `Math.floor(pointsForFork(state) * perkMods(state).pointsMult)` (matches the actual award). Rebuild the three branch columns from `PERKS` (group by `branch`, order by prerequisite depth). Each node is a `<button class="act">` with `name`, `L<level>`, next cost `perkCost(state, p.id)`, and effect text; `disabled` when `!canBuyPerk(state, p.id)`; click → `buyPerk(state, p.id); render(true)`.
- Call `renderPerks()` from `render()` (after `renderPriority()`), and change the RAM readout cap to `ramCapTotal(state)` (lines 209 and 242).
- Add minimal `.perks` styling to `src/style.css` (three-column grid consistent with `.priority`).

- [ ] **Step 3: Verify manually in the browser**

Run: `npm run dev`, open `http://127.0.0.1:5173`, fork once (or seed `localStorage` with a save where `forks >= 1` and `lineage > 0`), buy a node, and screenshot. Report the header values (`lineage: N pt`, next-fork preview) and the node states the panel shows.

- [ ] **Step 4: Commit**

```bash
git add index.html src/main.ts src/style.css
git commit -m "feat(ui): prestige perk-tree panel (#22)"
```

---

### Task 9: Docs lockstep and ADR

**Files:**
- Create: `docs/architecture/009-prestige-perk-tree.md`
- Create: `docs/decisions/0008-branching-prestige-perk-tree.md`
- Modify: `docs/architecture/004-prestige-and-legacy.md`, `001-simulation-core.md`, `002-render-system.md`, `003-persistence.md`, `docs/architecture/README.md`

- [ ] **Step 1: Write `docs/architecture/009-prestige-perk-tree.md`** — the tree contract: three branches, the roster, the curve shapes (`ceil(costBase·costRate^level)`, `perLevel·√level`), the `pointsForFork` formula with its constants, the soft-cap rationale, and the `mod` → formula mapping table. Follow the "state the contract, not the code" style of the sibling docs.

- [ ] **Step 2: Rewrite `004-prestige-and-legacy.md`** — `fork()` now awards `lineage` points (formula pointer), snapshots `runBaseEarned`/`runStartPlaytime`, applies `startShieldsAdd`/`startCycles`, and preserves `lineage`/`perks`; the flat `lineageMult` is unchanged; legacy identity retained; cross-link `009`.

- [ ] **Step 3: Touch `001`, `002`, `003`, and register `009`** in `docs/architecture/README.md` (`001`: income composition, `tierCost`, effective RAM cap, heat, sweep `nice`; `002`: the new panel; `003`: the four fields, `SAVE_VERSION` 3, staged migration).

- [ ] **Step 4: Write ADR `docs/decisions/0008-branching-prestige-perk-tree.md`** — Context, Decision (the eight dialogue decisions), Alternatives considered (per-run respec, purchase-time mutation, effect callbacks, replace-vs-layer), Consequences. Follow `0006-sweep-directive-model.md`'s shape.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: typecheck + lint + all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: perk-tree architecture doc, ADR 0008, and lockstep updates (#22)"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — file layout (Tasks 1–2), state (4), data model (1), curves (1–3), PerkMods (2), roster (1), sim integration (5), `doFork` (6), persistence + staged migration (7), UI (8), docs/ADR (9). Review Focus items 1–5 are pinned to Tasks 3, 7, 7, 6, and 5 respectively.

**Type consistency:** `PerkMods` field names (`incomeMult`, `rootMult`, `tierCostMult`, `niceAdd`, `ramCapAdd`, `heatGenMult`, `startShieldsAdd`, `forkCostMult`, `pointsMult`, `legacyRateMult`, `startCycles`) are used identically in Tasks 2, 5, and the roster. `perkCost`/`canBuyPerk`/`perkMods`/`pointsForFork`/`ramCapTotal`/`buyPerk` keep one name throughout. `sanitizePerks` returns `Record<string, number>` (a `Record<PerkId, number>`).

**Decisions the spec left open, pinned here:** integer `Math.ceil` node costs; `ramCapTotal` as the single effective-cap helper; staged migration split into `from < 2` / `from < 3`.

**Known follow-ups (not this plan):** pacing retune after playtest; promoting `startup` to a sink if it feels dead late-game (#22 dials in `004`'s "Revisit" note); #20/#21 compose with `legacyRateMult`/`pointsMult` rather than adding parallel hooks.
