# Milestone Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-driven milestone system that fires named, one-shot goals and grants named unlock flags, and gate `nice`/`gc` behind two starter milestones.

**Architecture:** Data and constants in a leaf `src/config/milestones.ts`; pure read/evaluate logic in `src/milestones.ts` over a narrow `MilestoneInput` (no runtime `sim.ts` import, so no cycle); the two persisted records and the `tick` call and the gates live in `src/sim.ts`; sanitizing + a staged migration in `src/persistence.ts`; the panel in `src/main.ts`.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-12-milestones-design.md`](../specs/2026-10-12-milestones-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on — no dead imports.
- Unbounded values use `Decimal` from `src/bignum.ts`; never import the big-number library directly outside `bignum.ts`.
- Every mutating sim action returns `boolean` (`false` = refused).
- New persistent fields get a default in `newGame()`; saves merge over defaults (additive-safe).
- `SAVE_VERSION` bumps **2 → 3** with a **staged** step (`if (from < 2) …`, `if (from < 3) …`); never a single `< SAVE_VERSION` check.
- No runtime import cycle: `src/milestones.ts` must not import `src/sim.ts` at runtime (it reads a narrow `MilestoneInput`).
- Docs change in lockstep; `npm run check` (typecheck + lint + test) must pass.

## Plan decisions (pinned here; deviations from the spec's file table)

- **`MetricId` omits `directivesSeen`.** It would need `unlockedDirectives`/`DIRECTIVES` from `sim.ts` → a runtime cycle for an unused metric. The starter set does not use it; add it later via a metric that does not touch sim internals.
- **`evaluateMilestones` mutates the records and returns the fired ids; it does not log.** The `log` line lives in `sim.ts`'s `tick`, keeping logging in the sim (and avoiding a `log` import cycle).
- **`MilestoneInput`** is a narrow interface declared in `milestones.ts` (mirrors `PerkInput` from #22), so `GameState` satisfies it structurally.

## Review Focus

Failure modes the spec implies but a single task's tests might miss — each gets a test in the owning task below:

1. **Corrupt saves:** `milestonesDone` with unknown ids, and `unlocks` with non-string/garbage keys, must sanitize without throwing (Task 4).
2. **Non-monotonic metric:** a fired milestone whose metric later drops (e.g. `children` after a sweep) must stay done — `milestonesDone` is sticky (Task 2).
3. **Offline:** an `{ offline: true }` tick must not fire milestones; it fires on the next live tick (Task 3).
4. **Huge `totalEarned`:** `milestoneProgress` must be finite/`1`, never `NaN`/`Infinity` (Task 1).
5. **Direct call bypass:** `buyNice`/`buyGc` must refuse while locked even when called directly, not only via the disabled UI (Task 3).

---

### Task 1: Milestone config + metrics/predicate core

**Files:**

- Create: `src/config/milestones.ts`
- Create: `src/milestones.ts`
- Test: `src/milestones.test.ts`

**Interfaces:**

- Consumes: `src/bignum.ts` (`Decimal` type).
- Produces:
  - `type MilestoneId = string`
  - `type MetricId = "totalEarned" | "sweepsSurvived" | "forks" | "playtime" | "children" | "ramCap"`
  - `interface MilestoneDef { id; name; desc; metric: MetricId; at: number; unlocks: string[] }`
  - `const MILESTONES: MilestoneDef[]`, `milestoneById(id): MilestoneDef | undefined`
  - `const UNLOCK = { nice, gc, buyMax, autoNice, autoMalloc, autoFree }`
  - `interface MilestoneInput { totalEarned: Decimal; sweepsSurvived: number; forks: number; playtime: number; counts: number[]; ramCap: number; milestonesDone: Record<MilestoneId, true>; unlocks: Record<string, true> }`
  - `METRICS: Record<MetricId, (s: MilestoneInput) => number>`
  - `milestoneMet(s, d): boolean`, `milestoneProgress(s, d): number`

- [ ] **Step 1: Write the failing tests** in `src/milestones.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  MILESTONES,
  UNLOCK,
  METRICS,
  milestoneById,
  milestoneMet,
  milestoneProgress,
  type MilestoneInput,
} from "./milestones";

