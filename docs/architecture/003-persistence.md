# 003 — Persistence

How progress survives a reload or a closed tab. The pure boundary — `encode`, `decode`,
`applyOffline`, and the offline constants — lives in `src/persistence.ts` (DOM-free, so it
is unit-testable in node). `src/main.ts` keeps only the `localStorage` plumbing: `SAVE_KEY`,
`save()`, and a thin `load()` wrapper.

## Storage

- **Key:** `daemon-idle-save-v1` in `localStorage`.
- **Value:** the whole `GameState`, JSON-encoded by `encode()`. `Decimal` fields
  (`cycles`, `totalEarned`, and each legacy `rate`) are serialized as strings; `decode()`
  coerces them back with `d(...)`. Older saves that stored raw numbers still load.
- Bump the key's suffix (`-v2`, …) only if the shape changes incompatibly; prefer the
  additive guards below so existing saves keep working. For _field semantics_ that change
  meaning (not just shape), bump `GameState.saveVersion` and migrate in `decode` instead
  (see [Save versioning](#save-versioning)).

## When it saves

| Trigger            | Cadence                                           |
| ------------------ | ------------------------------------------------- |
| Autosave           | every `AUTOSAVE_MS = 10_000` ms in the frame loop |
| `beforeunload`     | on tab close / reload                             |
| `visibilitychange` | when the tab is hidden                            |

Every save stamps `state.lastSave = Date.now()` first.

## Load

`main.ts:load()` reads `localStorage` and delegates to `persistence.loadFrom(raw, Date.now())`:

1. No saved value → `newGame()`.
2. Parse and shallow-merge over `newGame()`: `{ ...newGame(), ...parsed }`. Missing fields
   are therefore filled with fresh defaults — additive state changes are safe. A non-object
   JSON value (`null`, `42`, `"x"`, `true`) is treated as `{}`, so it decodes to a fresh
   game instead of throwing.
3. **Version migration:** `decode()` runs a **staged** chain — one step per version it
   upgrades *from* (`if (from < 2) …`, `if (from < 3) …`, with
   `from = parsed.saveVersion | 0`) — then stamps `saveVersion = SAVE_VERSION`. Staged steps
   matter: a single `saveVersion < SAVE_VERSION` check would re-run older steps on newer saves
   (see [Save versioning](#save-versioning)).
4. **Coercion (harden):** `decode()` sanitizes every field before it reaches the sim:
   - `cycles` / `totalEarned` / `runBaseEarned` / each legacy `rate` → `coerceDecimal` (finite
     number, numeric string, or `Decimal`; else the fallback). `d("abc")` is lenient and
     yields `0`; `NaN`/`Infinity` coerce to the fallback.
   - `counts` → `sanitizeCounts`: one `coerceCount` per tier (capped at
     `MAX_SANE_COUNT = 1_000_000`), a non-array becomes zeros.
   - `legacy` → `sanitizeLegacy`: non-object entries are dropped; `name` defaults to
     `"legacy"`, `rate`/`respawn` coerced.
   - `perks` → `sanitizePerks`: for each `PERKS` entry, clamp the level to `[0, maxLevel]` and
     drop zeros; unknown ids never survive because the result is rebuilt from the roster.
   - `lineage` → `coerceCount`.
   - `log` → mapped to strings if it is an array, else `[]`.
   - `sacrificeOrder` → `sanitizeSacrificeOrder` (valid permutation, else the default).
5. **Numeric clamps (`sanitizeNumericState`):** every bounded field is made finite and
   in range.

   | field                                                   | clamp                                     |
   | ------------------------------------------------------- | ----------------------------------------- |
   | `ramCap`                                                | `max(BASE.ramCap, …)`                     |
   | `leak`                                                  | `max(0, …)`                               |
   | `heat`                                                  | `[0, 100]`                                |
   | `cooling`, `nice`, `shields`, `gc`, `forks`, `oomCount` | `coerceCount` (non-negative integer)      |
   | `sweepsSurvived`                                        | `coerceCount`, capped at `MAX_SANE_COUNT` |
   | `playtime`                                              | `max(0, …)`                               |
   | `sweepInterval`                                         | `max(1, …)` — kills the `render()` ÷0     |
   | `sweepTimer`                                            | `[0, sweepInterval]`                      |
   | `rngState`                                              | `(finite \| 0) \|\| 1` (nonzero int32)    |
   | `ramWarned`                                             | `Boolean(…)`                              |
   | `lastSave`                                              | finite, else `Date.now()`                 |
   | `lineage`                                               | `coerceCount`                             |
   | `runStartPlaytime`                                      | `max(0, …)`                               |
   | `counts[i]`                                             | `coerceCount`, capped at `MAX_SANE_COUNT` |

6. If more than `OFFLINE_MIN_S = 5` seconds elapsed since `lastSave`, apply offline
   progress (capped at `OFFLINE_CAP_S`), then **stamp `lastSave = now`** so a crash before
   the next save cannot re-apply the same window.
7. Any parse error → `newGame()` (fail closed to a clean game, never a crash).

## Save versioning

`GameState.saveVersion` records the semantics of the persisted fields; `newGame()` stamps
it at `SAVE_VERSION = 3`. `encode()` spreads the field, so it round-trips. On load,
`decode()` reads the parsed value into `from` and runs each staged migration whose `from`
is older, before the numeric clamps.

| from              | to  | migration                                                                    |
| ----------------- | --- | ---------------------------------------------------------------------------- |
| (missing) / `< 2` | 2   | For each legacy daemon at array index `k`, divide its `rate` by `1 + k*0.1`. |
| `< 3`             | 3   | Additive only: the new fields come from `newGame()` defaults; no-op.         |

**Why v2:** the old `doFork` snapshotted a new daemon's rate from `rawCyclesPerSec`, which
already included the lineage multiplier `1 + forks*0.1` — so the `k`-th daemon's rate had
`1 + k*0.1` baked in. `tick` now applies lineage once more, double-counting it. v2 stores
lineage-free rates; the migration divides the baked factor back out of pre-v2 saves so
their legacy income matches a fresh fork's.

**Why v3:** the perk tree added `lineage`, `perks`, `runBaseEarned`, and `runStartPlaytime`.
The change is additive — `decode` merges the save over `newGame()` defaults and then coerces
the fields — so the v3 step is a no-op placeholder. It exists to keep the chain staged: had
the v2 step stayed keyed to `from < SAVE_VERSION`, bumping to 3 would have re-divided already
lineage-free legacy rates on every v2 save. A test pins both directions.

The chain is append-only: to migrate further, add the next `if (from < N)` step and bump
`SAVE_VERSION`.

## Offline progress

`applyOffline(s, seconds)` simulates the gap in **1-second steps** by calling
`tick(s, dt, { offline: true })`, capped at `OFFLINE_CAP_S = 8 * 3600` (8 hours). It logs
the elapsed time and the cycles gained.

The `offline` flag is the whole policy: offline ticks accrue income (heat-throttled), heat,
leak + `gc` drain, and legacy crashes, but skip the cleanup sweep and the memory-pressure
latch + OOM killer (tick-order steps 6–8, see [doc 001](./001-simulation-core.md)). So
idling is never punished — the process table is never reaped and RAM pressure never fires —
and, because `heatMult ≥ 0.5` and the root always produces, cycles are strictly monotonic.

Because the offline path skips the OOM killer, it also **clamps the leak to `ramCapTotal`**
after the leak/`gc` step (`s.leak = Math.min(s.leak, ramCapTotal(s))`). Without that bound,
hours away with `gc = 0` would grow the leak without limit and the first live tick would
immediately OOM the board — contradicting "idling is never punished". The clamp means a
returning player is at worst at the RAM ceiling, never arbitrarily past it.

`loadFrom` computes the elapsed window from `lastSave`, calls `applyOffline` when the gap
exceeds `OFFLINE_MIN_S`, and then sets `s.lastSave = now`. That stamp is what makes the
catch-up idempotent: re-loading the same save before a new one is written sees an elapsed
gap of `0`, so the same offline window is never applied twice. To make that hold across a
hard kill, `main.ts` persists the stamp **immediately** after `load()` — before the first
autosave — so the on-disk stamp can never be left stale.

## Why the guards matter

Saves are user-local and long-lived. A new field, a reordered tier list, a removed upgrade,
or a hand-edited value must never brick an existing save. Add fields with sane defaults in
`newGame()` and let the merge fill them in; `decode()` then coerces every field to a finite,
in-range value so a corrupt save can never divide by zero, soft-lock the OOM killer, or feed
`NaN` into income.

## Known limitations

- No export/import. Migrations are code-only (see [Save versioning](#save-versioning));
  there is no data-driven or plugin migration registry.
- `localStorage` can throw (private mode, quota); `save()` swallows the error.
