# 0011 — Decouple legacy auto-respawn from `gc`

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Legacy daemons (doc [004](../architecture/004-prestige-and-legacy.md)) crash on a
`LEGACY_CRASH_CHANCE = 0.002`/s roll and sit down for `respawn = 10`s. Since Phase A the
auto-respawn was gated by `s.gc > 0` — the leak-flush upgrade accidentally doubled as the
respawn gate. `nudgeDaemon` (clicking the crashed row) was the only manual hook.

The leak-flush role of `gc` and the legacy-respawn role are unrelated concerns that happened
to share a flag. #20 asks to promote auto-respawn into an explicit, goal-gated unlock so the
gate is discoverable and tunable as data.

## Decision

Gate legacy auto-respawn on a new milestone, not on `gc`:

- **Milestone `legacy-respawn`** — name `"auto-respawn"`, desc `"fork twice"`, metric `forks`,
  `at: 2`, `unlocks: ["legacy-respawn"]`; `UNLOCK.legacyRespawn = "legacy-respawn"`.
- **The unlock is the sole respawn gate.** `tick` respawns a crashed daemon when
  `dm.respawn <= 0 && hasUnlock(s, UNLOCK.legacyRespawn)`. `gc` keeps only its leak-flush role.
- **Two forks is the threshold.** One fork's worth of legacy daemon is exactly what
  `nudgeDaemon` already covers by hand; the unlock marks the transition to hands-off legacy
  play.
- **Offline role unchanged.** The legacy block already runs before `tick`'s offline
  early-return, so offline legacy output is folded into the offline cycles total (no separate
  accumulator). Respawn there is unlock-gated too.

## Alternatives considered

- **Keep `gc` as the respawn gate and add a milestone that just enables it** — rejected:
  couples the leak-flush upgrade to legacy respawn and leaves the actual gate unexplained.
- **A separate offline accumulator for legacy output** — rejected: legacy income is already
  folded into the offline cycles total before the early-return; a second total is redundant
  and risks double-counting.
- **Gate respawn at `forks: 1`** — rejected: one daemon is exactly what `nudgeDaemon` handles
  by hand.
- **A new persistent `respawnUnlocked` boolean** — rejected: `unlocks` already persists and is
  sanitized, so a new field would force a `SAVE_VERSION` bump for no benefit.

## Consequences

- **Positive:** the respawn gate is explicit, data-tunable (`forks: 2`), and documented; `gc`
  is a single-purpose upgrade again. No save change — `unlocks` already persists, so
  `SAVE_VERSION` stays 6 with no migration step.
- **Negative:** before the unlock, a crashed daemon needs a manual click; a player who had
  `gc` but no second fork loses the automatic restart they previously got. That is the
  intended curve (doc 004).
- **Follow-ups:** the `forks: 2` threshold is first-pass data; if legacy crashes ever become
  seeded, the offline contribution test can tighten its bound.

See [`docs/architecture/004-prestige-and-legacy.md`](../architecture/004-prestige-and-legacy.md)
for the current contract.
