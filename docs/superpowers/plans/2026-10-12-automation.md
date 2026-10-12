# Automation (auto-nice / auto-malloc / auto-free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nice`, `malloc`, and `free()` earned and independently toggleable, running inside `tick` deterministically and never over-spending.

**Architecture:** Four persisted fields + a `runAutomation(s)` block in `src/sim.ts` (called live-only, before the sweep); one `hands-off` milestone row in `src/config/milestones.ts` granting #17's three `auto-*` unlock ids; an automation group in the upgrades panel; sanitizing + a staged migration in `src/persistence.ts`.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-12-automation-design.md`](../specs/2026-10-12-automation-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on.
- Unbounded values use `Decimal` from `src/bignum.ts`.
- Every mutating sim action returns `boolean`; automation calls them and ignores the return.
- New persistent fields get a `newGame()` default; saves merge over defaults (additive-safe).
- `SAVE_VERSION` bumps (4 → 5 on this stack) with a **staged** step (`if (from < 5) …`); never a single `< SAVE_VERSION` check.
- `sim.ts` must not import `persistence.ts` (cycle).
- This branch stacks on #18 → #17; RAM uses `s.ramCap`.
- `npm run check` (typecheck + lint + test) must pass; run it without a pipe.

## Review Focus

Failure modes the spec implies but a single task's test might miss — each gets a test in its owning task:

1. **Offline:** automation must not run on `{ offline: true }` ticks (Task 2).
2. **Once per tick:** each automation buys at most one level per tick (Task 2).
3. **Overspend:** automation never drives `cycles` negative (Task 2).
4. **Threshold boundary:** `auto-free` fires at `leak >= freeThreshold` and not below; `0` fires on any leak (Task 2).
5. **Corrupt state:** non-boolean toggles coerce; `freeThreshold` clamps `>= 0` (Task 1).

---

### Task 1: State fields + persistence (staged v5)

**Files:**
- Modify: `src/sim.ts`, `src/persistence.ts`
- Test: `src/sim.test.ts`, `src/persistence.test.ts`

**Interfaces:**
- Produces: `GameState.autoNice | autoMalloc | autoFree: boolean`, `GameState.freeThreshold: number`; `SAVE_VERSION === 5`.

- [ ] **Step 1: Write the failing tests**

```ts
// sim.test.ts
describe("automation state", () => {
  it("defaults the toggles off and the threshold to 16", () => {
    const s = newGame();
    expect([s.autoNice, s.autoMalloc, s.autoFree]).toEqual([false, false, false]);
    expect(s.freeThreshold).toBe(16);
  });
});
// persistence.test.ts
describe("automation persistence", () => {
  it("round-trips the fields and coerces/clamps corrupt values", () => {
    const s = newGame();
    s.autoNice = true;
    s.autoFree = true;
    s.freeThreshold = 40;
    const out = decode(encode(s));
    expect(out.autoNice).toBe(true);
    expect(out.autoFree).toBe(true);
    expect(out.freeThreshold).toBe(40);
    expect(decode('{"autoMalloc":1,"freeThreshold":-5}').autoMalloc).toBe(true);
    expect(decode('{"freeThreshold":-5}').freeThreshold).toBe(0);
    expect(decode("{}").freeThreshold).toBe(16);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/sim.test.ts src/persistence.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- `src/sim.ts`: add the four fields to `interface GameState`; default `autoNice: false, autoMalloc: false, autoFree: false, freeThreshold: 16` in `newGame()`; bump `SAVE_VERSION = 5` (update the comment).
- `src/persistence.ts`: in `decode`, `s.autoNice = Boolean(parsed.autoNice)` (and the other two), `s.freeThreshold = Math.max(0, coerceFinite(parsed.freeThreshold, 16))`; add a staged `if (from < 5)` no-op comment after the `< 4` step.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/sim.test.ts src/persistence.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/persistence.ts src/sim.test.ts src/persistence.test.ts
git commit -m "feat(persistence): automation toggle state and staged v5 step (#19)"
```

