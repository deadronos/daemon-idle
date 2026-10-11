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
  additive guards below so existing saves keep working.

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
   are therefore filled with fresh defaults — additive state changes are safe.
3. **Coercion (harden):** `decode()` sanitizes every field before it reaches the sim:
   - `cycles` / `totalEarned` / each legacy `rate` → `coerceDecimal` (finite number,
     numeric string, or `Decimal`; else the fallback). `d("abc")` is lenient and yields
     `0`; `NaN`/`Infinity` coerce to the fallback.
   - `counts` → `sanitizeCounts`: one `coerceCount` per tier (capped at
     `MAX_SANE_COUNT = 1_000_000`), a non-array becomes zeros.
   - `legacy` → `sanitizeLegacy`: non-object entries are dropped; `name` defaults to
     `"legacy"`, `rate`/`respawn` coerced.
   - `log` → mapped to strings if it is an array, else `[]`.
   - `sacrificeOrder` → `sanitizeSacrificeOrder` (valid permutation, else the default).
4. **Numeric clamps (`sanitizeNumericState`):** every bounded field is made finite and
   in range.

   | field | clamp |
   | --- | --- |
   | `ramCap` | `max(BASE.ramCap, …)` |
   | `leak` | `max(0, …)` |
   | `heat` | `[0, 100]` |
   | `cooling`, `nice`, `shields`, `gc`, `forks`, `sweepsSurvived`, `oomCount` | `coerceCount` (non-negative integer) |
   | `playtime` | `max(0, …)` |
   | `sweepInterval` | `max(1, …)` — kills the `render()` ÷0 |
   | `sweepTimer` | `[0, sweepInterval]` |
   | `rngState` | `(finite \| 0) \|\| 1` (nonzero int32) |
   | `ramWarned` | `Boolean(…)` |
   | `lastSave` | finite, else `Date.now()` |
   | `counts[i]` | `coerceCount`, capped at `MAX_SANE_COUNT` |

5. If more than `OFFLINE_MIN_S = 5` seconds elapsed since `lastSave`, apply offline
   progress (capped at `OFFLINE_CAP_S`).
6. Any parse error → `newGame()` (fail closed to a clean game, never a crash).

## Offline progress

`applyOffline(s, seconds)` simulates the gap by calling `tick(s, dt)` in **1-second
steps**, capped at `OFFLINE_CAP_S = 8 * 3600` (8 hours). It logs the elapsed time and the
cycles gained. `loadFrom` computes the elapsed window from `lastSave` and calls it when the
gap exceeds `OFFLINE_MIN_S`. Because it reuses `tick`, offline behaves exactly like live
play (sweeps, leak, legacy crashes included).

## Why the guards matter

Saves are user-local and long-lived. A new field, a reordered tier list, a removed upgrade,
or a hand-edited value must never brick an existing save. Add fields with sane defaults in
`newGame()` and let the merge fill them in; `decode()` then coerces every field to a finite,
in-range value so a corrupt save can never divide by zero, soft-lock the OOM killer, or feed
`NaN` into income.

## Known limitations

- No export/import, no versioned migration beyond the additive merge.
- `localStorage` can throw (private mode, quota); `save()` swallows the error.
