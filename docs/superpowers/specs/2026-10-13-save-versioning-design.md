# Save Versioning & Migrations — Design

- **Issue:** #25 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design rulings) — pending implementation
- **Depends on:** Phase A + B state changes (the staged chain already runs at `SAVE_VERSION = 8`)
- **Branch:** `feat/25-save-versioning` (off `feat/phase-b`)

## Context

Saves merge over `newGame()` defaults (`{ ...newGame(), ...parsed }`), so **additive** state
changes are already safe: a missing field is filled with a fresh default. `decode()` in
`src/persistence.ts` additionally coerces every field to a finite, in-range value and rebuilds
roster-backed records from their rosters, so shape drift (a short `counts` array, stale ids,
hand-edited junk) never bricks a save.

Phases A/B added many fields, so a real migration path now exists — and most of #25 is **already
done incrementally**:

- `SAVE_VERSION = 8` in `src/sim.ts` (doc comment enumerates v2–v8).
- A staged `if (from < N)` chain in `decode`, keyed to the version it upgrades **from**, with one
  real step (`from < 2`: divide the lineage baked into pre-v2 legacy rates) and documented
  additive no-op placeholders for 3–8.
- `sanitizeCounts` padding a short/non-array `counts` to `TIERS.length`.
- Tests in `src/persistence.test.ts` (the `save versioning` block around lines 105–138 and the
  per-version tests at 237+).
- `docs/architecture/003-persistence.md` already carries a migration table and "Why vN" paragraphs.

#25 is therefore a **formalization + verification** task, not a rewrite: turn the implicit
`if (from < 2)` chain into an explicit, ordered, testable artifact and pin the surrounding
behavior (ordering, idempotency, pre-versioning division, forward compatibility) with tests and
docs.

## Goals

- Make the migration list an **explicit, ordered, testable artifact** (`MIGRATIONS`) rather than
  inline `if` blocks.
- Preserve the additive-default behavior for additive changes (no new code needed for 3–8).
- Guard shape drift as `decode` already does (roster rebuilds, `sanitizeCounts`).
- Pin acceptance with tests: pre-versioning saves load cleanly; a save carries a version;
  migrations are explicit and tested.
- Keep behavior **identical** — this is a table refactor, not a semantics change.

## Non-goals

- No new state field and no `SAVE_VERSION` bump (stays `8`).
- No data-driven / plugin migration registry (migrations remain a code-only table).
- No change to the coercion/sanitization behavior or the `localStorage` key.
- No literal whitelisting of arbitrary top-level fields (see Risks / open questions).

## Decisions (binding)

1. **Explicit ordered table.** In `src/persistence.ts` add:

   ```ts
   export interface Migration { from: number; describe: string; apply(s: GameState): void }
   export const MIGRATIONS: Migration[] = [ /* ordered by ascending `from` */ ];
   ```

   with exactly one real entry today:

   ```ts
   {
     from: 2,
     describe: "divide the lineage baked into pre-v2 legacy rates",
     apply: (s) => {
       s.legacy.forEach((dm, k) => { dm.rate = dm.rate.div(d(1 + k * 0.1)); });
     },
   }
   ```

2. **`decode` iterates the table.** Replace the inline `if (from < 2) { … }` block with:

   ```ts
   for (const m of MIGRATIONS) if (from < m.from) m.apply(s);
   ```

   Versions 3–8 stay a documented comment block (they need no code). `from` remains
   `coerceFinite(parsed.saveVersion, 0)`.

3. **Behavior is identical.** For any save, the set of applied steps is unchanged:
   `from ∈ {missing, 0, 1}` applies the v2 division; `from ≥ 2` applies nothing; the stamp
   `s.saveVersion = SAVE_VERSION` is unchanged.

4. **Tests are the acceptance's "explicit and tested"** (see Testing): table shape/order,
   pre-versioning division by index `k`, idempotency at `SAVE_VERSION`, forward compatibility,
   a many-fields-missing pre-versioning save, and the `counts` shape-drift pad.

