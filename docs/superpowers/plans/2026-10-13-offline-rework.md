# Offline Progress Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the offline cap upgradable with cycles (a `nohup` upgrade) and prove the offline replay matches a sweep-free online run within tolerance — while keeping idling non-punishing.

**Architecture:** Cap constants + `offlineCapS`/`offlineCost`/`buyOfflineCap` and the persisted `offlineCap` level in `src/sim.ts`; `applyOffline` in `src/persistence.ts` bounds the gap by `offlineCapS` and adds a step budget (its non-punishing `{ offline: true }` semantics are unchanged); a `nohup` upgrade button in `src/main.ts`.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-13-offline-rework-design.md`](../specs/2026-10-13-offline-rework-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on.
- Unbounded values use `Decimal` from `src/bignum.ts`.
- Every mutating sim action returns `boolean`.
- New persistent fields get a `newGame()` default; saves merge over defaults (additive-safe).
- `SAVE_VERSION` bumps (5 → 6 on this stack) with a **staged** step (`if (from < 6) …`); never a single `< SAVE_VERSION` check.
- Offline stays **non-punishing**: `tick(s, dt, { offline: true })` semantics do NOT change (no sweep, no OOM; milestones/automation live-only).
- `npm run check` green; run it without a pipe.

## Review Focus

Failure modes the spec implies but a single task's test might miss — each gets a test in its owning task:

1. **Equivalence (deterministic):** online loop vs `applyOffline` over `N < sweepInterval`, no legacy, RAM under cap → equal `totalEarned` (Task 2).
2. **Equivalence (tolerance):** with a legacy daemon → within ~2% (Task 2).
3. **Cap:** `applyOffline(s, huge)` never simulates more than `offlineCapS(s)` seconds (Task 2).
4. **Non-punishing retained:** an offline replay past `sweepInterval` does not advance `sweepsSurvived` (Task 2).
5. **Budget:** the step budget bounds the loop so a huge cap cannot hang (Task 2).

---

### Task 1: `nohup` cap upgrade, state, and persistence (staged v6)

**Files:**

- Modify: `src/sim.ts`, `src/persistence.ts`
- Test: `src/sim.test.ts`, `src/persistence.test.ts`

**Interfaces:**

- Produces: `BASE_OFFLINE_CAP_S`, `OFFLINE_CAP_STEP`, `OFFLINE_MAX_STEPS`, `offlineCapS(s)`, `offlineCost(s)`, `buyOfflineCap(s)`; `GameState.offlineCap: number`; `SAVE_VERSION === 6`.

- [ ] **Step 1: Write the failing tests**

```ts
// sim.test.ts (add BASE_OFFLINE_CAP_S, OFFLINE_CAP_STEP, offlineCapS, offlineCost, buyOfflineCap to the ./sim import)
describe("nohup offline cap upgrade", () => {
  it("starts at the base cap and grows by the step per level", () => {
    const s = newGame();
    expect(s.offlineCap).toBe(0);
    expect(offlineCapS(s)).toBe(BASE_OFFLINE_CAP_S);
    s.cycles = d(1e12);
    expect(buyOfflineCap(s)).toBe(true);
    expect(s.offlineCap).toBe(1);
    expect(offlineCapS(s)).toBe(BASE_OFFLINE_CAP_S + OFFLINE_CAP_STEP);
  });
  it("refuses when unaffordable and costs grow per level", () => {
    const s = newGame();
    expect(buyOfflineCap(s)).toBe(false); // 0 cycles
    s.cycles = d(1e12);
    buyOfflineCap(s);
    expect(offlineCost(s).gt(d(1e7))).toBe(true); // level 1 costs more than level 0
  });
});
// persistence.test.ts
describe("offlineCap persistence", () => {
  it("round-trips and coerces the level", () => {
    const s = newGame();
    s.offlineCap = 3;
    expect(decode(encode(s)).offlineCap).toBe(3);
    expect(decode('{"offlineCap":-2}').offlineCap).toBe(0);
    expect(decode("{}").offlineCap).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/sim.test.ts src/persistence.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- `src/sim.ts`: add `export const BASE_OFFLINE_CAP_S = 8 * 3600;`, `export const OFFLINE_CAP_STEP = 4 * 3600;`, `export const OFFLINE_MAX_STEPS = 200_000;`; add `offlineCap: number` to `GameState` (default `0`); bump `SAVE_VERSION = 6` (comment); add:
  ```ts
  export function offlineCapS(s: GameState): number {
    return BASE_OFFLINE_CAP_S + s.offlineCap * OFFLINE_CAP_STEP;
  }
  export function offlineCost(s: GameState): Decimal {
    return d(1e7).mul(d(5).pow(s.offlineCap));
  }
  export function buyOfflineCap(s: GameState): boolean {
    const cost = offlineCost(s);
    if (s.cycles.lt(cost)) return false;
    s.cycles = s.cycles.sub(cost);
    s.offlineCap++;
    log(s, `nohup: offline cap ${Math.round(offlineCapS(s) / 3600)}h`);
    return true;
  }
  ```
- `src/persistence.ts`: `s.offlineCap = coerceCount(parsed.offlineCap)` in `decode`; add the staged `if (from < 6)` no-op comment.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/sim.test.ts src/persistence.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/persistence.ts src/sim.test.ts src/persistence.test.ts
git commit -m "feat(sim): nohup offline-cap upgrade and staged v6 (#24)"
```

---

### Task 2: Cap-bounded `applyOffline` + equivalence proof

**Files:**

- Modify: `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**

- Consumes: `offlineCapS`, `OFFLINE_MAX_STEPS`, `BASE_OFFLINE_CAP_S` (Task 1).

- [ ] **Step 1: Write the failing tests**

```ts
import { BASE_OFFLINE_CAP_S, offlineCapS } from "./sim";

describe("applyOffline cap and equivalence", () => {
  it("never simulates more than offlineCapS seconds", () => {
    const s = newGame();
    const before = s.playtime;
    applyOffline(s, 100 * 3600); // 100h requested, base cap 8h
    expect(s.playtime - before).toBeLessThanOrEqual(BASE_OFFLINE_CAP_S + 1);
  });
  it("matches an online run in the safe regime (no sweep, RAM under cap)", () => {
    const online = newGame();
    const offline = newGame();
    for (const s of [online, offline]) {
      s.cycles = d(1e6);
      s.counts = [4, 0, 0, 0, 0];
      s.sweepInterval = 1e9; // no sweep within N; also keeps the sweep timer huge
      s.sweepTimer = 1e9;
    }
    const N = 600;
    for (let t = 0; t < N; t++) tick(online, 1);
    applyOffline(offline, N);
    expect(offline.totalEarned.toNumber()).toBeCloseTo(online.totalEarned.toNumber(), 0);
  });
  it("stays within tolerance with a legacy daemon", () => {
    const online = newGame();
    const offline = newGame();
    for (const s of [online, offline]) {
      s.sweepInterval = 1e9;
      s.sweepTimer = 1e9;
      s.legacy = [{ name: "legacy-1", rate: d(100), crashed: false, respawn: 0 }];
    }
    const N = 3600;
    for (let t = 0; t < N; t++) tick(online, 1);
    applyOffline(offline, N);
    const a = online.totalEarned.toNumber();
    const b = offline.totalEarned.toNumber();
    expect(Math.abs(a - b) / a).toBeLessThan(0.02);
  });
  it("does not advance sweepsSurvived offline (non-punishing retained)", () => {
    const s = newGame();
    s.counts = [4, 0, 0, 0, 0];
    applyOffline(s, 600); // > the 60s sweep interval
    expect(s.sweepsSurvived).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/persistence.test.ts` → FAIL (the cap test fails: `applyOffline` currently uses the fixed `OFFLINE_CAP_S`).

- [ ] **Step 3: Implement** in `src/persistence.ts`:

```ts
export function applyOffline(s: GameState, seconds: number): void {
  const before = s.cycles;
  let remaining = Math.min(seconds, offlineCapS(s));
  let budget = OFFLINE_MAX_STEPS;
  while (remaining > 0 && budget-- > 0) {
    const dt = Math.min(1, remaining);
    tick(s, dt, { offline: true }); // non-punishing semantics unchanged
    remaining -= dt;
  }
  log(s, `offline ${fmtTime(seconds)}: +${fmt(s.cycles.sub(before))} cycles`);
}
```

Import `offlineCapS`, `OFFLINE_MAX_STEPS` from `./sim`. Replace the old fixed `OFFLINE_CAP_S` use; keep `OFFLINE_MIN_S`. If `OFFLINE_CAP_S` is still exported and referenced by tests, update those references to `BASE_OFFLINE_CAP_S`.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/persistence.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): cap-bounded offline replay and equivalence proof (#24)"
```

---

### Task 3: `nohup` upgrade button

**Files:**

- Modify: `src/main.ts`, `src/style.css` (only if a style is needed)

**Interfaces:**

- Consumes: `offlineCapS`, `offlineCost`, `buyOfflineCap`.

- [ ] **Step 1: Register the button** in `src/main.ts`, beside the other `addUpgrade(...)` calls:

```ts
addUpgrade(
  () => `nohup(+4h)  ·  offline cap ${Math.round(offlineCapS(state) / 3600)}h`,
  () => offlineCost(state),
  () => state.cycles.gte(offlineCost(state)),
  () => buyOfflineCap(state),
);
```

Import `offlineCapS`, `offlineCost`, `buyOfflineCap` from `./sim`.

- [ ] **Step 2: Verify manually in the browser**

Run: `npm run dev`. With 0 cycles the button is disabled; give the game cycles (or seed a save) and buy it, then confirm the label's cap rises by 4h (8h → 12h). Screenshot.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts src/style.css
git commit -m "feat(ui): nohup offline-cap upgrade button (#24)"
```

---

### Task 4: Docs lockstep + ADR

**Files:**

- Modify: `docs/architecture/003-persistence.md`, `001-simulation-core.md`, `002-render-system.md`
- Create: `docs/decisions/0010-offline-fidelity.md`
- Modify: `docs/decisions/README.md`

- [ ] **Step 1: `003`** — document the upgradable cap (`offlineCapS`), the step budget, and the equivalence guarantee (safe-regime reference).
- [ ] **Step 2: `001`** — add the `nohup` upgrade row to the upgrade-costs table and the `offlineCap` state row.
- [ ] **Step 3: `002`** — document the `nohup` button.
- [ ] **Step 4: ADR `0010-offline-fidelity.md`** — record keeping the non-punishing policy and measuring equivalence against a sweep-free online reference (the deliberate deviation from the issue's literal wording); list the rejected alternatives. Register it in `docs/decisions/README.md`.
- [ ] **Step 5: Run `npm run check`** → all PASS.
- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: offline cap, equivalence, and ADR 0010 (#24)"
```

---

## Self-Review

**Spec coverage:** decisions 1–4 map to Tasks 1–4; the cap to Tasks 1/3; the equivalence to Task 2; docs/ADR to Task 4. Review Focus items 1–5 map to Tasks 2, 2, 2, 2, 2.

**Type consistency:** `offlineCapS`/`offlineCost`/`buyOfflineCap`/`offlineCap` and the constants keep one spelling; `SAVE_VERSION = 6` used consistently.

**Decisions pinned where the spec was silent:** the equivalence test pins `sweepInterval`/`sweepTimer` high to create the safe regime; `applyOffline` keeps the `{ offline: true }` call so Phase A/B behavior is untouched.

**Known follow-ups (not this plan):** the Phase B integration merge renumbers if needed; cost/step values are tunable data.
