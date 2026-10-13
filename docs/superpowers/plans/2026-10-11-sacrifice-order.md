# Player-Controlled Sacrifice Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player choose the reap order the cleanup sweep uses, instead of a frozen per-tier priority.

**Architecture:** A new `sacrificeOrder: number[]` in `GameState` (first = reaped first) becomes the single source of truth, exposed via `priorityOf(s, tier)`. The priority-based directives (`standard`, `sigkill`, `backpressure`) reap in that order; `scavenger` and `group-kill` keep their own fixed selection. A new panel reorders it with up/down buttons. Defaults reproduce today's behavior exactly.

**Tech Stack:** TypeScript (strict), Vite+ (`vp`: Vitest, oxlint, oxfmt), plain DOM. No new dependencies.

**Spec/design:** `docs/superpowers/plans/2026-10-11-sacrifice-order.md` (this plan); issue #9; builds on the sweep directive model from #8.

## Global Constraints

- TypeScript strict; `noUnusedLocals` / `noUnusedParameters` — no dead imports.
- `src/sim.ts` must not import from the DOM, timers, or `main.ts`; no `Math.random` in sweep logic.
- Plain `number` only; all mutating sim actions return `boolean`.
- Docs and code change together (lockstep); `npm run check` must pass before the PR.
- **No behavior change by default:** with the default order, `standard` must reap exactly as before (tier 0 first).
- Only `standard`, `sigkill`, and `backpressure` honor the player order. `scavenger` (highest `baseOutput`) and `group-kill` (densest tier) ignore it.
- New branch is stacked on `feat/sweep-directives` (issue #8 code); do not touch unrelated code.

## Review Focus

Failure modes the design implies (each gets a test):

- Existing save with no `sacrificeOrder` loads on the default. (Task 2)
- Corrupt order (duplicate / missing / out-of-range / wrong length) is sanitized, not trusted. (Task 1)
- Moving past either end is refused (`false`) and does not mutate. (Task 1)
- `scavenger` / `group-kill` are unaffected by reordering. (Task 1)
- Default order preserves prior `standard` behavior. (Task 1)

---

### Task 1: Sacrifice-order model in `src/sim.ts`

**Files:**

- Modify: `src/sim.ts`, `src/sim.test.ts`, `docs/architecture/001-simulation-core.md`

**Interfaces:**

- Produces:
  - `GameState.sacrificeOrder: number[]`
  - `export const DEFAULT_SACRIFICE_ORDER: number[]`
  - `export function priorityOf(s, tier): number` — rank (index in `sacrificeOrder`)
  - `export function priorityOrder(s): number[]` — tier indices sorted by `priorityOf`
  - `export function movePriority(s, tier, delta: -1 | 1): boolean`
  - `export function sanitizeSacrificeOrder(order: unknown): number[]`

- [ ] **Step 1: Write the failing tests**

Add to `src/sim.test.ts` (import `DEFAULT_SACRIFICE_ORDER`, `movePriority`, `priorityOf`, `priorityOrder`, `sanitizeSacrificeOrder` from `./sim`; `directiveById` already imported).

```ts
describe("sacrifice order", () => {
  it("defaults to the current tier priority order", () => {
    const s = newGame();
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4]);
    expect(priorityOf(s, 0)).toBe(0);
  });

  it("standard reaps in the player's order", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0];
    expect(movePriority(s, 1, -1)).toBe(true); // tier 1 to the front
    expect(s.sacrificeOrder).toEqual([1, 0, 2, 3, 4]);
    expect(directiveById.get("standard")!.victims(s, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("refuses to move past either end", () => {
    const s = newGame();
    expect(movePriority(s, 0, -1)).toBe(false);
    expect(movePriority(s, 4, 1)).toBe(false);
    expect(s.sacrificeOrder).toEqual([0, 1, 2, 3, 4]); // unchanged
  });

  it("priorityOrder reflects priorityOf", () => {
    const s = newGame();
    movePriority(s, 4, -1); // [0, 1, 2, 4, 3]
    expect(priorityOrder(s)).toEqual([0, 1, 2, 4, 3]);
  });

  it("scavenger and group-kill ignore the sacrifice order", () => {
    const s = newGame();
    s.counts = [5, 5, 5, 5, 5];
    for (let i = 0; i < 4; i++) movePriority(s, 4, -1); // tier 4 first in the player's order
    expect(s.sacrificeOrder[0]).toBe(4);
    expect(directiveById.get("scavenger")!.victims(s, 3)).toEqual([4, 4, 4]); // by output, not order
    expect(directiveById.get("group-kill")!.victims(s, 3)).toEqual([0, 0, 0]); // densest tie-break
  });
});

describe("sanitizeSacrificeOrder", () => {
  it("keeps a valid permutation", () => {
    expect(sanitizeSacrificeOrder([2, 0, 1, 3, 4])).toEqual([2, 0, 1, 3, 4]);
  });
  it("falls back to the default for invalid input", () => {
    expect(sanitizeSacrificeOrder([0, 0, 1, 2, 3])).toEqual(DEFAULT_SACRIFICE_ORDER); // duplicate
    expect(sanitizeSacrificeOrder([0, 1, 2])).toEqual(DEFAULT_SACRIFICE_ORDER); // wrong length
    expect(sanitizeSacrificeOrder([0, 1, 2, 3, 9])).toEqual(DEFAULT_SACRIFICE_ORDER); // out of range
    expect(sanitizeSacrificeOrder(undefined)).toEqual(DEFAULT_SACRIFICE_ORDER);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts` (fallback `npm run test -- src/sim.test.ts`)
Expected: FAIL — `movePriority` / `priorityOf` / etc. not exported.

- [ ] **Step 3: Implement the model**

In `src/sim.ts`:

- `export const DEFAULT_SACRIFICE_ORDER = TIERS.map((_, i) => i).sort((a, b) => TIERS[a].priority - TIERS[b].priority);` (`TIERS.priority` becomes the default-order source only).
- Add `sacrificeOrder: number[]` to `GameState`; `newGame()` sets `sacrificeOrder: [...DEFAULT_SACRIFICE_ORDER]`.
- `priorityOf(s, tier) { return s.sacrificeOrder.indexOf(tier); }`.
- `priorityOrder(s) { return TIERS.map((_, i) => i).sort((a, b) => priorityOf(s, a) - priorityOf(s, b)); }`.
- `movePriority(s, tier, delta)`: `pos = indexOf(tier)`, `next = pos + delta`; return `false` if `pos < 0` or `next` out of range; swap in place and return `true`.
- `sanitizeSacrificeOrder(order)`: return a copy if `order` is an array of length `TIERS.length` that is a permutation of `0..TIERS.length-1`; otherwise `[...DEFAULT_SACRIFICE_ORDER]`.
- Replace the static `ascendingPriorityOrder` const: `standard`, `sigkill`, and `backpressure` use `priorityOrder(s)` inside `victims`. Leave `scavenger` (`descendingOutputOrder`) and `group-kill` untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS — new tests plus all pre-existing sweep/directive tests (default order preserves behavior).

- [ ] **Step 5: Update `docs/architecture/001-simulation-core.md`**

Add `sacrificeOrder` to the `GameState` table; in the sweep section document `priorityOf`/`priorityOrder`, the default order, and that only `standard`/`sigkill`/`backpressure` honor it while `scavenger`/`group-kill` do not.

- [ ] **Step 6: Run the full check and commit**

Run: `npm run check` → PASS.

```bash
git add src/sim.ts src/sim.test.ts docs/architecture/001-simulation-core.md
git commit -m "feat: player-controlled sacrifice order in the sim (#9)"
```

---

### Task 2: Sacrifice-order panel and save sanitize

**Files:**

- Modify: `index.html`, `src/main.ts`, `src/style.css`, `docs/architecture/002-render-system.md`

**Interfaces:**

- Consumes: `sacrificeOrder`, `priorityOf`/`priorityOrder`, `movePriority`, `sanitizeSacrificeOrder`, `DEFAULT_SACRIFICE_ORDER`, `TIERS` (Task 1).

- [ ] **Step 1: Add the panel markup**

In `index.html`, add a section after the `legacy daemons` panel:
`<section class="panel"><h2>sacrifice order</h2><p class="hint">priority-based sweeps reap from the top down; scavenger and group-kill ignore this</p><div id="priorityPanel" class="priority"></div></section>`.

- [ ] **Step 2: Render the rows**

In `src/main.ts`: add `priorityPanel` to the `el` map; add `renderPriority()` that lists `state.sacrificeOrder` top-to-bottom (top = reaped first) with each row showing the tier name and `▲`/`▼` buttons wired to `movePriority(state, tier, -1 | 1)` then `render(true)`. Rebuild rows only when the joined order changes (signature guard, like `legacyPanel`). Call `renderPriority()` from `render()`.

- [ ] **Step 3: Sanitize on load**

In `decode()` in `src/main.ts`, after merging the parsed save, set `s.sacrificeOrder = sanitizeSacrificeOrder(s.sacrificeOrder)` so an old save (no field) or a corrupt one falls back to the default.

- [ ] **Step 4: Style**

In `src/style.css`, add `.priority` row styling consistent with the existing panels (and a `.hint` caption style).

- [ ] **Step 5: Verify**

Run: `npm run check` → PASS. Then run the dev server (`npm run dev`, http://localhost:5173), use browser tools to open the page, click a `▼`/`▲` to reorder, and screenshot the panel. Report the exact row order before and after the click. Stop the server when done.

- [ ] **Step 6: Update `docs/architecture/002-render-system.md`**

Document the new panel (rows in reap order, up/down controls, the caption).

- [ ] **Step 7: Commit**

```bash
git add index.html src/main.ts src/style.css docs/architecture/002-render-system.md
git commit -m "feat: sacrifice-order panel and save sanitize (#9)"
```

---

## After the tasks

- Run `npm run check` once on the branch.
- Open a PR against `feat/sweep-directives` (stacked), referencing #9 (`Closes #9`) and noting the stack on #32.