const base = (over: Partial<MilestoneInput> = {}): MilestoneInput => ({
  totalEarned: d(0),
  sweepsSurvived: 0,
  forks: 0,
  playtime: 0,
  counts: [0, 0, 0, 0, 0],
  ramCap: 8,
  milestonesDone: {},
  unlocks: {},
  ...over,
});

describe("milestone roster", () => {
  it("has unique ids, real metrics, positive thresholds, and non-empty unlocks", () => {
    const ids = MILESTONES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MILESTONES) {
      expect(m.metric in METRICS).toBe(true);
      expect(m.at).toBeGreaterThan(0);
      expect(m.unlocks.length).toBeGreaterThan(0);
    }
    expect(milestoneById("first-blood")?.unlocks).toEqual([UNLOCK.nice]);
    expect(milestoneById("grown-up")?.unlocks).toEqual([UNLOCK.gc]);
  });
});

describe("METRICS", () => {
  it("reads the expected value from state", () => {
    const s = base({
      totalEarned: d(1234),
      sweepsSurvived: 3,
      forks: 2,
      playtime: 9,
      counts: [1, 2, 0, 0, 0],
      ramCap: 24,
    });
    expect(METRICS.totalEarned(s)).toBe(1234);
    expect(METRICS.sweepsSurvived(s)).toBe(3);
    expect(METRICS.forks(s)).toBe(2);
    expect(METRICS.playtime(s)).toBe(9);
    expect(METRICS.children(s)).toBe(3);
    expect(METRICS.ramCap(s)).toBe(24);
  });
});