---

### Task 2: `runAutomation` + the `hands-off` milestone

**Files:**
- Modify: `src/sim.ts`, `src/config/milestones.ts`
- Test: `src/sim.test.ts`

**Interfaces:**
- Consumes: `hasUnlock`, `UNLOCK.autoNice/autoMalloc/autoFree`, `mallocCost`, `niceCost`, `buyMalloc`, `buyNice`, `freeMemory`; the fields (Task 1).
- Produces: `runAutomation(s: GameState): void`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("runAutomation", () => {
  it("auto-malloc buys when toggled, unlocked, and affordable", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + MALLOC_STEP);
  });
  it("does nothing when toggled off or locked", () => {
    const off = newGame();
    off.cycles = d(1e6);
    off.unlocks = { [UNLOCK.autoMalloc]: true }; // toggled off
    tick(off, 0);
    expect(off.ramCap).toBe(BASE.ramCap);
    const locked = newGame();
    locked.cycles = d(1e6);
    locked.autoMalloc = true; // not unlocked
    tick(locked, 0);
    expect(locked.ramCap).toBe(BASE.ramCap);
  });
  it("auto-nice needs both hands-off and first-blood", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.autoNice = true;
    s.unlocks = { [UNLOCK.autoNice]: true }; // missing nice unlock
    tick(s, 0);
    expect(s.nice).toBe(0);
    s.unlocks = { [UNLOCK.autoNice]: true, [UNLOCK.nice]: true };
    tick(s, 0);
    expect(s.nice).toBe(1);
  });
  it("auto-free fires at the threshold and not below", () => {
    const s = newGame();
    s.unlocks = { [UNLOCK.autoFree]: true };
    s.autoFree = true;
    s.freeThreshold = 10;
    s.leak = 9;
    tick(s, 0);
    expect(s.leak).toBe(9); // below
    s.leak = 10;
    tick(s, 0);
    expect(s.leak).toBe(0); // at the threshold
  });
  it("buys at most one level per tick", () => {
    const s = newGame();
    s.cycles = d(1e9);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + MALLOC_STEP);
    tick(s, 0);
    expect(s.ramCap).toBe(BASE.ramCap + 2 * MALLOC_STEP);
  });
  it("does not run on offline ticks", () => {
    const s = newGame();
    s.cycles = d(1e6);
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0, { offline: true });
    expect(s.ramCap).toBe(BASE.ramCap);
  });
  it("never drives cycles negative", () => {
    const s = newGame();
    s.cycles = mallocCost(s); // exactly affordable
    s.unlocks = { [UNLOCK.autoMalloc]: true };
    s.autoMalloc = true;
    tick(s, 0);
    expect(s.cycles.gte(0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/sim.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- Add to `src/config/milestones.ts` `MILESTONES`:
  ```ts
  { id: "hands-off", name: "hands-off", desc: "fork once", metric: "forks", at: 1, unlocks: ["auto-nice", "auto-malloc", "auto-free"] },
  ```
- Add to `src/sim.ts`:
  ```ts
  /** Earned automation: at most one action of each kind per tick, live ticks only. */
  export function runAutomation(s: GameState): void {
    if (hasUnlock(s, UNLOCK.autoFree) && s.autoFree && s.leak >= s.freeThreshold) freeMemory(s);
    if (hasUnlock(s, UNLOCK.autoMalloc) && s.autoMalloc && s.cycles.gte(mallocCost(s))) buyMalloc(s);
    if (hasUnlock(s, UNLOCK.autoNice) && s.autoNice && s.cycles.gte(niceCost(s))) buyNice(s);
  }
  ```
- Call it in `tick` **immediately after the `if (opts.offline) return;` line and before the sweep step**.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/sim.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/config/milestones.ts src/sim.test.ts
git commit -m "feat(sim): earned automation and hands-off milestone (#19)"
```

---

### Task 3: Automation group in the upgrades panel

**Files:**
- Modify: `index.html`, `src/main.ts`, `src/style.css`

**Interfaces:**
- Consumes: `hasUnlock`, `UNLOCK.autoNice`, `UNLOCK.autoFree`.

- [ ] **Step 1: Add the group** to `index.html` inside the upgrades section, before `#upgradePanel`:

```html
<div id="autoWrap" class="automation" hidden>
  <label><input type="checkbox" id="autoNiceToggle" /> auto-nice</label>
  <label><input type="checkbox" id="autoMallocToggle" /> auto-malloc</label>
  <label><input type="checkbox" id="autoFreeToggle" /> auto-free</label>
  <label>leak ≥ <input type="number" id="freeThresholdInput" min="0" step="1" /> MB</label>
</div>
```

- [ ] **Step 2: Wire it in `src/main.ts`**

- Add `autoWrap`, `autoNiceToggle`, `autoMallocToggle`, `autoFreeToggle`, `freeThresholdInput` to `el` (inputs as `HTMLInputElement`).
- In `render()`: `el.autoWrap.hidden = !hasUnlock(state, UNLOCK.autoNice)`; set each checkbox `checked` and the input `value` from state.
- Attach `change` listeners once (mirroring the buy-max toggle) that write `state.autoNice`/`autoMalloc`/`autoFree` and `state.freeThreshold = Math.max(0, Number(el.freeThresholdInput.value) || 0)`, then `render(true)`.

- [ ] **Step 3: Style** `.automation` in `src/style.css` — a flex-wrap row above the upgrade buttons, with `.automation[hidden] { display: none; }` (the `[hidden]`-safe rule).

- [ ] **Step 4: Verify manually in the browser**

Run: `npm run dev`. With `forks = 0`, confirm the group is hidden. Seed `forks = 1` (or set it) so `hands-off` fires, confirm the group appears, enable `auto-malloc` with plentiful cycles, and report that `ramCap` rises over a couple of seconds. Screenshot.

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.ts src/style.css
git commit -m "feat(ui): automation group in the upgrades panel (#19)"
```

---

### Task 4: Docs lockstep

**Files:**
- Modify: `docs/architecture/001-simulation-core.md`, `002-render-system.md`, `003-persistence.md`, `010-milestones.md`

- [ ] **Step 1: `001`** — add the four state rows; document `runAutomation` in the tick order (live-only, before the sweep, order free → malloc → nice, one action each per tick); note the `nice`/`malloc`/`free` interaction.
- [ ] **Step 2: `002`** — document the automation group (hidden until unlocked; checkboxes + threshold input).
- [ ] **Step 3: `003`** — bump to `SAVE_VERSION = 5`, add the `< 5` no-op row, and the coercion/clamp for the four fields.
- [ ] **Step 4: `010`** — add the `hands-off` row.
- [ ] **Step 5: Run `npm run check`** → all PASS.
- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: automation rule, panel, and hands-off milestone (#19)"
```

---

## Self-Review

**Spec coverage:** decisions 1–4 map to Tasks 1–3; the milestone to Task 2; state/persistence to Task 1; UI to Task 3; docs to Task 4. Review Focus items 1–5 map to Tasks 2, 2, 2, 2, 1.

**Type consistency:** `runAutomation(s: GameState): void` and the four field names keep one spelling throughout; `SAVE_VERSION = 5` is used consistently.

**Decisions pinned where the spec was silent:** the automation order is `free → malloc → nice`; `freeThreshold` default `16`; `runAutomation` is a named export so it is directly testable.

**Known follow-ups (not this plan):** the Phase B integration merge resolves the `SAVE_VERSION`/`ramCapTotal` consolidation; a cycles reserve and the `forks ≥ 1`/threshold values are tunable data.
