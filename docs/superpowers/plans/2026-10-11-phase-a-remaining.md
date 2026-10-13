# Phase A Remaining Work — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax. All work commits directly onto the integration branch `feat/sweep-directives` (the single open PR #32 → `main`).

**Goal:** Finish Epic #5 (Phase A) — tier identity, sweep shields, heat, cross-tier synergy, upgrade rebalance, and the sweep/heat UI.

**Tech Stack:** TypeScript (strict), Vite+ (`vp`), plain DOM. No new dependencies.

**Order (dependencies):** R1 (#12) → R2 (#10) → R3 (#13) → R4 (#11, needs R1) → R5 (#14, needs R1+R3) → R6 (#15, needs R3).

## Global Constraints

- `src/sim.ts` pure w.r.t. DOM/timers; no `Math.random` in rules; plain `number` for bounded values, `Decimal` for unbounded; mutating sim actions return `boolean`.
- TypeScript strict; `noUnusedLocals`/`noUnusedParameters`.
- Every change updates the relevant arch doc in the same commit (lockstep): rules → `001-simulation-core.md`; sweep mechanics → `008-sweep-directives.md`; UI → `002-render-system.md`.
- `npm run check` (typecheck + lint + test) must pass at the end of every task.
- Default behavior should stay playable: no tier/upgrade should strictly dominate another.

## Review Focus

- Existing saves must load with sane defaults for every new field (additive `newGame()` defaults).
- No NaN/Infinity from new multipliers (`heat`, synergy) — the numeric watchdog must stay quiet.
- New costs/curves must be monotonic and never free where they shouldn't be.
- `standard` (default order, default state) behavior may change only where this plan intends (curves/heat), never silently.

---

### Task R1: Tier identity and per-tier curves (#12)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `docs/architecture/001-simulation-core.md`

**Interfaces:**

- `TierDef` gains `costGrowth: number` and `trait: "none" | "leak-immune"`.
- Per-tier growth: noop `1.12`, fork `1.15`, worker `1.15`, microservice `1.18`, cron `1.22`.
- Only `noop loop` has `trait: "leak-immune"`.
- Remove the shared `COST_GROWTH` constant; `tierCost(s, i)` uses `TIERS[i].costGrowth`.
- Leak growth uses only the **non-leak-immune** footprint: `leakFootprint(s)`; `childRam` (RAM cost) is unchanged.

- [ ] **Step 1: Failing tests** — (a) each tier's next-unit cost ratio equals its own `costGrowth`; (b) a `leak-immune` tier contributes to `childRam` but adds zero leak over time; (c) a non-immune tier still leaks at `LEAK_RATE`. **Note:** the existing "grows the leak at 1% of footprint per second" and "gc keeps the leak near zero" tests use `counts = [10,0,0,0,0]` (noop loop, now immune) — update them to use a non-immune tier (e.g. `counts = [0,10,0,0,0]`).
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS (all suites).
- [ ] **Step 5:** Update `001-simulation-core.md` tiers table (add `costGrowth`, `trait`) and the leak section (immune tiers excluded).
- [ ] **Step 6:** `npm run check`; commit `feat: per-tier cost curves and a leak-immune noop loop (#12)`.

---

### Task R2: SIGTERM handler shields (#10)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `src/main.ts`, `index.html`, `docs/architecture/001-simulation-core.md`, `docs/architecture/008-sweep-directives.md`

**Interfaces:**

- `GameState.shields: number` (default 0) — a pool of charges; each absorbs one sweep victim.
- `shieldCost(s): Decimal` = `500 * 2^shields`; `buyShield(s): boolean`.
- In `runSweep`, after the directive's `pre` and budget are computed: `absorbed = min(s.shields, budget); s.shields -= absorbed; budget -= absorbed;` (never negative).
- UI: an upgrade button `SIGTERM handler  ·  N charges`.

- [ ] **Step 1: Failing tests** — buying adds a charge and spends cycles; a sweep with `shields = 2` reaps two fewer than the same sweep with `shields = 0` (pick a directive/counts where budget ≥ 3); charges are consumed and floor at 0; `buyShield` refuses when unaffordable.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement sim + button.
- [ ] **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Docs: `001` (state table + upgrade table) and `008` (shields absorb before selection).
- [ ] **Step 6:** `npm run check`; `npm run dev` smoke check optional; commit `feat: SIGTERM handler shields absorb sweep victims (#10)`.

---

### Task R3: Heat — a second pressure axis (#13)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `docs/architecture/001-simulation-core.md`

**Interfaces:**

- `GameState.heat: number` (0..100, default 0), `GameState.cooling: number` (default 0, upgrade level).
- Constants: `HEAT_PER_RAM = 0.05` (heat/s per MB of footprint), `HEAT_DECAY = 0.8` (heat/s), `HEAT_THROTTLE_AT = 60`, `MAX_THROTTLE = 0.5`. Cooling raises decay: `HEAT_DECAY * (1 + cooling * 0.5)`.
- `tick`: `heat += footprint * HEAT_PER_RAM * dt; heat -= decay * dt;` clamp `[0, 100]`. **Order:** after income, before/after leak (document it).
- `heatMult(s) = 1 - MAX_THROTTLE * clamp((heat - HEAT_THROTTLE_AT) / (100 - HEAT_THROTTLE_AT), 0, 1)`.
- `cyclesPerSec` multiplies by `heatMult(s)`.
- `coolCost(s)` = `1000 * 2.5^cooling`; `buyCooling(s): boolean`.

- [ ] **Step 1: Failing tests** — heat rises with footprint and decays when idle; clamps to [0,100]; `cyclesPerSec` is reduced above `HEAT_THROTTLE_AT` and unchanged below; buying cooling increases decay.
- [ ] **Step 2–4:** TDD RED → implement → GREEN.
- [ ] **Step 5:** Doc `001` (state table, income formula, tick order, upgrade table).
- [ ] **Step 6:** `npm run check`; commit `feat: heat as a second pressure axis (#13)`.

---

### Task R4: Cross-tier synergy (#11)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `docs/architecture/001-simulation-core.md`

**Interfaces:**

- `childOutput` becomes `Σ TIERS[i].baseOutput * counts[i] * synergyMult(s, i)`.
- `synergyMult(s, i)`: `worker thread` gets `1 + 0.02 * counts[microservice]`; `microservice` gets `1 + 0.05 * counts[cron daemon]`; all others `1`.
- Data-driven: express the two links in a small table/array so it is not hardcoded branches.

- [ ] **Step 1: Failing tests** — a mixed set (worker + microservice) out-earns the worker-only equivalent by the exact synergy factor; cron-boosted microservices scale; tiers with no booster are unaffected.
- [ ] **Step 2–4:** TDD RED → implement → GREEN.
- [ ] **Step 5:** Doc `001` (income formula + a short synergy note).
- [ ] **Step 6:** `npm run check`; commit `feat: cross-tier synergy so composition matters (#11)`.

---

### Task R5: Rebalance nice/malloc for the new pressure model (#14)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `docs/architecture/001-simulation-core.md`

**Interfaces:**

- `niceCost` growth `2.5 → 2.2`; keep base `250`.
- `mallocCost` growth `1.9 → 1.85`; keep base `150`.
- No signature changes.

- [ ] **Step 1: Failing tests** — `niceCost`/`mallocCost` at levels 0/1/2 match the new curves and are strictly increasing.
- [ ] **Step 2–4:** TDD RED → implement → GREEN. Confirm no other test depends on the old curves.
- [ ] **Step 5:** Doc `001` upgrade-cost table.
- [ ] **Step 6:** `npm run check`; commit `chore: rebalance nice/malloc for the new pressure model (#14)`.

---

### Task R6: Sweep & heat UI; accurate victim estimate (#15)

**Files:** `src/sim.ts`, `src/sim.test.ts`, `src/main.ts`, `index.html`, `src/style.css`, `docs/architecture/002-render-system.md`

**Interfaces:**

- `export function estimateVictims(s): number` — resolves `s.nextDirective` (fallback `standard`), computes its budget on current counts and the number of victims it would actually reap (same math as `runSweep`, without mutating).
- UI: the sweep label uses `estimateVictims(state)` (replacing the generic severity math — fixes the #15 note), plus a **heat meter** bar and a shields/charges readout near the sweep meter.

- [ ] **Step 1: Failing tests** — `estimateVictims` equals the number actually reaped when the sweep runs, for `standard` (default) and for a forced non-standard directive.
- [ ] **Step 2–4:** TDD RED → implement sim helper; then wire the UI (no unit test for DOM — browser-verify).
- [ ] **Step 5:** Browser check on `npm run dev`; screenshot the sweep meter + heat meter; report values.
- [ ] **Step 6:** Doc `002`; commit `feat: accurate victim estimate, heat meter, shields readout (#15)`.

---

## Finish

- `npm run check` green on `feat/sweep-directives`.
- Push; PR #32 remains the single open PR into `main` (update its body to cover all Phase A work).
