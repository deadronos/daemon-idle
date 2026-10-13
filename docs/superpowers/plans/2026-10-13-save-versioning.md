# Save Versioning & Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the already-working save migration path as an explicit, ordered, tested `MIGRATIONS` table in `src/persistence.ts`, pin pre-versioning / idempotency / forward-compat behavior with tests, and bring `docs/architecture/003-persistence.md` into lockstep — **behavior-identical**, no version bump.

**Architecture:** `src/persistence.ts` owns the migration table and the `decode` loop; the additive versions 3–8 remain a documented comment block. `src/persistence.test.ts` is the sole test home (the boundary is pure and node-testable). `docs/architecture/003-persistence.md` describes the table.

**Tech Stack:** TypeScript (strict) + Vite/Vite+ (`vp`), Vitest via `vite-plus/test`, `Decimal` via `src/bignum.ts`.

**Spec:** [`docs/superpowers/specs/2026-10-13-save-versioning-design.md`](../specs/2026-10-13-save-versioning-design.md)

## Global Constraints

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` on — no dead imports.
- `SAVE_VERSION` stays `8`; **no new state field**; no `saveVersion` bump.
- `decode` must keep applying the **same** steps under the **same** `from < 2` predicate: the v2 step runs for `from ∈ {missing, 0, 1}` and never for `from ≥ 2`. This is a behavior-preserving refactor.
- Each migration is keyed to the version it upgrades **from** (`from < m.from`), never a single `from < SAVE_VERSION` check.
- Unbounded values use `Decimal` from `src/bignum.ts`; the v2 step uses `dm.rate.div(d(1 + k * 0.1))`.
- Additive versions 3–8 stay a documented comment block (no code).
- Migrations are a **code-only ordered table** — no data-driven or plugin registry.
- Run commands must not be piped; `npm run check` green.
- Do **not** assert literal top-level dropping of unknown future fields (see Review Focus 4 and the spec's open question).

## Review Focus

Failure modes the spec implies — each gets a test in its owning task:

1. **Behavior-preserving table refactor:** the `MIGRATIONS` loop replaces `if (from < 2) { … }` with identical outcomes; the existing `save versioning` tests (lines 105–138, 237+) stay green (Task 1).
2. **Ordering + shape:** `MIGRATIONS` is ascending by `from`, every `from > 1`, exactly one entry today (`from === 2`), so a future step must be added deliberately (Task 1).
3. **Idempotency:** a save already at `SAVE_VERSION` runs no migration; re-decoding its encoded form leaves rates untouched (Task 1).
4. **Pre-versioning division correctness:** both a missing `saveVersion` and `saveVersion: 1` divide the `k`-th legacy `rate` by `1 + k*0.1` (Task 1); a `saveVersion: 99` save does **not** (Task 2).
5. **Forward-compat:** a future-version save loads best-effort (known fields preserved), runs no migration, drops unknown **roster ids**, and is stamped **down** to `SAVE_VERSION` (Task 2).
6. **Sparse pre-versioning save:** many missing fields still load to a playable, finite state (Task 2).
7. **Shape drift:** a short `counts` array pads to `TIERS.length` zeros (Task 2; existing coverage at `src/persistence.test.ts:491`).
8. **Docs lockstep:** `003-persistence.md` describes the table, the pre-versioning path, and forward-compat; the non-goal is reworded to "code-only ordered table" (Task 3).

---

### Task 1: `MIGRATIONS` table refactor + ordering / pre-versioning / idempotency tests

**Files:**
- Modify: `src/persistence.ts`
- Test: `src/persistence.test.ts`

**Interfaces:**
- Produces: `export interface Migration { from: number; describe: string; apply(s: GameState): void }`; `export const MIGRATIONS: Migration[]` (one entry, `from: 2`).
- Consumes: `GameState` (type, already imported), `d` / `Decimal` (already imported).

- [ ] **Step 1: Write the failing tests**

Add `MIGRATIONS` to the `./persistence` import list and append these blocks to
`src/persistence.test.ts` (the existing `save versioning` tests stay):

```ts
describe("MIGRATIONS table", () => {
  it("is ordered by ascending from, each from > 1, and has one entry today", () => {
    const froms = MIGRATIONS.map((m) => m.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
    for (const m of MIGRATIONS) expect(m.from).toBeGreaterThan(1);
    expect(MIGRATIONS).toHaveLength(1);
    expect(MIGRATIONS[0].from).toBe(2);
    expect(typeof MIGRATIONS[0].apply).toBe("function");
  });
});

describe("save versioning — explicit table", () => {
  it("runs the v2 migration for a saveVersion 1 save", () => {
    const raw = JSON.stringify({
      saveVersion: 1,
      legacy: [
        { name: "legacy-1", rate: "22", crashed: false, respawn: 0 },
        { name: "legacy-2", rate: "33", crashed: false, respawn: 0 },
      ],
    });
    const s = decode(raw);
    expect(s.saveVersion).toBe(SAVE_VERSION);
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(22, 5);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33 / 1.1, 5);
  });

  it("is idempotent: decoding a SAVE_VERSION save twice leaves rates untouched", () => {
    const g = newGame();
    g.legacy = [
      { name: "legacy-1", rate: d(22), crashed: false, respawn: 0 },
      { name: "legacy-2", rate: d(33), crashed: false, respawn: 0 },
    ];
    const once = decode(encode(g));
    const twice = decode(encode(once));
    expect(once.legacy[1].rate.toNumber()).toBeCloseTo(33, 5);
    expect(twice.legacy[1].rate.toNumber()).toBeCloseTo(33, 5);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
  `npx vp test run src/persistence.test.ts > /tmp/persist-25.log 2>&1; echo exit=$?`
  → FAIL: `MIGRATIONS` is not exported.

- [ ] **Step 3: Implement** in `src/persistence.ts`, directly above `decode`:

```ts
/**
 * Ordered, code-only migration steps. Each entry upgrades saves whose `saveVersion` is
 * strictly older than `from` (keyed to the version it upgrades *from*, so a newer save
 * never re-runs an older step). Add a new entry with the next `from` and bump
 * `SAVE_VERSION`; additive versions need no entry.
 */
export interface Migration {
  from: number;
  describe: string;
  apply(s: GameState): void;
}

export const MIGRATIONS: Migration[] = [
  {
    from: 2,
    describe: "divide the lineage baked into pre-v2 legacy rates",
    apply: (s) => {
      s.legacy.forEach((dm, k) => {
        dm.rate = dm.rate.div(d(1 + k * 0.1));
      });
    },
  },
];
```

Then in `decode`, replace the `if (from < 2) { … }` block with the loop (keep the surrounding
comment and the additive 3–8 comment block, updated to mention the table):

```ts
const from = coerceFinite(parsed.saveVersion, 0);
// Staged migrations, each keyed to the version it upgrades *from* (never a single
// `saveVersion < SAVE_VERSION` check, which would re-run older steps on newer saves).
for (const m of MIGRATIONS) if (from < m.from) m.apply(s);
// from < 3: the lineage/perk fields and the milestone records are additive only —
// newGame() defaults already filled them and the rosters rebuild them.
// from < 4: `buyMax` is additive too — newGame() defaults it to false.
// from < 5: the automation toggles + `freeThreshold` are additive as well.
// from < 6: `offlineCap` is additive too — newGame() defaults it to 0.
// from < 7: `achievementsDone` is additive too — newGame() defaults it to {} and the
// roster rebuilds it in `sanitizeAchievements`.
// from < 8: `repeatables` is additive too — newGame() defaults it to {} and the roster
// rebuilds it in `sanitizeRepeatables`; short `counts` arrays pad the new tiers with 0
// in `sanitizeCounts`.
s.saveVersion = SAVE_VERSION;
```

- [ ] **Step 4: Run to verify it passes** —
  `npx vp test run src/persistence.test.ts > /tmp/persist-25.log 2>&1; echo exit=$?`
  → PASS (the pre-existing `save versioning` and per-version tests must stay green — they are the
  behavior-preservation guard).

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "refactor(persistence): explicit ordered MIGRATIONS table (#25)"
```

---

### Task 2: Forward-compat + sparse-save + shape-drift characterization tests

**Files:**
- Test: `src/persistence.test.ts` (no production change expected)

**Interfaces:**
- Consumes: `MIGRATIONS` and the refactored `decode` (Task 1); `SAVE_VERSION`, `newGame` from `./sim`.

> These are **characterization/guard** tests for behavior the spec promises. They are expected to
> pass against Task 1's code. If any fails, that is a real bug — **stop and report it** rather
> than weakening the assertion.

- [ ] **Step 1: Write the tests**

```ts
describe("forward compatibility", () => {
  it("loads a future-version save best-effort, runs no migration, and stamps down", () => {
    const raw = JSON.stringify({
      saveVersion: 99,
      counts: [1, 2, 3],
      cycles: "500",
      legacy: [
        { name: "legacy-1", rate: "22", crashed: false, respawn: 0 },
        { name: "legacy-2", rate: "33", crashed: false, respawn: 0 },
      ],
      milestonesDone: { "first-blood": true, ghost: true },
    });
    const s = decode(raw);
    expect(s.saveVersion).toBe(SAVE_VERSION);
    expect(s.cycles.toNumber()).toBe(500);
    expect(s.counts).toEqual([1, 2, 3, 0, 0, 0, 0]);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33, 5); // no v2 division
    expect(s.milestonesDone).toEqual({ "first-blood": true }); // unknown roster id dropped
  });
});

describe("pre-versioning saves with missing fields", () => {
  it("loads a sparse pre-versioning save to a playable, finite state", () => {
    const s = decode('{"cycles":"123","legacy":[{"name":"legacy-1","rate":"22"}]}');
    expect(s.saveVersion).toBe(SAVE_VERSION);
    const required = [
      s.ramCap,
      s.leak,
      s.heat,
      s.sweepInterval,
      s.sweepTimer,
      s.playtime,
      s.lastSave,
      ...s.counts,
    ];
    for (const n of required) expect(Number.isFinite(n)).toBe(true);
    expect(s.counts).toHaveLength(7); // TIERS.length
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(22, 5);
    expect(s.perks).toEqual({});
    expect(s.repeatables).toEqual({});
    expect(s.unlocks).toEqual({});
  });
});

describe("counts shape drift", () => {
  it("pads a short counts array to TIERS.length zeros", () => {
    const s = decode('{"saveVersion":7,"counts":[1,2,3]}');
    expect(s.counts).toHaveLength(7);
    expect(s.counts).toEqual([1, 2, 3, 0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run** —
  `npx vp test run src/persistence.test.ts > /tmp/persist-25.log 2>&1; echo exit=$?`
  → PASS. If red, stop and report the failure (do not edit production code to force green without
  re-checking the spec).

- [ ] **Step 3: Commit**

```bash
git add src/persistence.test.ts
git commit -m "test(persistence): forward-compat, sparse-save, and counts shape drift (#25)"
```

---

### Task 3: Docs lockstep — `003-persistence.md`

**Files:**
- Modify: `docs/architecture/003-persistence.md`

- [ ] **Step 1: Save versioning section.** State that `decode()` iterates the explicit, ordered
  `MIGRATIONS` table of `{ from, describe, apply }` entries in `src/persistence.ts`, mirroring the
  doc's existing table, instead of inline `if` blocks. Keep the table and the "Why v2"–"Why v8"
  paragraphs.
- [ ] **Step 2: Load step 3.** Reword "runs a **staged** chain — one step per version it upgrades
  *from* (`if (from < 2) …`, `if (from < 3) …`, with `from = coerceFinite(parsed.saveVersion, 0)`)" to
  the `MIGRATIONS` loop (`for (const m of MIGRATIONS) if (from < m.from) m.apply(s)`), keeping the
  "staged steps matter" rationale.
- [ ] **Step 3: Pre-versioning path.** Document that a save with a missing `saveVersion` (coerced
  to `0`) or `saveVersion: 1` runs the v2 step — dividing the `k`-th legacy `rate` by
  `1 + k*0.1` — and is stamped to `SAVE_VERSION`; all other fields come from `newGame()` defaults
  and sanitizers.
- [ ] **Step 4: Forward-compat.** Document that a save with a **future** `saveVersion` runs no
  migration, loads best-effort (known fields preserved, unknown roster ids dropped by the
  sanitizers), and is stamped **down** to `SAVE_VERSION`.
- [ ] **Step 5: Known limitations.** Change "Migrations are code-only (see [Save
  versioning](#save-versioning)); there is no data-driven or plugin migration registry." to
  "Migrations are a code-only ordered table (`MIGRATIONS` in `src/persistence.ts`); there is no
  data-driven or plugin migration registry."
- [ ] **Step 6: Closing line.** Change "The chain is append-only: to migrate further, add the next
  `if (from < N)` step and bump `SAVE_VERSION`." to "The table is append-only: to migrate further,
  add the next `MIGRATIONS` entry (with a strictly greater `from`) and bump `SAVE_VERSION`."
- [ ] **Step 7: Run `npm run check`** —
  `npm run check > /tmp/check-25.log 2>&1; echo exit=$?`
  → typecheck + lint + tests all PASS.

- [ ] **Step 8: Commit**

```bash
git add docs/architecture/003-persistence.md
git commit -m "docs: explicit MIGRATIONS table and forward-compat in 003 (#25)"
```

---

## Self-Review

**Spec coverage:** decisions 1–3 (table + loop + behavior-identical) → Task 1; decision 4 (tests) →
Tasks 1–2; decision 5 (docs) → Task 3. Review Focus 1–3 → Task 1; 4 → Tasks 1–2; 5–7 → Task 2;
8 → Task 3.

**Type consistency:** `Migration`/`MIGRATIONS` are defined once in `src/persistence.ts` and
imported by the test; `from`/`describe`/`apply` are spelled identically in the spec, the plan, and
the doc; `SAVE_VERSION = 8` is unchanged and asserted by existing tests.

**Behavior-preservation argument:** the loop applies exactly the one entry under the same
`from < 2` predicate the inline block used; versions 3–8 remain comment-only; the stamp and all
sanitizers are untouched. The existing `save versioning` tests (lines 105–138, 237+) are the
regression guard.

**Decisions pinned where the spec was silent:** the table-shape test pins "exactly one entry
today" so a future migration is a deliberate edit; the forward-compat test asserts the true, safe
subset (known fields preserved, no migration, stamped down, unknown roster ids dropped) and
deliberately does **not** assert literal top-level dropping of unknown fields.

**Known follow-ups (not this plan):** literal top-level unknown-field dropping would require a
whitelist in `decode` — a behavior change outside this issue's "behavior must be identical" ruling
(raised as an open question in the spec). No ADR is added: this formalizes existing behavior.
