# Achievements with Micro-Multipliers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-driven achievement roster whose earned rows grant small permanent income multipliers through one documented per-tick hook, persisted additively at `SAVE_VERSION` 7, with an achievements panel.

**Architecture:** `src/config/achievements.ts` (leaf data + types) and `src/achievements.ts` (pure logic over a narrow `AchievementInput`) reuse the milestone `METRICS`/`MetricId`/`MetricInput` extracted in `src/milestones.ts`. `src/sim.ts` owns the state field, the `rawCyclesPerSec` hook, and the live-only tick call; `src/persistence.ts` sanitizes and migrates (v7); `src/main.ts` renders the panel.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-13-achievements-design.md`](../specs/2026-10-13-achievements-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on — no dead imports.
- Unbounded values use `Decimal` from `src/bignum.ts`; `AchievementDef.mult` is a plain fraction.
- `src/achievements.ts` has **no DOM** and **no runtime `GameState` import** — narrow input only.
- `achievements → milestones` is the only import direction (no cycle); do **not** add a `legacy` metric.
- The multiplier feeds income through **exactly one** hook (`rawCyclesPerSec`); `baseCyclesPerSec` stays achievement-free (legacy snapshot).
- New persistent field `achievementsDone` defaults to `{}` in `newGame()` (additive-safe).
- `SAVE_VERSION` bumps 6 → 7 with a **staged** `if (from < 7)` no-op; never a single `< SAVE_VERSION` check.
- Run commands must not be piped; `npm run check` green.

## Review Focus

Failure modes the spec implies — each gets a test in its owning task:

1. **Data-driven roster + persistence:** unique ids, real metrics, small positive multipliers; earned rows round-trip and stale keys are dropped (Tasks 1, 3).
2. **Exactly one income hook, not in the legacy snapshot:** `rawCyclesPerSec` scales by `(1 + mult)`; `baseCyclesPerSec` is unchanged and a forked daemon's `rate` is identical with/without earned achievements (Task 2).
3. **Sticky + idempotent evaluation:** a fired achievement stays fired when `children` later drops, and re-running adds nothing (Task 1).
4. **Live-only:** a live tick grants a met achievement; an offline tick grants none (Task 2).
5. **`MetricInput` refactor keeps milestones green:** `METRICS` reads a bare `MetricInput`; the existing milestones suite still passes (Task 1).
6. **UI list:** the panel lists earned + pending with a progress bar and reports the values (Task 4).
7. **Version 7 migration:** a pre-v7 save loads with an empty record and stamps `SAVE_VERSION === 7` (Task 3).

---

### Task 1: `MetricInput` extraction + achievements data and pure logic

**Files:**
- Modify: `src/milestones.ts`
- Create: `src/config/achievements.ts`, `src/achievements.ts`
- Test: `src/milestones.test.ts`, `src/achievements.test.ts`

**Interfaces:**
- Produces (milestones): `MetricInput { totalEarned, sweepsSurvived, forks, playtime, counts, ramCap }`; `MilestoneInput extends MetricInput`; `METRICS: Record<MetricId, (s: MetricInput) => number>`.
- Produces (config): `AchievementId`, `AchievementDef { id, name, desc, metric, at, mult }`, `ACHIEVEMENTS`, `achievementById`.
- Produces (logic): `AchievementInput extends MetricInput { achievementsDone }`, `achievementMet(s, def)`, `achievementProgress(s, def)`, `achievementMult(s): Decimal`, `evaluateAchievements(s): AchievementId[]`, `orderedAchievements(s): AchievementDef[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/achievements.test.ts (new file)
import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { METRICS, type MetricInput } from "./milestones";
import {
  ACHIEVEMENTS,
  achievementById,
  achievementMet,
  achievementMult,
  achievementProgress,
  evaluateAchievements,
  orderedAchievements,
  type AchievementDef,
  type AchievementInput,
} from "./achievements";

const base = (over: Partial<AchievementInput> = {}): AchievementInput => ({
  totalEarned: d(0),
  sweepsSurvived: 0,
  forks: 0,
  playtime: 0,
  counts: [0, 0, 0, 0, 0],
  ramCap: 8,
  achievementsDone: {},
  ...over,
});

describe("achievement roster", () => {
  it("has unique ids, real metrics, positive thresholds, and small positive multipliers", () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.metric in METRICS).toBe(true);
      expect(a.at).toBeGreaterThan(0);
      expect(a.mult).toBeGreaterThan(0);
      expect(a.mult).toBeLessThanOrEqual(0.05);
    }
    expect(achievementById("first-earnings")?.metric).toBe("totalEarned");
  });
});

