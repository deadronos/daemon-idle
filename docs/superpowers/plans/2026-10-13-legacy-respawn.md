# Legacy Auto-Respawn Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote legacy auto-respawn into an explicit milestone-gated unlock (`legacy-respawn`, two forks), decouple it from `gc`, and prove legacy daemons contribute during offline replay.

**Architecture:** A new `MILESTONES` row + `UNLOCK.legacyRespawn` in `src/config/milestones.ts`; the `tick` respawn condition in `src/sim.ts` changes from `s.gc > 0` to `hasUnlock(s, UNLOCK.legacyRespawn)`. Offline already runs the legacy block before its early-return — this change adds no accumulator, only tests and docs.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-13-legacy-respawn-design.md`](../specs/2026-10-13-legacy-respawn-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on.
- Unbounded values use `Decimal` from `src/bignum.ts`.
- Every mutating sim action returns `boolean` (no change here, but keep the contract).
- **No new persistent state field**; `SAVE_VERSION` stays **6** and no migration step is added
  (`unlocks` already persists and is sanitized).
- `gc` keeps its leak-flush role; it no longer drives respawn.
- `nudgeDaemon` stays the pre-unlock manual restart and must keep working.
- Run commands must not be piped; `npm run check` green.

## Review Focus

Failure modes the spec implies — each gets a test in its owning task:

1. **No unlock → no respawn:** a crashed daemon with `respawn <= 0` stays down even with `gc > 0`
   (Task 2).
2. **Unlock → respawn:** granting `legacy-respawn` makes it auto-restart (Task 2).
3. **Milestone wiring:** two forks fire `legacy-respawn` on the next live tick and grant the
   unlock (Tasks 1–2).
4. **Manual nudge pre-unlock:** `nudgeDaemon` still restarts a crashed row without the unlock
   (Task 2).
5. **Offline legacy contribution:** a tiny-`dt` offline tick adds legacy rate to `cycles`; a
   pre-crashed daemon respawns during `applyOffline` only with the unlock; `applyOffline` with
   legacy earns far more than without (Task 2).
6. **Existing test updated:** the #24 tolerance test no longer relies on `gc = 5` (Task 2).

---

### Task 1: `legacy-respawn` milestone data and unlock id

**Files:**
- Modify: `src/config/milestones.ts`
- Test: `src/milestones.test.ts`

**Interfaces:**
- Produces: `MILESTONES` row `{ id: "legacy-respawn", name: "auto-respawn", desc: "fork twice", metric: "forks", at: 2, unlocks: ["legacy-respawn"] }`; `UNLOCK.legacyRespawn === "legacy-respawn"`.

- [ ] **Step 1: Write the failing tests**

```ts
// milestones.test.ts — add to the existing ./milestones import set as needed
describe("legacy-respawn milestone", () => {
  it("is defined at forks >= 2 and grants the legacy-respawn unlock", () => {
    const def = milestoneById("legacy-respawn")!;
    expect(def.metric).toBe("forks");
    expect(def.at).toBe(2);
    expect(def.unlocks).toEqual([UNLOCK.legacyRespawn]);
    expect(UNLOCK.legacyRespawn).toBe("legacy-respawn");
  });

  it("fires at two forks", () => {
    expect(evaluateMilestones(base({ forks: 1 }))).not.toContain("legacy-respawn");
    const s = base({ forks: 2 });
    expect(evaluateMilestones(s)).toContain("legacy-respawn");
    expect(s.unlocks["legacy-respawn"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/milestones.test.ts` → FAIL
  (`milestoneById("legacy-respawn")` is `undefined`; `UNLOCK.legacyRespawn` is `undefined`).

- [ ] **Step 3: Implement** in `src/config/milestones.ts`:

- Append to `MILESTONES` (after `hands-off`):
  ```ts
  {
    id: "legacy-respawn",
    name: "auto-respawn",
    desc: "fork twice",
    metric: "forks",
    at: 2,
    unlocks: ["legacy-respawn"],
  },
  ```
- Add to `UNLOCK`:
  ```ts
  legacyRespawn: "legacy-respawn",
  ```

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/milestones.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/milestones.ts src/milestones.test.ts
git commit -m "feat(milestones): legacy-respawn unlock at two forks (#20)"
```

---

### Task 2: Unlock-gated respawn + offline legacy tests

**Files:**
- Modify: `src/sim.ts`
- Test: `src/sim.test.ts`, `src/persistence.test.ts`

**Interfaces:**
- Consumes: `UNLOCK.legacyRespawn` (Task 1), `hasUnlock` (already imported in `sim.ts`).
- Produces: `tick` respawns a crashed daemon when `dm.respawn <= 0 && hasUnlock(s, UNLOCK.legacyRespawn)`.

- [ ] **Step 1: Write the failing tests**

```ts
// sim.test.ts — add nudgeDaemon to the ./sim import (UNLOCK is already imported)
describe("legacy auto-respawn unlock", () => {
  it("keeps a crashed daemon down without the unlock, even with gc", () => {
    const s = newGame();
    s.gc = 5; // gc no longer drives respawn
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    tick(s, 1);
    expect(s.legacy[0].crashed).toBe(true);
  });

  it("auto-respawns once the legacy-respawn unlock is granted", () => {
    const s = newGame();
    s.unlocks[UNLOCK.legacyRespawn] = true;
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    tick(s, 1);
    expect(s.legacy[0].crashed).toBe(false);
  });

  it("still restarts a crashed daemon by hand before the unlock", () => {
    const s = newGame();
    s.legacy = [{ name: "legacy-1", rate: d(10), crashed: true, respawn: 0 }];
    expect(nudgeDaemon(s, 0)).toBe(true);
    expect(s.legacy[0].crashed).toBe(false);
  });

  it("fires the milestone at two forks and unlocks auto-respawn", () => {
    const s = newGame();
    s.forks = 2;
    tick(s, 0); // a live tick evaluates milestones
    expect(s.unlocks[UNLOCK.legacyRespawn]).toBe(true);
  });

  it("produces on the offline path (legacy block runs before the early-return)", () => {
    const s = newGame();
    s.legacy = [{ name: "legacy-1", rate: d(1000), crashed: false, respawn: 0 }];
    tick(s, 0.001, { offline: true }); // tiny dt: the 0.2%/s crash roll is effectively impossible
    expect(s.cycles.toNumber()).toBeGreaterThan(0.9); // root 0.001 + legacy 1.0
  });
});
```

```ts
// persistence.test.ts — add UNLOCK to the imports (from ./milestones) and update the
// existing "stays within tolerance with a legacy daemon" test:
//   KEEP    s.gc = 5; // leak-flush: without it the online arm's leak OOMs over 3600s
//   ADD     s.unlocks[UNLOCK.legacyRespawn] = true; // auto-respawn, so crashes are transient
//   (Replacing gc outright gave ~933% divergence; both arms now carry gc + unlock.)

describe("offline legacy contribution", () => {
  it("respawns a crashed daemon offline once the unlock is granted", () => {
    const s = newGame();
    s.unlocks[UNLOCK.legacyRespawn] = true;
    s.legacy = [{ name: "legacy-1", rate: d(1000), crashed: true, respawn: 1 }];
    applyOffline(s, 1); // one offline step: the respawn branch has no Math.random
    expect(s.legacy[0].crashed).toBe(false);
  });

  it("folds offline legacy output into the cycles total", () => {
    const withLegacy = newGame();
    withLegacy.unlocks[UNLOCK.legacyRespawn] = true;
    withLegacy.legacy = Array.from({ length: 10 }, (_, i) => ({
      name: `legacy-${i + 1}`,
      rate: d(1000),
      crashed: false,
      respawn: 0,
    }));
    const baseline = newGame();
    applyOffline(withLegacy, 60);
    applyOffline(baseline, 60);
    // 10 daemons at 1000/s dwarf the root's 1/s; even heavy crash loss clears 100k
    expect(withLegacy.cycles.toNumber()).toBeGreaterThan(baseline.cycles.toNumber() + 100_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vp test run src/sim.test.ts src/persistence.test.ts`
  → FAIL: "keeps a crashed daemon down without the unlock, even with gc" (current code respawns
  with `gc = 5`), "auto-respawns once the unlock is granted", "fires the milestone…" is gated on
  Task 1 but the tick still checks `gc`, and "respawns a crashed daemon offline once the unlock
  is granted". The tiny-`dt` production test and the fold-in test are characterization guards and
  may pass immediately.

- [ ] **Step 3: Implement** in `src/sim.ts` — change the respawn condition (around line 829):

```ts
// legacy daemons: produce, occasionally crash, auto-respawn once unlocked
const mult = lineageMult(s).mul(perkMods(s).legacyRateMult);
for (const dm of s.legacy) {
  if (dm.crashed) {
    dm.respawn -= dt;
    if (dm.respawn <= 0 && hasUnlock(s, UNLOCK.legacyRespawn)) {
      dm.crashed = false;
      log(s, `${dm.name} respawned`);
    }
  } else {
    const legacyGain = dm.rate.mul(dt).mul(mult);
    s.cycles = s.cycles.add(legacyGain);
    s.totalEarned = s.totalEarned.add(legacyGain);
    if (Math.random() < 1 - Math.exp(-LEGACY_CRASH_CHANCE * dt)) {
      dm.crashed = true;
      dm.respawn = 10;
      log(s, `${dm.name} segfaulted (PID ${randPid()})`);
    }
  }
}
```

Leave `gc`'s leak-flush block and `nudgeDaemon` unchanged.

- [ ] **Step 4: Run to verify it passes** — `npx vp test run src/sim.test.ts src/persistence.test.ts`
  → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim.ts src/sim.test.ts src/persistence.test.ts
git commit -m "feat(sim): gate legacy auto-respawn on the legacy-respawn unlock (#20)"
```

---

### Task 3: Docs lockstep + ADR

**Files:**
- Modify: `docs/architecture/004-prestige-and-legacy.md`, `docs/architecture/010-milestones.md`,
  `docs/architecture/001-simulation-core.md`, `docs/architecture/003-persistence.md`
- Create: `docs/decisions/0011-decouple-auto-respawn-from-gc.md`
- Modify: `docs/decisions/README.md`

- [ ] **Step 1: `004`** — replace the Respawn bullet's `if (gc > 0)` with
  `if hasUnlock(s, "legacy-respawn")`; add an **offline role** paragraph (the legacy block runs
  before `tick`'s offline early-return, so daemons produce/crash/respawn across a gap and their
  output is folded into the offline cycles total — no separate accumulator); fix the
  "without `gc` you occasionally have to click" line to say "before the `legacy-respawn` unlock".
- [ ] **Step 2: `010`** — add the starter-set row
  `| legacy-respawn | forks | 2 | legacy-respawn |` (name "auto-respawn"); add `legacy-respawn`
  to the `UNLOCK` list; update the gating sentence to note the respawn gate.
- [ ] **Step 3: `001`** — tick step 5 becomes "auto-respawn if `hasUnlock(s, 'legacy-respawn')`";
  update the Milestones section's "`nice` and `gc` are the starter gates" to include
  `legacy-respawn`.
- [ ] **Step 4: `003`** — one line in the offline section: legacy respawn during replay is
  unlock-gated (so a pre-crashed daemon only comes back offline once `legacy-respawn` is granted).
- [ ] **Step 5: ADR `0011-decouple-auto-respawn-from-gc.md`** — Context (gc doubled as the
  respawn gate), Decision (milestone-gated respawn; `gc` is leak-flush only; `forks: 2`), the
  rejected alternatives from the spec, and Consequences (no `SAVE_VERSION` change; pre-unlock
  play needs a manual click). Register it in `docs/decisions/README.md`.
- [ ] **Step 6: Run `npm run check`** → typecheck + lint + tests all PASS.
- [ ] **Step 7: Commit**

```bash
git add docs
git commit -m "docs: legacy auto-respawn unlock, offline role, and ADR 0011 (#20)"
```

---

## Self-Review

**Spec coverage:** decisions 1–2 → Tasks 1–2; decision 3 (offline fold-in + tests) → Task 2;
decision 4 (no state change) → enforced by Global Constraints (no `SAVE_VERSION` bump); decision
5 (docs + ADR) → Task 3. Review Focus items 1–6 map to Tasks 2, 2, 1–2, 2, 2, 2.

**Type consistency:** `UNLOCK.legacyRespawn` / `"legacy-respawn"` / `hasUnlock` keep one
spelling; the milestone id and the unlock id are intentionally identical; `SAVE_VERSION = 6`
unchanged.

**Decisions pinned where the spec was silent:** the offline production test uses a tiny `dt` (the
repo's existing pattern at `sim.test.ts` line ~1275) to keep the unseeded crash roll out of the
assertion; the offline fold-in test uses many daemons and a generous lower bound so crash RNG
cannot flake it; the offline respawn test uses a single step so the respawn branch's lack of RNG
makes it deterministic.

**Known follow-ups (not this plan):** the `forks: 2` threshold is tunable data; if a future
change seeds legacy crashes, the offline contribution assertion can tighten.