describe("milestoneMet / milestoneProgress", () => {
  it("is met at and above the threshold, not below", () => {
    const def = milestoneById("first-blood")!; // sweepsSurvived >= 1
    expect(milestoneMet(base({ sweepsSurvived: 0 }), def)).toBe(false);
    expect(milestoneMet(base({ sweepsSurvived: 1 }), def)).toBe(true);
    expect(milestoneMet(base({ sweepsSurvived: 5 }), def)).toBe(true);
  });

  it("clamps progress to [0, 1] and is finite for a huge totalEarned", () => {
    const grown = milestoneById("grown-up")!; // ramCap >= 24
    expect(milestoneProgress(base({ ramCap: 0 }), grown)).toBe(0);
    expect(milestoneProgress(base({ ramCap: 12 }), grown)).toBeCloseTo(0.5, 6);
    expect(milestoneProgress(base({ ramCap: 48 }), grown)).toBe(1);
    const earn = {
      id: "x",
      name: "x",
      desc: "",
      metric: "totalEarned" as const,
      at: 100,
      unlocks: ["u"],
    };
    const p = milestoneProgress(base({ totalEarned: d("1e1000") }), earn);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/milestones.test.ts`
Expected: FAIL — `Cannot find module './milestones'`.

- [ ] **Step 3: Create `src/config/milestones.ts`** with the types, `MILESTONES` (the two starter entries below), `UNLOCK`, and `milestoneById`.

| id            | name        | desc                             | metric           | `at` | unlocks |
| ------------- | ----------- | -------------------------------- | ---------------- | ---- | ------- |
| `first-blood` | first blood | survive your first cleanup sweep | `sweepsSurvived` | 1    | `nice`  |
| `grown-up`    | grown-up    | raise the RAM ceiling to 24 MB   | `ramCap`         | 24   | `gc`    |

`UNLOCK = { nice: "nice", gc: "gc", buyMax: "buy-max", autoNice: "auto-nice", autoMalloc: "auto-malloc", autoFree: "auto-free" } as const`.

- [ ] **Step 4: Create `src/milestones.ts`** with `MilestoneInput`, `METRICS`, `milestoneMet`, `milestoneProgress`, and `export * from "./config/milestones"`. `METRICS` : `totalEarned: (s) => s.totalEarned.toNumber()`, `sweepsSurvived/forks/playtime/ramCap` read directly, `children: (s) => s.counts.reduce((a, b) => a + b, 0)`. `milestoneMet = METRICS[d.metric](s) >= d.at`. `milestoneProgress = Math.min(1, METRICS[d.metric](s) / d.at)` (guard `d.at > 0`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vp test run src/milestones.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/milestones.ts src/milestones.ts src/milestones.test.ts
git commit -m "feat(milestones): config roster and metric/predicate core (#17)"
```

---

### Task 2: `evaluateMilestones` (sticky fire) + `hasUnlock`

**Files:**

- Modify: `src/milestones.ts`
- Test: `src/milestones.test.ts`

**Interfaces:**

- Consumes: `MILESTONES`, `MilestoneInput`, `milestoneMet` (Task 1).
- Produces: `evaluateMilestones(s: MilestoneInput): MilestoneId[]`, `hasUnlock(s: Pick<MilestoneInput, "unlocks">, id: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { evaluateMilestones, hasUnlock } from "./milestones";

describe("evaluateMilestones", () => {
  it("fires a met milestone once, grants its unlocks, and is idempotent", () => {
    const s = base({ sweepsSurvived: 1 });
    expect(evaluateMilestones(s)).toEqual(["first-blood"]);
    expect(s.milestonesDone["first-blood"]).toBe(true);
    expect(s.unlocks.nice).toBe(true);
    expect(evaluateMilestones(s)).toEqual([]); // already done
  });

  it("does not fire an unmet milestone", () => {
    const s = base();
    expect(evaluateMilestones(s)).toEqual([]);
    expect(hasUnlock(s, "nice")).toBe(false);
  });

  it("stays fired when a non-monotonic metric later drops", () => {
    const s = base({ sweepsSurvived: 1 });
    evaluateMilestones(s);
    s.sweepsSurvived = 0; // e.g. reset
    expect(evaluateMilestones(s)).toEqual([]);
    expect(s.milestonesDone["first-blood"]).toBe(true);
    expect(hasUnlock(s, "nice")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/milestones.test.ts` → FAIL (`evaluateMilestones is not a function`).

- [ ] **Step 3: Implement** in `src/milestones.ts`: iterate `MILESTONES`; skip when `s.milestonesDone[d.id]`; when `milestoneMet(s, d)` set `s.milestonesDone[d.id] = true`, set each `s.unlocks[u] = true`, push the id. Return the fired ids. `hasUnlock(s, id) = Boolean(s.unlocks[id])`.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/milestones.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/milestones.ts src/milestones.test.ts
git commit -m "feat(milestones): sticky evaluation and unlock gate (#17)"
```

---

### Task 3: Sim state, `tick` wiring, and the `nice`/`gc` gates

**Files:**

- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**

- Consumes: `evaluateMilestones`, `hasUnlock`, `UNLOCK`, `milestoneById`, `MilestoneId` (Tasks 1–2).
- Produces: `GameState.milestonesDone`, `GameState.unlocks`, `SAVE_VERSION === 3`; `buyNice`/`buyGc` gated.

- [ ] **Step 1: Write the failing tests** (add to `src/sim.test.ts`; add `UNLOCK` import)

```ts
import { UNLOCK } from "./milestones";

describe("milestone gating", () => {
  it("newGame starts with no milestones and no unlocks", () => {
    const s = newGame();
    expect(s.milestonesDone).toEqual({});
    expect(s.unlocks).toEqual({});
  });
  it("gates nice until `first-blood` fires, then allows it", () => {
    const s = newGame();
    s.cycles = d(1e9);
    expect(buyNice(s)).toBe(false); // locked
    s.sweepsSurvived = 1;
    tick(s, 0); // evaluateMilestones runs at the end of a live tick
    expect(s.unlocks[UNLOCK.nice]).toBe(true);
    expect(buyNice(s)).toBe(true);
  });
  it("gates gc until `grown-up` fires, then allows it", () => {
    const s = newGame();
    s.cycles = d(1e9);
    expect(buyGc(s)).toBe(false); // locked
    s.ramCap = 24;
    tick(s, 0);
    expect(buyGc(s)).toBe(true);
  });
  it("does not fire milestones during an offline tick", () => {
    const s = newGame();
    s.sweepsSurvived = 1;
    tick(s, 0, { offline: true });
    expect(s.milestonesDone["first-blood"]).toBeUndefined();
    tick(s, 0);
    expect(s.milestonesDone["first-blood"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/sim.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/sim.ts`**

- Add `milestonesDone: Record<MilestoneId, true>` and `unlocks: Record<string, true>` to `interface GameState` (defaults `{}` in `newGame()`).
- `SAVE_VERSION = 3` (update the comment).
- Import `evaluateMilestones`, `hasUnlock`, `UNLOCK`, `milestoneById` from `./milestones`, and `type MilestoneId` from `./config/milestones`.
- At the **end of `tick` (after the `offline` early-return)**:
  ```ts
  for (const id of evaluateMilestones(s)) {
    const def = milestoneById(id);
    if (def && def.unlocks.length > 0) log(s, `milestone: ${def.name} — unlocked`);
  }
  ```
- Guards at the top of `buyNice`/`buyGc`:
  ```ts
  if (!hasUnlock(s, UNLOCK.nice)) return false; // buyNice
  if (!hasUnlock(s, UNLOCK.gc)) return false; // buyGc
  ```
- **Update existing fixtures:** any existing test that calls `buyNice`/`buyGc` on a fresh game must first unlock it — set `s.unlocks = { nice: true }` / `{ gc: true }` (or drive the milestone). Grep `src/sim.test.ts` for `buyNice(`/`buyGc(`.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/sim.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat(sim): milestone state, tick wiring, and nice/gc gates (#17)"
```

---

### Task 4: Persistence — sanitizing and the staged v3 step

**Files:**

- Modify: `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**

- Consumes: `MILESTONES` (Task 1), fields (Task 3).
- Produces: `sanitizeMilestones(raw): Record<string, true>`, `sanitizeUnlocks(raw): Record<string, true>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { sanitizeMilestones, sanitizeUnlocks } from "./persistence";

describe("milestone persistence", () => {
  it("round-trips the two records", () => {
    const s = newGame();
    s.milestonesDone = { "first-blood": true };
    s.unlocks = { nice: true, "auto-nice": true };
    const out = decode(encode(s));
    expect(out.milestonesDone).toEqual({ "first-blood": true });
    expect(out.unlocks).toEqual({ nice: true, "auto-nice": true });
  });
  it("drops unknown milestone ids and garbage unlocks", () => {
    expect(sanitizeMilestones({ "first-blood": true, ghost: true, "grown-up": false })).toEqual({
      "first-blood": true,
    });
    expect(sanitizeMilestones(null)).toEqual({});
    expect(sanitizeUnlocks({ nice: true, bad: false, 3: true })).toEqual({ nice: true });
    expect(sanitizeUnlocks([1, 2])).toEqual({});
  });
  it("loads a pre-version save with empty records", () => {
    const s = decode('{"cycles":"0","totalEarned":"0"}');
    expect(s.milestonesDone).toEqual({});
    expect(s.unlocks).toEqual({});
    expect(s.saveVersion).toBe(SAVE_VERSION);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/persistence.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- `sanitizeMilestones(raw)`: keep `id` keys present in `MILESTONES` whose value is truthy; non-object → `{}`.
- `sanitizeUnlocks(raw)`: keep string keys with truthy values; non-object → `{}` (open-ended — do **not** restrict to `UNLOCK`).
- `decode`: `s.milestonesDone = sanitizeMilestones(parsed.milestonesDone)` and `s.unlocks = sanitizeUnlocks(parsed.unlocks)`.
- Staged migration: add `if (from < 3) { /* additive: new records come from newGame() defaults; no-op */ }` after the existing `if (from < 2)` step. (If #22 has landed on the base, this step is `< 4` and `SAVE_VERSION = 4` — see the spec's rebase note.)

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/persistence.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): milestone/unlock fields, sanitizing, staged v3 step (#17)"
```

---

### Task 5: Milestones panel + locked-upgrade hints

**Files:**

- Modify: `index.html`, `src/main.ts`, `src/style.css`

**Interfaces:**

- Consumes: `MILESTONES`, `milestoneProgress`, `hasUnlock`, `UNLOCK`, `perkMods` is irrelevant here.

- [ ] **Step 1: Add the panel** to `index.html` inside `<main>` (after the upgrades panel, before legacy):

```html
<section class="panel">
  <h2>milestones</h2>
  <div id="milestonePanel" class="milestones"></div>
</section>
```

- [ ] **Step 2: Wire it in `src/main.ts`**

- Import `MILESTONES`, `milestoneProgress`, `hasUnlock`, `UNLOCK` from `./milestones`.
- Add `milestonePanel: $("milestonePanel")` to `el`.
- Implement `renderMilestones()`: sort `MILESTONES` pending-first by `milestoneProgress` descending, then achieved; for each, a row with the name, `desc`, and either `✓ unlocked: <ids>` (achieved) or a progress bar + `value / at`. Rebuild only when `milestonesDone`+`unlocks` signature changes (`milestonePanel.dataset.sig`); refresh progress numbers each frame. Call it from `render()`.
- Change the `nice` and `gc` `addUpgrade(...)` registrations so their `enabled()` also requires the unlock, and their `name()` shows `🔒 <milestone name>` when locked (find the milestone whose `unlocks` includes the id). Leave every other upgrade unchanged.

- [ ] **Step 3: Style** `.milestones` in `src/style.css` (consistent with `.priority`); a progress bar element.

- [ ] **Step 4: Verify manually in the browser**

Run: `npm run dev`, open `http://127.0.0.1:5173`. Confirm `nice`/`gc` show locked with the milestone name; drive `sweepsSurvived`/`ramCap` to fire each (or seed a save), and screenshot. Report the panel values and the unlocked-upgrade states.

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.ts src/style.css
git commit -m "feat(ui): milestones panel and locked-upgrade hints (#17)"
```

---

### Task 6: Docs lockstep and ADR

**Files:**

- Create: `docs/architecture/010-milestones.md`, `docs/decisions/0009-milestone-gating-model.md`
- Modify: `docs/architecture/001-simulation-core.md`, `002-render-system.md`, `003-persistence.md`, `docs/architecture/README.md`, `docs/decisions/README.md`

- [ ] **Step 1: Write `010-milestones.md`** — the goal→reward contract: the two records and why they are separate, `METRICS`, the predicate/progress shapes, `evaluateMilestones` stickiness, `hasUnlock`, the end-of-live-tick placement, the starter set, and the forward-id convention. Follow the "state the contract, not the code" style of `009`.

- [ ] **Step 2: Touch the living docs.** `001`: add the two state-table rows, a tick-order note, and the `nice`/`gc` gate; `002`: the milestones panel and the locked hints; `003`: the two fields and the `SAVE_VERSION` 3 staged step.

- [ ] **Step 3: Register** `010` in `docs/architecture/README.md` and `0009` in `docs/decisions/README.md`.

- [ ] **Step 4: Write ADR `0009-milestone-gating-model.md`** — Context, Decision (the six dialogue decisions), Alternatives (multipliers in #17; typed reward union; closures; only-`unlocks` state; all-in-`sim.ts`; folding directive unlocks), Consequences. Follow `0008`'s shape.

- [ ] **Step 5: Run the full check** — `npm run check` → typecheck + lint + all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: milestones architecture doc, ADR 0009, and lockstep updates (#17)"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — file layout (1–2), state (3), data model (1), metrics/predicate (1), evaluation/tick (2–3), starter set (1, 3), gating (3), persistence/migration (4), UI (5), docs/ADR (6). Review Focus items 1–5 map to Tasks 4, 2, 3, 1, 3.

**Type consistency:** `MilestoneInput`, `MetricId`, `MilestoneDef`, `MILESTONES`, `UNLOCK`, `METRICS`, `milestoneMet`, `milestoneProgress`, `evaluateMilestones`, `hasUnlock` keep one name/type throughout. `GameState` satisfies `MilestoneInput` structurally once Task 3 adds the two fields and the six read fields exist.

**Decisions pinned where the spec was silent:** `MetricId` drops `directivesSeen` (cycle avoidance); `evaluateMilestones` mutates + returns ids and the `log` lives in `tick`; `MilestoneInput` mirrors `PerkInput`.

**Known follow-ups (not this plan):** #18/#19/#23 author their own milestone rows on the forward ids; `directivesSeen` as a later metric; the broader `sim.ts` split.
