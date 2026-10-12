# Offline Progress Rework — Design

- **Issue:** #24 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design) — pending implementation
- **Depends on:** Phase A + Phase B (#22/#17/#18/#19) — stacked on `feat/phase-b`

## Context

`applyOffline(s, seconds)` (`src/persistence.ts`) replays the elapsed gap as flat 1-second
`tick` calls, capped at `OFFLINE_CAP_S = 8h`. The `{ offline: true }` flag makes those ticks
**skip the cleanup sweep and the OOM killer** — a deliberate Phase A rule ("idling is never
punished"), plus a leak clamp so a long absence can't grow an unbounded leak.

#24 asks for three things: an **upgradable cap**, **event-aware** resolution (sweeps and legacy
crashes settled rather than ignored), and totals that **match an equivalent online run within a
stated tolerance**. The last is incompatible with the current policy — an online run *is* swept
and *can* OOM — so #24 deliberately reverses "idling is never punished".

## Goals

- Make offline **faithful**: run the same `tick` (sweeps, OOM, milestones included) as online,
  so the total matches within tolerance.
- Make the offline cap **upgradable** with cycles (a new `nohup` upgrade).
- Keep the offline replay bounded (a step budget) and the save additive.

## Non-goals

- A discrete-event / analytic offline model (see Alternatives) — the faithful replay is exact
  by construction and fast enough at realistic caps.
- Changing the *online* tick or any sweep/OOM rule.
- Auto-* / buy-max behavior differences offline (they simply run, as online).

## Decisions (from the design dialogue)

1. **Offline is faithful** — same events as online, match within tolerance. Reverses Phase A's
   "idling is never punished".
2. **Upgradable cap** via a new cycles-cost `nohup` upgrade (base 8 h, +4 h/level).
3. **Faithful replay** (1-second steps of the normal `tick`), not discrete-event stepping.
4. **Tolerance ~2%** for the equivalence test (unseeded legacy-crash timing + directive RNG).

## Design

### The `nohup` upgrade

```
BASE_OFFLINE_CAP_S = 8 * 3600      // 8 h, unchanged
OFFLINE_CAP_STEP   = 4 * 3600      // +4 h per level
offlineCapS(s)     = BASE_OFFLINE_CAP_S + s.offlineCap * OFFLINE_CAP_STEP
offlineCost(s)     = 1e7 * 5^s.offlineCap
buyOfflineCap(s)   = spend cycles, s.offlineCap++, log; false if unaffordable
```

Ungated (spend cycles to bank idle time), like `malloc`/`gc`/`cooling`. A persisted
`offlineCap` level (default `0`) backs it; `decode` coerces it with `coerceCount`;
`SAVE_VERSION` bumps (5 → 6 on this stack) with an additive staged no-op.

UI: an upgrade button — `nohup(+4h)  ·  cap 12h` — using the existing `addUpgrade` pattern.

### Faithful replay

`applyOffline(s, seconds)`:

```
let remaining = Math.min(seconds, offlineCapS(s));
let budget = OFFLINE_MAX_STEPS;                 // safety valve, e.g. 200_000
while (remaining > 0 && budget-- > 0) {
  const dt = Math.min(1, remaining);
  tick(s, dt);                                  // no `offline` flag — events run
  remaining -= dt;
}
log(s, `offline ${fmtTime(seconds)}: +${fmt(...)} cycles`);
```

And `tick` loses its offline-specific branches:

- the `if (opts.offline) return;` early-return (sweeps, OOM, **and milestones** now run),
- the offline leak clamp (`s.leak = min(s.leak, ramCapTotal(s))`) — unnecessary once OOM runs,
- the `TickOptions` parameter and `{ offline: true }` call sites.

**This reverses Phase A's "idling is never punished."** An idle board can now be swept and
OOM'd, which is what makes the offline total match online; the `nohup` cap is how the player
buys tolerance for long absences. It is recorded as **ADR 0010**, and every test/doc that
asserted the old policy is updated:

- Phase A's "does not reap the process table while offline" test (now asserts reaping *can*
  happen);
- #17's "does not fire milestones during an offline tick" (now asserts they *do*);
- #19's "does not run on offline ticks" (automation now runs offline too, since it lives in the
  shared tick body), and the "live-only" wording in docs `001`/`002`.

`OFFLINE_MIN_S = 5` (skip tiny gaps) is unchanged. The step budget bounds the loop for an
extreme cap; if it is ever hit, the replay stops early (a rare, safe degradation).

### Equivalence test

From two identical states, run `N` seconds **online** (a `tick` loop) and **offline**
(`applyOffline(s2, N)`), then assert `totalEarned` differs by ≤ ~2%. A no-legacy board should
match near-exactly (income, sweeps, and directive draws are deterministic given `rngState`);
a board with legacy daemons is the tolerance case (unseeded `Math.random` crash timing). `N`
must exceed the 60 s sweep interval so sweeps are exercised.

## Testing

- `offlineCapS` / `offlineCost` / `buyOfflineCap`: cap grows by `OFFLINE_CAP_STEP` per level;
  the action refuses when unaffordable and increments otherwise.
- **Equivalence:** online vs offline `totalEarned` within ~2% for a board with children, a
  legacy daemon, and sweeps; near-exact for a no-legacy board.
- **Faithful events:** an offline replay of > `sweepInterval` seconds advances `sweepsSurvived`
  (sweeps run); a board over its RAM cap during the gap can OOM (the killer runs).
- **Cap:** `applyOffline` never simulates more than `offlineCapS(s)` seconds.
- **Policy update:** replace the offline tests noted above (Phase A reap, #17 milestones, #19
  automation) with assertions of the new faithful behavior.
- Persistence: `offlineCap` round-trips and coerces; a pre-version save loads with `0`.

## Docs impact (lockstep)

- `docs/architecture/003-persistence.md` — the rework, the cap, the step budget, and the policy
  reversal.
- `docs/architecture/001-simulation-core.md` — the `nohup` upgrade row, the `offlineCap` state
  row, removing the offline special-case from the tick description, and correcting the
  automation "live-only" wording.
- `docs/architecture/002-render-system.md` — the `nohup` button.
- **ADR** `docs/decisions/0010-offline-fidelity.md` — records the reversal of "idling is never
  punished" and the rejected alternatives.
- `npm run check` green; a browser screenshot reporting the button and the cap.

## Risks / open questions

- **Policy reversal.** Making offline punishing is a real gameplay change; if playtesting shows
  it is too harsh, soften it (a grace period, or reduced offline severity) rather than reverting
  the whole rework.
- **Cost/tuning.** `1e7 · 5^n` and `+4h/level` are first-pass; both are data.
- **Perf.** A large cap replays many 1-second steps; the step budget is the guard. If caps grow
  very large, revisit with a discrete-event model.
- **RNG divergence.** The tolerance exists because legacy crashes use unseeded `Math.random`; a
  future change that seeds them would tighten it.

## Alternatives considered

- **Keep "idling is never punished"; test against a sweep-free online run** — rejected: does not
  satisfy the issue's "matches an equivalent online run" for the default online path.
- **Hybrid: sweeps offline but softened** — rejected: "within tolerance" implies faithfulness,
  not a different rule; a softened sweep would diverge by design.
- **Discrete-event stepping** — rejected: heat's continuous effect on income (`heatMult`) cannot
  be jumped without integrating it, so it risks drifting from online — the opposite of the goal.
- **Adaptive step to the next event (≤1 s)** — rejected: faster, but still needs the heat
  integration to stay faithful, for no real gain at realistic caps.
- **Piggyback the cap on `gc`/`cooling`** — rejected: couples unrelated concerns.
