# Legacy Auto-Respawn Unlock and Offline Role — Design

- **Issue:** #20 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design) — pending implementation
- **Depends on:** B1 (#17 milestones), B8 (#24 offline) — stacked on `feat/phase-b`

## Context

Legacy daemons (doc [004](../architecture/004-prestige-and-legacy.md)) are the active-play hook
of the meta-layer. Each fork leaves one behind; it produces until it crashes
(`LEGACY_CRASH_CHANCE = 0.002`/s), then sits down for `respawn = 10`s. Today the respawn is
gated by `s.gc > 0` — the **leak-flush upgrade** accidentally doubles as the respawn gate.
`nudgeDaemon` (click the crashed row) is the pre-`gc` manual hook.

The offline path (`tick(s, dt, { offline: true })`) runs the legacy block **before** its early
return, so legacy daemons already produce, crash, and (when `gc > 0`) respawn across an offline
gap. That behavior is real but undocumented and untested.

#20 asks to (a) promote auto-respawn into an **explicit, goal-gated unlock** and (b) give
legacy daemons a **documented offline role** with tests.

## Goals

- Gate auto-respawn on a new milestone `legacy-respawn` (metric `forks`, `at: 2`), not on `gc`.
- Keep `gc` as the leak-flush upgrade only — a clean decoupling of two unrelated concerns.
- Keep `nudgeDaemon` as the pre-unlock manual hook.
- Document that offline legacy output is folded into the offline cycles total (no separate
  accumulator), and add tests proving offline legacy contribution.
- Keep the save additive: no new persistent field, `SAVE_VERSION` stays 6.

## Non-goals

- A separate offline accumulator or a distinct offline legacy rate.
- Re-gating `gc`, the leak model, or any sweep/OOM rule.
- Changing the offline replay policy (non-punishing, per ADR 0010).
- Migrating saves — `unlocks` already persist.

## Decisions (from the design dialogue)

1. **New milestone `legacy-respawn`:** id `legacy-respawn`, name `"auto-respawn"`, desc
   `"fork twice"`, metric `forks`, `at: 2`, `unlocks: ["legacy-respawn"]`. Add
   `UNLOCK.legacyRespawn = "legacy-respawn"`.
2. **The unlock is the sole respawn gate.** Change the `tick` condition from `s.gc > 0` to
   `hasUnlock(s, UNLOCK.legacyRespawn)`. `gc` no longer drives respawn. Two forks is the
   threshold because one fork's worth of legacy daemon is what `nudgeDaemon` already covers by
   hand.
3. **Offline role: fold-in, no accumulator.** Legacy daemons already run in the offline block
   (before `if (opts.offline) return;`). Do **not** add a separate offline accumulator; document
   that offline legacy output is counted in the offline cycles total, and prove it with tests.
   Update the #24 tolerance test that relied on `gc = 5` to grant the unlock instead.
4. **No persistent-state change.** Unlocks are already persisted and sanitized
   (`sanitizeUnlocks`); `SAVE_VERSION` stays 6 with no new migration step.
5. **Docs lockstep.** Update `004` (respawn gate + offline role), `010` (new milestone row +
   unlock), `001` (tick step 5 + starter-gate sentence), and a one-line note in `003` (offline
   respawn is unlock-gated). Add ADR `0011` recording the decoupling and register it.

## Design

### The milestone and unlock

In `src/config/milestones.ts`, append to `MILESTONES`:

```ts
{
  id: "legacy-respawn",
  name: "auto-respawn",
  desc: "fork twice",
  metric: "forks",
  at: 2,
  unlocks: ["legacy-respawn"],
}
```

and add `legacyRespawn: "legacy-respawn"` to `UNLOCK`. `forks` is already a `MetricId`, so no
new metric reader is needed; the existing `evaluateMilestones` fires it once `forks >= 2` on
the next live tick (milestones are live-only — doc [010](../architecture/010-milestones.md)).

### The respawn gate (`src/sim.ts` `tick`)

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
    /* produce + crash roll — unchanged */
  }
}
```

`gc` keeps its existing role one block above (the leak flush); `nudgeDaemon` is unchanged and
remains the manual restart for a crashed row before the unlock.

### Offline role

The legacy block sits at the top of `tick`, **before** `if (opts.offline) return;` — so an
offline replay already runs produce/crash/respawn for every daemon, and the produced cycles
flow into `s.cycles` / `s.totalEarned` like any other income. There is no separate offline
total; `applyOffline`'s log line (`offline <t>: +<n> cycles`) already includes legacy output.
This change does not alter that path — it only makes the gate `hasUnlock` instead of `gc`, so a
pre-crashed daemon respawns offline **only** once the unlock is granted.

## Testing

- **Milestone:** `legacy-respawn` exists, is `forks >= 2`, and grants `UNLOCK.legacyRespawn`.
- **Live gating:** a crashed daemon with `respawn <= 0` does **not** respawn without the unlock
  (even with `gc > 0`), and **does** respawn with it. `nudgeDaemon` still restarts it pre-unlock.
- **Milestone integration:** two forks fire `legacy-respawn` on the next live tick and grant the
  unlock.
- **Offline contribution (deterministic):** a tiny-`dt` offline `tick` with a legacy daemon adds
  its rate to `cycles` (the legacy block runs before the offline early-return).
- **Offline respawn:** a pre-crashed daemon with `respawn: 1` respawns during `applyOffline` when
  the unlock is granted (deterministic — the respawn branch has no `Math.random`).
- **Offline fold-in:** `applyOffline` with many legacy daemons earns far more than the same gap
  with none — the output is in the cycles total.
- **Existing test updated:** the #24 tolerance test's `s.gc = 5` is **kept** (its leak-flush
  keeps the online arm from OOMing over 3600 s) **and** the `legacy-respawn` unlock is added —
  both arms carry the same `gc` + unlock, so crashes stay transient and the test still measures
  offline-vs-online equivalence. (Replacing `gc` outright caused ~933% divergence.)

## Docs impact (lockstep)

- `docs/architecture/004-prestige-and-legacy.md` — respawn is gated by `legacy-respawn`; add the
  offline-role paragraph; fix the "without `gc`" line.
- `docs/architecture/010-milestones.md` — the new starter-set row, the `UNLOCK` list, and the
  gating sentence.
- `docs/architecture/001-simulation-core.md` — tick step 5 (`hasUnlock(...)` instead of `gc > 0`)
  and the "starter gates" sentence in the Milestones section.
- `docs/architecture/003-persistence.md` — note the offline replay's respawn is unlock-gated.
- **ADR** `docs/decisions/0011-decouple-auto-respawn-from-gc.md` — records the decoupling;
  register it in `docs/decisions/README.md`.
- `npm run check` green; no `SAVE_VERSION` change.

## Risks / open questions

- **Threshold tuning.** `forks: 2` is a first-pass gate; it is data and can move without code.
- **Offline crash RNG.** Legacy crash timing is unseeded, so the offline contribution test
  asserts a robust lower bound (many daemons) plus a deterministic tiny-`dt` case rather than an
  exact total.
- **Player-facing pacing.** Before the unlock, a crashed daemon needs a manual click; after it,
  legacy daemons are fully hands-off. That is the intended curve (doc 004).

## Alternatives considered

- **Keep `gc` as the respawn gate and add a milestone that just enables it.** Rejected: couples
  the leak-flush upgrade to legacy respawn and leaves the actual gate unexplained.
- **A separate offline accumulator for legacy output.** Rejected: legacy income is already folded
  into the offline cycles total before the early-return; a second total is redundant and risks
  double-counting.
- **Gate respawn at `forks: 1`.** Rejected: one daemon is exactly what `nudgeDaemon` handles by
  hand; the unlock should mark the transition to hands-off legacy play.
- **A new persistent `respawnUnlocked` boolean.** Rejected: `unlocks` already persists and is
  sanitized; a new field would force a `SAVE_VERSION` bump for no benefit.