describe("METRICS reads a bare MetricInput (refactor)", () => {
  it("reads the six readers without milestone/achievement records", () => {
    const m: MetricInput = {
      totalEarned: d(5),
      sweepsSurvived: 1,
      forks: 2,
      playtime: 3,
      counts: [1, 0, 0, 0, 0],
      ramCap: 8,
    };
    expect(METRICS.totalEarned(m)).toBe(5);
    expect(METRICS.children(m)).toBe(1);
    expect(METRICS.forks(m)).toBe(2);
  });
});

describe("achievementMet / achievementProgress", () => {
  const def: AchievementDef = { id: "x", name: "x", desc: "", metric: "ramCap", at: 64, mult: 0.02 };
  it("is met at and above the threshold, not below", () => {
    expect(achievementMet(base({ ramCap: 63 }), def)).toBe(false);
    expect(achievementMet(base({ ramCap: 64 }), def)).toBe(true);
  });
  it("clamps progress to [0, 1]", () => {
    expect(achievementProgress(base({ ramCap: 32 }), def)).toBeCloseTo(0.5, 6);
    expect(achievementProgress(base({ ramCap: 128 }), def)).toBe(1);
  });
});

describe("evaluateAchievements", () => {
  it("fires a met achievement once, is sticky and idempotent", () => {
    const s = base({ totalEarned: d(1e3) });
    expect(evaluateAchievements(s)).toContain("first-earnings");
    expect(s.achievementsDone["first-earnings"]).toBe(true);
    expect(evaluateAchievements(s)).toEqual([]); // idempotent
    s.totalEarned = d(0); // non-monotonic drop
    expect(s.achievementsDone["first-earnings"]).toBe(true); // sticky
  });
});

describe("achievementMult", () => {
  it("is 1 with none earned and the product of (1 + mult) over earned ids", () => {
    expect(achievementMult(base()).toNumber()).toBe(1);
    const a = achievementById("first-earnings")!;
    const b = achievementById("grinder")!;
    const s = base({ achievementsDone: { [a.id]: true, [b.id]: true } });
    expect(achievementMult(s).toNumber()).toBeCloseTo((1 + a.mult) * (1 + b.mult), 10);
  });
});

