# Sweep Directive Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single fixed cleanup sweep with a roster of named, previewable sweep directives that escalate as the player survives sweeps.

**Architecture:** All game rules live in the pure `src/sim.ts`. A `SweepDirective` describes a sweep's budget and victim selection; a seeded PRNG picks the next directive from the currently unlocked pool and stores it in state so the countdown preview is truthful and survives save/load. `standard` reproduces today's exact behavior. The only UI change is the sweep label in `src/main.ts`.

**Tech Stack:** TypeScript (strict), Vite+ (`vp`: Vitest, oxlint, oxfmt), plain DOM. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-sweep-directives-design.md`

## Global Constraints

- TypeScript strict; `noUnusedLocals` / `noUnusedParameters` are on — no dead imports.
- `src/sim.ts` must not import from the DOM, timers, or `main.ts`; no `Math.random` in sweep logic.
- Unbounded values are `Decimal` via `src/bignum.ts`; these changes use plain `number` only.
- All mutating sim actions return `boolean`; `tick` is the only place time advances.
- Docs and code change together (lockstep). `npm run check` (typecheck + lint + test) must pass before the PR.
- Exact values: `severity = min(0.35, 0.15 + sweepsSurvived * 0.002)`; `sweepVictimMult = max(0.3, 1 - nice * 0.03)`; unlock thresholds `standard 0`, `sigkill 3`, `scavenger 6`, `group-kill 10`, `backpressure 15`; budget fractions `scavenger 0.6`, `backpressure 0.5`.

## Review Focus

Input classes / failure modes the spec implies but no unit test naturally pins (each gets a test in the owning task):

- Empty process table on a sweep — no crash, sweep still counts, `nextDirective` still advances. (Task 3)
- Corrupt/unknown `nextDirective` id loaded from a save — falls back to `standard` instead of throwing. (Task 3)
- `unlockAt` boundary — a directive is drawable exactly at its threshold (`<=`, not `<`). (Task 3)
- `nice` at its floor under `sigkill` — budget is unchanged by `nice`. (Task 2)
- Budget larger than the owned children — victim list never exceeds what exists. (Task 1)

---

### Task 1: `SweepDirective` model and the `standard` directive

**Files:**

- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**

- Consumes: existing `TIERS`, `sweepsSurvived`, `nice`, `sweepVictimMult`, `log`.
- Produces:
  - `export type DirectiveId = "standard" | "sigkill" | "scavenger" | "group-kill" | "backpressure"`
  - `export interface SweepDirective { id; name; flavor; unlockAt; ignoresNice; budget(s, totalChildren): number; victims(s, budget): number[]; pre?(s): void }`
  - `export const DIRECTIVES: SweepDirective[]` (initially `[standard]`)
  - `export const directiveById: Map<DirectiveId, SweepDirective>`
  - `function baseSeverity(s): number` and `function sweepBudget(s, total, frac, ignoresNice): number`
  - `export function reapInOrder(s: GameState, order: number[], budget: number): number[]` — pure; returns reaped tier indices.

- [ ] **Step 1: Write the failing tests**

Add to `src/sim.test.ts`; import `DIRECTIVES`, `directiveById`, `reapInOrder` from `./sim`.

```ts
describe("sweep directive model", () => {
  it("standard reaps the lowest-priority tier first", () => {
    const s = newGame();
    s.counts = [10, 10, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it("standard budget matches the severity formula", () => {
    const s = newGame(); // sweepsSurvived 0 -> severity 0.15, nice 0 -> mult 1
    s.counts = [100, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.budget(s, 100)).toBe(15);
  });

  it("never returns more victims than are owned", () => {
    const s = newGame();
    s.counts = [2, 0, 0, 0, 0];
    const d = directiveById.get("standard")!;
    expect(d.victims(s, 50)).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL — `directiveById is not defined` (module export missing).

- [ ] **Step 3: Implement the model and refactor `runSweep`**

In `src/sim.ts`, add the `DirectiveId` union, the `SweepDirective` interface, `baseSeverity`, `sweepBudget`, `reapInOrder`, the `standard` directive, `DIRECTIVES`, and `directiveById`. Reimplement `runSweep` to resolve a directive and apply it:

```ts
// runSweep
const total = s.counts.reduce((a, b) => a + b, 0);
if (total === 0) {
  log(s, "cleanup sweep: nothing to reap");
  s.sweepsSurvived++;
  return;
}
const d = directiveById.get("standard")!; // Task 3 replaces this with s.nextDirective
d.pre?.(s);
const victims = d.victims(s, d.budget(s, total));
for (const i of victims) s.counts[i]--;
s.sweepsSurvived++;
log(
  s,
  `cleanup sweep [${d.name}]: reaped ${victims.length} process${victims.length === 1 ? "" : "es"}`,
);
```

`standard.budget` = `sweepBudget(s, total, 1, false)`; `standard.victims` = `reapInOrder(s, ascendingPriorityOrder, budget)`; `ascendingPriorityOrder` sorts `TIERS` indices by `priority` ascending. `reapInOrder` walks the order, taking `min(count, remaining)` from each tier and pushing that tier index, never mutating `s`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS — the new tests **and** the pre-existing `cleanup sweep` tests (behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat: introduce SweepDirective model with standard directive (#8)"
```

---

### Task 2: The rival directives

**Files:**

- Modify: `src/sim.ts`, `src/sim.test.ts`

**Interfaces:**

- Consumes: `SweepDirective`, `reapInOrder`, `sweepBudget`, `directiveById` (Task 1).
- Produces: `sigkill`, `scavenger`, `group-kill`, `backpressure` appended to `DIRECTIVES` (and thus to `directiveById`). `runSweep` is unchanged; these are exercised directly until Task 3 wires them to the draw.

- [ ] **Step 1: Write the failing tests**

```ts
describe("sweep directives", () => {
  it("sigkill ignores nice entirely", () => {
    const noNice = newGame();
    noNice.counts = [100, 0, 0, 0, 0];
    const nice = newGame();
    nice.counts = [100, 0, 0, 0, 0];
    nice.nice = 20; // well past the floor
    const d = directiveById.get("sigkill")!;
    expect(d.budget(noNice, 100)).toBe(15);
    expect(d.budget(nice, 100)).toBe(d.budget(noNice, 100)); // nice does not reduce it
  });

  it("scavenger reaps the highest-output tier first", () => {
    const s = newGame();
    s.counts = [10, 10, 10, 10, 10];
    const d = directiveById.get("scavenger")!;
    expect(d.victims(s, 3)).toEqual([4, 4, 4]); // tier 4 has the highest baseOutput
  });

  it("group-kill reaps the densest tier first", () => {
    const s = newGame();
    s.counts = [0, 9, 2, 0, 0]; // tier 1 is densest
    const d = directiveById.get("group-kill")!;
    expect(d.victims(s, 11)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  });

  it("backpressure reclaims the leak and reaps half the usual budget", () => {
    const s = newGame();
    s.counts = [100, 0, 0, 0, 0];
    s.leak = 50;
    const d = directiveById.get("backpressure")!;
    d.pre?.(s);
    expect(s.leak).toBe(0);
    expect(d.budget(s, 100)).toBe(8); // round(100 * 0.15 * 0.5) = 8
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL — `directiveById.get("sigkill")` (and the others) is `undefined`.

- [ ] **Step 3: Implement the four directives**

Append to `DIRECTIVES`, reusing `reapInOrder` and `sweepBudget`:

- `sigkill`: `ignoresNice: true`, `unlockAt: 3`, budget `sweepBudget(s, total, 1, true)`, victims ascending priority.
- `scavenger`: `unlockAt: 6`, budget `sweepBudget(s, total, 0.6, false)`, victims in descending-`baseOutput` order.
- `group-kill`: `unlockAt: 10`, budget `sweepBudget(s, total, 1, false)`, victims in descending-`count` order.
- `backpressure`: `unlockAt: 15`, budget `sweepBudget(s, total, 0.5, false)`, victims ascending priority, `pre(s) { s.leak = 0; }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat: add sigkill, scavenger, group-kill, backpressure directives (#8)"
```

---

### Task 3: Seeded draw, escalation pool, and `nextDirective`

**Files:**

- Modify: `src/sim.ts`, `src/sim.test.ts`

**Interfaces:**

- Consumes: `DIRECTIVES`, `directiveById` (Tasks 1–2); `sweepsSurvived`.
- Produces: `GameState.rngState: number`, `GameState.nextDirective: DirectiveId`; `export function nextRng(s): number`; `export function unlockedDirectives(s): SweepDirective[]`; `export function pickNextDirective(s): DirectiveId`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("directive scheduling", () => {
  it("starts on the standard directive", () => {
    expect(newGame().nextDirective).toBe("standard");
  });

  it("only draws from directives unlocked at the current sweep count", () => {
    const s = newGame();
    s.sweepsSurvived = 0;
    expect(unlockedDirectives(s).map((d) => d.id)).toEqual(["standard"]);
    s.sweepsSurvived = 3; // boundary: sigkill unlocks exactly here
    expect(unlockedDirectives(s).map((d) => d.id)).toEqual(["standard", "sigkill"]);
    for (let i = 0; i < 50; i++) {
      s.rngState = (i + 1) * 2654435761;
      expect(["standard", "sigkill"]).toContain(pickNextDirective(s));
    }
  });

  it("is deterministic for a fixed rngState", () => {
    const a = newGame();
    a.rngState = 12345;
    a.sweepsSurvived = 20;
    const b = newGame();
    b.rngState = 12345;
    b.sweepsSurvived = 20;
    expect(pickNextDirective(a)).toBe(pickNextDirective(b));
  });

  it("never immediately repeats a directive when more than one is unlocked", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.rngState = 999;
    s.nextDirective = "scavenger";
    for (let i = 0; i < 50; i++) expect(pickNextDirective(s)).not.toBe("scavenger");
  });

  it("advances the next directive after a sweep", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.counts = [10, 0, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(
      s.nextDirective,
    );
  });

  it("still advances with no children to reap", () => {
    const s = newGame();
    s.sweepsSurvived = 20;
    s.sweepTimer = 0.001;
    tick(s, 0.01);
    expect(s.sweepsSurvived).toBe(21);
    expect(["standard", "sigkill", "scavenger", "group-kill", "backpressure"]).toContain(
      s.nextDirective,
    );
  });

  it("falls back to standard for an unknown loaded directive id", () => {
    const s = newGame();
    (s as unknown as { nextDirective: string }).nextDirective = "bogus";
    s.counts = [10, 0, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepTimer = 0.001;
    expect(() => tick(s, 0.01)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vp test run src/sim.test.ts`
Expected: FAIL — `unlockedDirectives` / `pickNextDirective` not exported; `nextDirective` undefined.

- [ ] **Step 3: Implement scheduling**

- Add `rngState: number` (int32) and `nextDirective: DirectiveId` to `GameState`; in `newGame()` set `nextDirective: "standard"` and `rngState` from `Date.now() | 0` (nonzero).
- `nextRng(s)`: mulberry32 step advancing `s.rngState`, returning `[0,1)`.
- `unlockedDirectives(s)` = `DIRECTIVES.filter(d => d.unlockAt <= s.sweepsSurvived)`.
- `pickNextDirective(s)`: take the unlocked pool, exclude the just-fired directive (`s.nextDirective`) when the pool length > 1, index with `Math.floor(nextRng(s) * pool.length)`.

Restructure `runSweep` so the redraw happens on **every** sweep, including the empty table:

```ts
const total = s.counts.reduce((a, b) => a + b, 0);
const d = directiveById.get(s.nextDirective) ?? directiveById.get("standard")!;
if (total === 0) {
  log(s, "cleanup sweep: nothing to reap");
} else {
  d.pre?.(s);
  const victims = d.victims(s, d.budget(s, total));
  for (const i of victims) s.counts[i]--;
  log(
    s,
    `cleanup sweep [${d.name}]: reaped ${victims.length} process${victims.length === 1 ? "" : "es"}`,
  );
}
s.sweepsSurvived++;
s.nextDirective = pickNextDirective(s);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vp test run src/sim.test.ts`
Expected: PASS (all directive-scheduling tests above).

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat: seeded escalating sweep directive selection (#8)"
```

---

### Task 4: Surface the directive on the countdown

**Files:**

- Modify: `src/main.ts`, `docs/architecture/002-render-system.md`

**Interfaces:**

- Consumes: `directiveById`, `GameState.nextDirective` (Tasks 1–3).

- [ ] **Step 1: Implement the label**

In `render()`, prefix the sweep text with the incoming directive name, e.g.
`next cleanup sweep: ${directiveById.get(state.nextDirective)?.name ?? "standard"} in ${fmtTime(state.sweepTimer)} · reaping ~${est}`. Import `directiveById` from `./sim`.

- [ ] **Step 2: Verify the build and tests**

Run: `npm run check`
Expected: PASS (typecheck + lint + tests).

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`; open `http://127.0.0.1:5173`. Screenshot the sweep meter and report the exact label text shown (it must name the directive and still show the countdown + victim estimate).

- [ ] **Step 4: Update the doc**

In `docs/architecture/002-render-system.md`, update the sweep-meter bullet to say the label names the incoming directive in addition to the countdown and victim estimate.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts docs/architecture/002-render-system.md
git commit -m "feat: show the incoming sweep directive on the countdown (#8)"
```

---

### Task 5: Update the simulation-core doc

**Files:**

- Modify: `docs/architecture/001-simulation-core.md`

- [ ] **Step 1: Rewrite the sweep section and state table**

- Add `rngState` and `nextDirective` rows to the `GameState` table.
- Replace the `Cleanup sweep (runSweep)` section with the directive model: the `standard` reproduction, the roster table (id / `unlockAt` / budget / selection / `nice` / `pre`) copied from the spec, the seeded-draw + escalation rule, and the "no immediate repeat" rule.
- Note in the tick order that step 5 now resolves the stored `nextDirective`, then redraws it from the unlocked pool (even when there is nothing to reap).

- [ ] **Step 2: Verify the doc matches the code**

Confirm every number and rule in the rewritten section matches `src/sim.ts` exactly (thresholds, fractions, severity, victim orders).

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/001-simulation-core.md
git commit -m "docs: document the sweep directive model (#8)"
```

---

## After the tasks

- Run `npm run check` one final time on the branch.
- Open a PR into `main` referencing issue #8 (`Closes #8`), with the branch `feat/sweep-directives`.
- #16 owns the ADR and the new numbered architecture doc; #15 owns the full directive/priority/victim UI.
