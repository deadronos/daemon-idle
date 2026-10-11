# 003 — Persistence

How progress survives a reload or a closed tab. All of it lives in `src/main.ts`.

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

`load()`:

1. No saved value → `newGame()`.
2. Parse and shallow-merge over `newGame()`: `{ ...newGame(), ...parsed }`. Missing fields
   are therefore filled with fresh defaults — additive state changes are safe.
3. **Shape guards:** if `counts` is not an array of `TIERS.length`, reset it; coerce
   `legacy` and `log` to arrays if missing; coerce `sacrificeOrder` to a valid
   permutation of tier indices via `sanitizeSacrificeOrder`, else the default.
4. If more than 5 seconds elapsed since `lastSave`, apply offline progress.
5. Any parse error → `newGame()` (fail closed to a clean game, never a crash).

## Offline progress

`applyOffline(s, seconds)` simulates the gap by calling `tick(s, dt)` in **1-second
steps**, capped at `OFFLINE_CAP_S = 8 * 3600` (8 hours). It logs the elapsed time and the
cycles gained. Because it reuses `tick`, offline behaves exactly like live play (sweeps,
leak, legacy crashes included).

## Why the guards matter

Saves are user-local and long-lived. A new field, a reordered tier list, or a removed
upgrade must never brick an existing save. Add fields with sane defaults in `newGame()`
and let the merge fill them in; only reset arrays that must match a known length.

## Known limitations

- No export/import, no versioned migration beyond the additive merge.
- `localStorage` can throw (private mode, quota); `save()` swallows the error.