describe("orderedAchievements", () => {
  it("orders pending by progress descending, then earned last", () => {
    const idx = (ids: string[], id: string) => ids.indexOf(id);
    // ramCap 0 -> headroom pending at 0; totalEarned 1e3 -> first-earnings earned
    const done = orderedAchievements(
      base({ totalEarned: d(1e3), achievementsDone: { "first-earnings": true } }),
    ).map((a) => a.id);
    expect(idx(done, "headroom")).toBeLessThan(idx(done, "first-earnings"));
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/achievements.test.ts src/milestones.test.ts > /tmp/ach.log 2>&1; echo exit=$?`
  → FAIL: `./achievements` does not exist and `MetricInput` is not exported.

- [ ] **Step 3: Implement**

- `src/milestones.ts` — split the interface and retype `METRICS`:
  ```ts
  export interface MetricInput {
    totalEarned: Decimal;
    sweepsSurvived: number;
    forks: number;
    playtime: number;
    counts: number[];
    ramCap: number;
  }

  export interface MilestoneInput extends MetricInput {
    milestonesDone: Record<MilestoneId, true>;
    unlocks: Record<string, true>;
  }

  export const METRICS: Record<MetricId, (s: MetricInput) => number> = { /* unchanged bodies */ };
  ```
  Leave `milestoneMet`/`milestoneProgress`/`hasUnlock`/`evaluateMilestones`/`orderedMilestones`
  taking `MilestoneInput` (it now extends `MetricInput`).
- `src/config/achievements.ts` — the leaf data module:
  ```ts
  import type { MetricId } from "./milestones"; // type-only, keeps this a leaf

  export type AchievementId = string;
  export interface AchievementDef {
    id: AchievementId;
    name: string;
    desc: string;
    metric: MetricId;
    at: number;
    mult: number; // small positive fraction, e.g. 0.02 = +2%
  }

  export const ACHIEVEMENTS: AchievementDef[] = [
    { id: "first-earnings", name: "first earnings", desc: "earn 1,000 cycles", metric: "totalEarned", at: 1e3, mult: 0.02 },
    { id: "grinder", name: "grinder", desc: "earn 1,000,000,000 cycles", metric: "totalEarned", at: 1e9, mult: 0.05 },
    { id: "survivor", name: "survivor", desc: "survive 10 cleanup sweeps", metric: "sweepsSurvived", at: 10, mult: 0.02 },
    { id: "veteran", name: "veteran", desc: "survive 100 cleanup sweeps", metric: "sweepsSurvived", at: 100, mult: 0.04 },
    { id: "forker", name: "forker", desc: "fork once", metric: "forks", at: 1, mult: 0.02 },
    { id: "crowd", name: "crowd", desc: "run 50 children at once", metric: "children", at: 50, mult: 0.03 },
    { id: "headroom", name: "headroom", desc: "raise the RAM ceiling to 64 MB", metric: "ramCap", at: 64, mult: 0.03 },
    { id: "uptime", name: "uptime", desc: "play for one hour", metric: "playtime", at: 3600, mult: 0.02 },
  ];

  export function achievementById(id: AchievementId): AchievementDef | undefined {
    return ACHIEVEMENTS.find((a) => a.id === id);
  }
  ```
- `src/achievements.ts` — pure logic:
  ```ts
  import { d, type Decimal } from "./bignum";
  import { METRICS, type MetricId, type MetricInput } from "./milestones";
  import { ACHIEVEMENTS, achievementById, type AchievementDef, type AchievementId } from "./config/achievements";

  export * from "./config/achievements";

  export interface AchievementInput extends MetricInput {
    achievementsDone: Record<AchievementId, true>;
  }

  export function achievementMet(s: MetricInput, def: AchievementDef): boolean {
    return METRICS[def.metric](s) >= def.at;
  }

  export function achievementProgress(s: MetricInput, def: AchievementDef): number {
    if (def.at <= 0) return 1;
    return Math.min(1, METRICS[def.metric](s) / def.at);
  }

  export function achievementMult(s: Pick<AchievementInput, "achievementsDone">): Decimal {
    let mult = d(1);
    for (const a of ACHIEVEMENTS) if (s.achievementsDone[a.id]) mult = mult.mul(1 + a.mult);
    return mult;
  }

  export function evaluateAchievements(s: AchievementInput): AchievementId[] {
    const fired: AchievementId[] = [];
    for (const a of ACHIEVEMENTS) {
      if (s.achievementsDone[a.id]) continue;
      if (!achievementMet(s, a)) continue;
      s.achievementsDone[a.id] = true;
      fired.push(a.id);
    }
    return fired;
  }

  export function orderedAchievements(s: AchievementInput): AchievementDef[] {
    const pending = ACHIEVEMENTS.filter((a) => !s.achievementsDone[a.id]).sort(
      (a, b) => achievementProgress(s, b) - achievementProgress(s, a),
    );
    const done = ACHIEVEMENTS.filter((a) => s.achievementsDone[a.id]);
    return [...pending, ...done];
  }
  ```

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/achievements.test.ts src/milestones.test.ts > /tmp/ach.log 2>&1; echo exit=$?`
  → PASS (the milestones suite must stay green through the refactor).

- [ ] **Step 5: Commit**

```bash
git add src/milestones.ts src/config/achievements.ts src/achievements.ts src/achievements.test.ts src/milestones.test.ts
git commit -m "feat(achievements): data-driven roster and pure logic; extract MetricInput (#21)"
```

---

### Task 2: State, income hook, and live-only tick evaluation

**Files:**
- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`

**Interfaces:**
- Consumes: `achievementMult`, `evaluateAchievements`, `achievementById` (Task 1); `type AchievementId` from `./config/achievements`.
- Produces: `GameState.achievementsDone: Record<AchievementId, true>`; `rawCyclesPerSec = perkedBaseCyclesPerSec × lineageMult × achievementMult`; `tick` evaluates achievements live-only.

- [ ] **Step 1: Write the failing tests**

```ts
// src/sim.test.ts — add achievementById from ./achievements; add rawCyclesPerSec, doFork to the ./sim import as needed
describe("achievement income hook", () => {
  it("scales live income by (1 + mult) per earned achievement", () => {
    const s = newGame();
    const def = achievementById("first-earnings")!;
    const before = rawCyclesPerSec(s);
    s.achievementsDone[def.id] = true;
    expect(rawCyclesPerSec(s).toNumber()).toBeCloseTo(before.toNumber() * (1 + def.mult), 10);
  });

  it("leaves baseCyclesPerSec (the legacy snapshot source) achievement-free", () => {
    const s = newGame();
    const before = baseCyclesPerSec(s);
    s.achievementsDone["first-earnings"] = true;
    expect(baseCyclesPerSec(s).eq(before)).toBe(true);
  });

  it("does not bake achievements into a forked daemon's rate", () => {
    const withA = newGame();
    const without = newGame();
    for (const s of [withA, without]) {
      s.totalEarned = d(2e6);
      s.ramCap = 1000;
      s.counts = [0, 0, 0, 0, 10];
    }
    withA.achievementsDone["first-earnings"] = true;
    expect(doFork(withA)).toBe(true);
    expect(doFork(without)).toBe(true);
    expect(withA.legacy[0].rate.eq(without.legacy[0].rate)).toBe(true);
  });
});

describe("achievement tick evaluation", () => {
  it("fires on a live tick", () => {
    const s = newGame();
    s.totalEarned = d(1e3);
    tick(s, 0);
    expect(s.achievementsDone["first-earnings"]).toBe(true);
  });

  it("grants none on an offline tick (live-only)", () => {
    const s = newGame();
    s.totalEarned = d(1e3);
    tick(s, 0, { offline: true });
    expect(s.achievementsDone["first-earnings"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/sim.test.ts > /tmp/sim.log 2>&1; echo exit=$?` → FAIL: `achievementsDone`
  is missing and `rawCyclesPerSec` does not scale.

- [ ] **Step 3: Implement** in `src/sim.ts`:

- Add imports: `import { type AchievementId } from "./config/achievements";` and
  `import { achievementById, achievementMult, evaluateAchievements } from "./achievements";`.
- `GameState` (beside `milestonesDone`/`unlocks`):
  ```ts
  /** Achievements that have fired (sticky); each grants a small permanent income multiplier. */
  achievementsDone: Record<AchievementId, true>;
  ```
- `newGame()`: `achievementsDone: {},`.
- `rawCyclesPerSec`:
  ```ts
  export function rawCyclesPerSec(s: GameState): Decimal {
    return perkedBaseCyclesPerSec(s).mul(lineageMult(s)).mul(achievementMult(s));
  }
  ```
  (Update its doc comment: the achievement multiplier rides the same per-tick hook as lineage
  and is excluded from `baseCyclesPerSec`.)
- `tick`, at the very end (after the milestone loop):
  ```ts
  // achievements: micro-multipliers, evaluated once per live tick alongside milestones
  for (const id of evaluateAchievements(s)) {
    const def = achievementById(id);
    if (def) log(s, `achievement: ${def.name} — +${Math.round(def.mult * 100)}% income`);
  }
  ```
  Leave `baseCyclesPerSec`, `perkedBaseCyclesPerSec`, and `doFork` untouched.

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/sim.test.ts > /tmp/sim.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts
git commit -m "feat(sim): achievement state, income hook, and live-only evaluation (#21)"
```

---

### Task 3: Persistence — sanitize, staged v7

**Files:**
- Modify: `src/sim.ts` (the `SAVE_VERSION` constant + comment only), `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**
- Consumes: `ACHIEVEMENTS` (Task 1), `GameState.achievementsDone` (Task 2).
- Produces: `SAVE_VERSION === 7`; `sanitizeAchievements(raw): Record<string, true>`; `decode` wires the record and runs the staged `if (from < 7)` no-op.

- [ ] **Step 1: Write the failing tests**

```ts
// src/persistence.test.ts — add sanitizeAchievements to the ./persistence import; SAVE_VERSION is already imported
describe("achievements persistence", () => {
  it("round-trips earned achievements", () => {
    const s = newGame();
    s.achievementsDone["first-earnings"] = true;
    expect(decode(encode(s)).achievementsDone["first-earnings"]).toBe(true);
  });

  it("sanitizeAchievements keeps roster ids with truthy values and drops the rest", () => {
    expect(sanitizeAchievements({ "first-earnings": true, bogus: true })).toEqual({
      "first-earnings": true,
    });
    expect(sanitizeAchievements({ "first-earnings": false })).toEqual({});
    expect(sanitizeAchievements(null)).toEqual({});
    expect(sanitizeAchievements([])).toEqual({});
    expect(sanitizeAchievements("nope")).toEqual({});
  });

  it("loads a pre-v7 save with an empty record and stamps version 7", () => {
    const s = decode('{"saveVersion":6}');
    expect(s.achievementsDone).toEqual({});
    expect(s.saveVersion).toBe(7);
    expect(SAVE_VERSION).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/persistence.test.ts > /tmp/persist.log 2>&1; echo exit=$?` → FAIL:
  `sanitizeAchievements` is not exported and `SAVE_VERSION` is still 6.

- [ ] **Step 3: Implement**

- `src/sim.ts` — bump the version and extend the comment:
  ```ts
  /**
   * ... Version 6 added the `offlineCap` level. Version 7 added `achievementsDone` (additive).
   * Versions 3–7 are additive.
   */
  export const SAVE_VERSION = 7;
  ```
- `src/persistence.ts`:
  - Import the roster: `import { ACHIEVEMENTS } from "./config/achievements";`.
  - Add the sanitizer, mirroring `sanitizeMilestones`:
    ```ts
    /**
     * Achievements that have fired: keep only ids present in `ACHIEVEMENTS` whose value is
     * truthy; a non-object (or array) yields `{}`. Rebuilt from the roster, so stale ids never
     * survive.
     */
    export function sanitizeAchievements(raw: unknown): Record<string, true> {
      const out: Record<string, true> = {};
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
      const rec = raw as Record<string, unknown>;
      for (const a of ACHIEVEMENTS) if (rec[a.id]) out[a.id] = true;
      return out;
    }
    ```
  - In `decode`, beside `milestonesDone`/`unlocks`:
    ```ts
    s.achievementsDone = sanitizeAchievements(parsed.achievementsDone);
    ```
  - Extend the staged-migration comment block with the no-op step (no code needed — additive):
    ```ts
    // from < 7: `achievementsDone` is additive too — newGame() defaults it to {} and the
    // roster rebuilds it in `sanitizeAchievements`.
    ```

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/persistence.test.ts > /tmp/persist.log 2>&1; echo exit=$?` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): sanitize achievements and stage v7 (#21)"
```

---

### Task 4: Achievements panel

**Files:**
- Modify: `index.html`, `src/main.ts`, `src/style.css`

**Interfaces:**
- Consumes: `orderedAchievements`, `achievementProgress` from `./achievements`; `METRICS`/`type MetricId` (already imported from `./milestones`); `state.achievementsDone`.

- [ ] **Step 1: Add the panel markup** in `index.html`, after the `milestones` section:

```html
<section class="panel">
  <h2>achievements</h2>
  <div id="achievementPanel" class="achievements"></div>
</section>
```

- [ ] **Step 2: Wire the renderer** in `src/main.ts`:

- Import `orderedAchievements`, `achievementProgress` from `./achievements`.
- Add `achievementPanel: $("achievementPanel"),` to the `el` map.
- Call `renderAchievements();` in `render()`, beside `renderMilestones();`.
- Add the renderer (mirrors `renderMilestones`, reusing the `milestone` row classes):
  ```ts
  function renderAchievements(): void {
    const ordered = orderedAchievements(state);
    const sig = ordered.map((a) => `${a.id}:${state.achievementsDone[a.id] ? 1 : 0}`).join(",");
    if (el.achievementPanel.dataset.sig !== sig) {
      el.achievementPanel.dataset.sig = sig;
      el.achievementPanel.innerHTML = "";
      for (const a of ordered) {
        const row = document.createElement("div");
        row.className = "milestone";
        row.dataset.achievement = a.id;
        const head = document.createElement("div");
        head.className = "milestone-head";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = a.name;
        const status = document.createElement("span");
        status.className = "status";
        head.append(name, status);
        const bar = document.createElement("div");
        bar.className = "bar";
        const fill = document.createElement("div");
        fill.className = "fill";
        bar.appendChild(fill);
        const desc = document.createElement("p");
        desc.className = "hint";
        desc.textContent = a.desc;
        row.append(head, bar, desc);
        el.achievementPanel.appendChild(row);
      }
    }
    for (const a of ordered) {
      const row = el.achievementPanel.querySelector(`[data-achievement="${a.id}"]`);
      if (!row) continue;
      const doneNow = Boolean(state.achievementsDone[a.id]);
      row.classList.toggle("done", doneNow);
      const fill = row.querySelector(".fill") as HTMLElement;
      const status = row.querySelector(".status") as HTMLElement;
      if (doneNow) {
        fill.style.width = "100%";
        status.textContent = `✓ +${Math.round(a.mult * 100)}% income`;
      } else {
        const value = Math.floor(METRICS[a.metric](state));
        fill.style.width = `${Math.min(100, achievementProgress(state, a) * 100)}%`;
        const unit = METRIC_UNIT[a.metric] ? ` ${METRIC_UNIT[a.metric]}` : "";
        status.textContent = `${value} / ${a.at}${unit}`;
      }
    }
  }
  ```

- [ ] **Step 3: Reuse the milestone styles** in `src/style.css` — add `.achievements` to the
  container selector (rows keep the `.milestone` class):
  ```css
  .milestones,
  .achievements {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  ```

- [ ] **Step 4: Verify in the browser.** Run `npm run dev`, then open
  `http://127.0.0.1:5173` with the browser tool. Confirm the achievements panel lists the eight
  rows pending-first; seed cycles/`totalEarned` in the console (`daemon.totalEarned = daemon.totalEarned.add(1e3)`)
  or wait, then confirm `first-earnings` flips to `✓ +2% income` and `cycles/s` rises ~2%.
  Screenshot and report the values.

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.ts src/style.css
git commit -m "feat(ui): achievements panel (#21)"
```

---

### Task 5: Docs lockstep + ADR

**Files:**
- Create: `docs/architecture/011-achievements.md`, `docs/decisions/0012-achievements-multiplier-hook.md`
- Modify: `docs/architecture/README.md`, `docs/architecture/001-simulation-core.md`,
  `docs/architecture/002-render-system.md`, `docs/architecture/003-persistence.md`,
  `docs/architecture/010-milestones.md`, `docs/decisions/README.md`

- [ ] **Step 1: `011-achievements.md`** — the roster table, `AchievementDef`, the pure logic
  (`achievementMet`/`progress`/`mult`/`evaluateAchievements`/`orderedAchievements`), the income
  hook, tick placement (live-only), persistence (v7), and the UI. Register it in
  `docs/architecture/README.md` (`011-achievements.md`).
- [ ] **Step 2: `001`** — add `achievementMult = Π(1 + mult)` and
  `rawCyclesPerSec = perkedBase × lineageMult × achievementMult` to the income block; note
  `baseCyclesPerSec` stays achievement-free; add the `achievementsDone` state row; add the
  achievements tick step (and update the offline "never fires milestones" sentence); add a short
  "Achievements" pointer to doc 011.
- [ ] **Step 3: `002`** — add an "Achievements panel" section mirroring "Milestones panel".
- [ ] **Step 4: `003`** — add the `achievementsDone → sanitizeAchievements` coercion bullet, the
  `| < 7 | 7 | Additive only … |` table row, a "Why v7" paragraph, and update the `SAVE_VERSION = 7`
  stamp sentence.
- [ ] **Step 5: `010`** — point the "Numeric rewards (micro-multipliers) are the achievements
  subsystem's job (tracked separately)" line at doc 011.
- [ ] **Step 6: ADR `0012-achievements-multiplier-hook.md`** — Context (milestones are
  content-only; achievements add numeric rewards), Decision (multiplier in `rawCyclesPerSec`, the
  same per-tick hook as lineage, **not** in the `baseCyclesPerSec` legacy snapshot and **not**
  applied to legacy daemons — one hook; sticky/idempotent; live-only; data-driven roster), the
  rejected alternatives from the spec, and Consequences (v7 additive; legacy exclusion).
  Register it in `docs/decisions/README.md`.
- [ ] **Step 7: Run `npm run check`** →
  `npm run check > /tmp/check.log 2>&1; echo exit=$?` → typecheck + lint + tests all PASS.
- [ ] **Step 8: Commit**

```bash
git add docs
git commit -m "docs: achievements, multiplier hook, and ADR 0012 (#21)"
```

---

## Self-Review

**Spec coverage:** decisions 1–4 → Task 1; decisions 3 (state) + 5 (hook) + 6 (tick) → Task 2;
decision 3 (persistence/version) → Task 3; decision 8 (UI) → Task 4; decision 9 (docs + ADR) →
Task 5. Review Focus items 1–7 map to Tasks 1/3, 2, 1, 2, 1, 4, 3.

**Type consistency:** `AchievementId`/`AchievementDef`/`ACHIEVEMENTS`/`achievementById` are
defined once in `src/config/achievements.ts` and re-exported by `src/achievements.ts`;
`MetricInput`/`METRICS` are the single metric layer; `achievementsDone` is spelled identically in
`sim.ts`, `persistence.ts`, `main.ts`, and the docs; `SAVE_VERSION = 7` is used consistently.

**Decisions pinned where the spec was silent:** the hook test uses the empty board (root = 1
cycle/s) so `rawCyclesPerSec` scales cleanly; the snapshot test forks two identical boards and
compares `legacy[0].rate` directly; the tick tests use `dt = 0` so no income/heat side effects
confuse the grant assertion.

**Known follow-ups (not this plan):** roster thresholds and 1–5% magnitudes are tunable data; if
legacy income should share the achievement multiplier later, that is a new ADR superseding 0012.