5. **Docs lockstep (`003-persistence.md` only).** Describe the explicit `MIGRATIONS` table (it
   mirrors the doc's existing table), the pre-versioning path, and forward-compat; adjust the
   "no data-driven or plugin migration registry" limitation to say migrations are a **code-only
   ordered table**. No new ADR: this formalizes existing behavior without changing a decision.

## Design

### The artifact (`src/persistence.ts`)

`GameState` is already imported as a type, and `d`/`Decimal` are already imported, so the table
needs no new imports. The table is the single source of truth for "what migrates"; the doc's
table mirrors it, and a test pins ordering so a future step must be added deliberately.

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

### `decode` wiring

```ts
const from = coerceFinite(parsed.saveVersion, 0);
// Staged migrations, each keyed to the version it upgrades *from* (never a single
// `saveVersion < SAVE_VERSION` check, which would re-run older steps on newer saves).
for (const m of MIGRATIONS) if (from < m.from) m.apply(s);
// from < 3: lineage/perk fields + milestone records are additive — newGame() defaults and
// the rosters rebuild them.
// from < 4: `buyMax` is additive too — newGame() defaults it to false.
// from < 5: automation toggles + `freeThreshold` are additive as well.
// from < 6: `offlineCap` is additive too — newGame() defaults it to 0.
// from < 7: `achievementsDone` is additive too — rebuilt from the roster.
// from < 8: `repeatables` is additive too — rebuilt from the roster; short `counts` arrays
// pad the new tiers with 0 in `sanitizeCounts`.
s.saveVersion = SAVE_VERSION;
```

### Forward compatibility

A save with a **future** `saveVersion` (e.g. `99`) has `from ≥ 2`, so **no migration runs**; the
merge fills any fields this build lacks with defaults, the sanitizers drop unknown roster ids,
and `s.saveVersion` is stamped **down** to `SAVE_VERSION`. Loading is best-effort: known fields
are preserved and the game is playable.

Note on "unknown dropped": `decode` does not whitelist top-level keys, so an arbitrary unknown
top-level field from a future save survives the `{ ...newGame(), ...parsed }` merge and is
re-encoded (verified: `{"saveVersion":99,"ghostField":42}` round-trips `ghostField`). What *is*
dropped is unknown ids inside roster-backed records (`perks`, `milestonesDone`,
`achievementsDone`, `repeatables`, `unlocks`) and invalid `legacy` entries, because those are
rebuilt from rosters. See Risks / open questions.

### Pre-versioning path

`saveVersion` is absent (`coerceFinite(undefined, 0) → 0`) or `1`; both are `< 2`, so the v2
step runs and divides the `k`-th legacy `rate` by `1 + k*0.1`. All other fields come from
`newGame()` defaults and sanitizers, so the result is a playable state.

## Testing

Owning task in parentheses. Commands must not be piped.

- **Table shape/order** (Task 1): `MIGRATIONS` is ordered by ascending `from`, every `from > 1`,
  and has exactly one entry today with `from === 2` (so a future migration must be added
  deliberately).
- **Pre-versioning division** (Task 1): both a save with no `saveVersion` and a `saveVersion: 1`
  save divide the `k`-th legacy `rate` by `1 + k*0.1` and are stamped to `SAVE_VERSION`.
- **Idempotency** (Task 1): a save already at `SAVE_VERSION` runs no migration (rates untouched),
  including on repeated `decode` of the re-encoded result.
- **Forward-compat** (Task 2): a `saveVersion: 99` save loads best-effort (known fields
  preserved), runs no migration (rates untouched), drops unknown roster ids, and is stamped down
  to `SAVE_VERSION`.
- **Sparse pre-versioning save** (Task 2): a save with many missing fields loads to a playable
  state — every required field present and finite.
- **Shape drift** (Task 2): a short `counts` array pads to `TIERS.length` zeros (existing test at
  `src/persistence.test.ts:491` covers the 5-element case; add an explicit length assertion).

## Docs impact (lockstep)

- `docs/architecture/003-persistence.md`:
  - The **Save versioning** section: state that `decode()` iterates the explicit, ordered
    `MIGRATIONS` table (`{ from, describe, apply }`), mirroring the doc's existing table, instead
    of inline `if` blocks; keep the table and "Why vN" paragraphs.
  - The **Load** step 3: reword "staged chain (`if (from < 2) …`)" to the `MIGRATIONS` loop.
  - Document the **pre-versioning path** (missing / `1` → v2 division) and **forward-compat**
    (future version → no migration, best-effort load, stamped down).
  - **Known limitations**: change "Migrations are code-only; there is no data-driven or plugin
    migration registry" to "Migrations are a code-only ordered table (`MIGRATIONS` in
    `src/persistence.ts`); there is no data-driven or plugin migration registry."
  - Closing line: "to migrate further, add the next `MIGRATIONS` entry and bump `SAVE_VERSION`."
- No ADR: the staged-chain decision is already documented and this change preserves it.

## Risks / open questions

- **"Unknown dropped" is only true inside roster-backed records.** `decode` shallow-merges over
  defaults without whitelisting, so an arbitrary unknown top-level field from a future save is
  preserved (and re-encoded) rather than dropped. The forward-compat test should assert the
  true, safe subset (known fields preserved, no migration, stamped down, unknown *roster ids*
  dropped) and must **not** assert literal top-level dropping — doing so would fail, and adding a
  whitelist would be a behavior change beyond this issue's "behavior must be identical" ruling.
  This is flagged as unresolved (see the final reply).
- **No behavioral regression.** The refactor is behavior-preserving by construction: the loop
  applies the same single step under the same `from < 2` predicate. The existing
  `save versioning` tests (lines 105–138, 237+) are the regression guard and must stay green.
- **Ordering discipline.** Because each entry is keyed to `from`, adding a step out of order
  would still work for any single save (the predicate is per-entry), but the ordered-table
  invariant and test keep intent explicit; a new entry must use a strictly greater `from`.

## Alternatives considered

- **Leave the inline `if (from < 2)` chain as-is.** Rejected: the acceptance asks for explicit,
  tested migrations; a table makes the set of steps introspectable and ordering testable.
- **One `if (from < SAVE_VERSION)` block.** Rejected (already documented): it re-runs older steps
  on newer saves, re-dividing already lineage-free rates.
- **Bump `SAVE_VERSION` / add a field.** Rejected: this issue changes no state and no semantics.
- **Data-driven migration registry.** Rejected: no persistence-format use case justifies it;
  migrations are code-only.
- **Whitelist top-level fields to literally drop unknown ones.** Rejected for now: it is a
  behavior change beyond the "behavior must be identical" ruling; raised as an open question.
