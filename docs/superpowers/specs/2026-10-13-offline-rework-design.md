# Offline Progress Rework — Design

- **Issue:** #24 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design) — pending implementation
- **Depends on:** Phase A + Phase B (#22/#17/#18/#19) — stacked on `feat/phase-b`

## Context

`applyOffline(s, seconds)` (`src/persistence.ts`) replays the elapsed gap as flat 1-second
`tick` calls, capped at `OFFLINE_CAP_S = 8h`. The `{ offline: true }` flag makes those ticks
**skip the cleanup sweep and the OOM killer** (and, since Phase B, milestones and automation
are live-only) — the deliberate Phase A rule **"idling is never punished"**.

#24 asks for an **upgradable cap**, **event-aware** resolution, and totals that **match an
equivalent online run within a stated tolerance**. We keep the kind-to-idle policy and deliver
the cap plus a verified equivalence guarantee; the equivalence is measured against an online
run **in the safe regime** (see Decisions).

## Goals

- Make the offline cap **upgradable** with cycles (a new `nohup` upgrade).
- Keep offline **non-punishing**: it never sweeps or OOMs; automation and milestones stay
  live-only; legacy daemons still produce, crash, and respawn across the gap.
- Prove the offline replay matches a **sweep-free online run** within tolerance.
- Keep the offline replay bounded and the save additive.

## Non-goals

- Making offline punishing (sweeps/OOM during a gap) — explicitly rejected (see Decisions).
- A discrete-event / analytic offline model.
- Changing the online tick or any sweep/OOM rule.

## Decisions (from the design dialogue)

1. **Offline stays non-punishing** — Phase A's "idling is never punished" is retained. Offline
   skips sweeps and OOM; milestones and automation stay live-only. (The issue's "matches an
   equivalent online run" is therefore satisfied against a **sweep-free online reference**; this
   is a deliberate, documented deviation from the literal acceptance, to keep idle play kind.)
2. **Upgradable cap** via a new cycles-cost `nohup` upgrade (base 8 h, +4 h/level).
3. **Replay model unchanged** — 1-second steps of `tick(s, dt, { offline: true })`, with a step
   budget as a safety valve. The existing `offline` semantics are the contract; this change adds
   the cap and the equivalence proof rather than reworking the replay.
4. **Tolerance ~2%** for the equivalence test (unseeded legacy-crash timing + directive RNG).

## Design

### The `nohup` upgrade

```
BASE_OFFLINE_CAP_S = 8 * 3600      // 8 h, the current OFFLINE_CAP_S
OFFLINE_CAP_STEP   = 4 * 3600      // +4 h per level
offlineCapS(s)     = BASE_OFFLINE_CAP_S + s.offlineCap * OFFLINE_CAP_STEP
offlineCost(s)     = 1e7 * 5^s.offlineCap
buyOfflineCap(s)   = spend cycles, s.offlineCap++, log; false if unaffordable
```

Ungated (spend cycles to bank idle time), like `malloc`/`gc`/`cooling`. A persisted
`offlineCap` level (default `0`) backs it; `decode` coerces it with `coerceCount`;
`SAVE_VERSION` bumps (5 → 6 on this stack) with an additive staged no-op.

UI: an upgrade button — `nohup(+4h)  ·  cap 12h` — using the existing `addUpgrade` pattern.

### Offline replay (unchanged policy, new cap)

`applyOffline(s, seconds)` keeps calling `tick(s, dt, { offline: true })` but bounds the gap by
the **upgraded** cap and adds a step budget:

```
let remaining = Math.min(seconds, offlineCapS(s));
let budget = OFFLINE_MAX_STEPS;                 // safety valve, e.g. 200_000
while (remaining > 0 && budget-- > 0) {
  const dt = Math.min(1, remaining);
  tick(s, dt, { offline: true });               // no sweep / OOM / milestones / automation
  remaining -= dt;
}
log(s, `offline ${fmtTime(seconds)}: +${fmt(...)} cycles`);
```

`OFFLINE_MIN_S = 5` (skip tiny gaps) is unchanged. Nothing about `tick`'s offline branch
changes: no sweep, no OOM, the leak clamp stays, and milestones/automation remain live-only
(the Phase B behavior is preserved). The step budget bounds the loop for an extreme cap; if it
is hit, the replay stops early (a rare, safe degradation).

### Equivalence guarantee

The replay matches an online run **in the safe regime** — no sweep fires and RAM stays under the
cap, which is exactly the regime offline promises. Concretely:

- **Deterministic match:** with no legacy daemons and `N < sweepInterval` (so no sweep
  interrupts) and RAM under cap, an online `tick` loop and `applyOffline` produce the same
  `totalEarned` (income, heat integration, and leak/`gc` are the same code; the `offline` branch
  only skips events, none of which fire).
- **Tolerance case:** with a legacy daemon (unseeded `Math.random` crashes), the two match
  within **~2%** over the same span.

This is the documented sense in which #24 "matches an equivalent online run": against an online
run with the punishing events excluded — the reference the non-punishing policy is defined
against.

## Testing

- `offlineCapS` / `offlineCost` / `buyOfflineCap`: the cap grows by `OFFLINE_CAP_STEP` per level;
  the action refuses when unaffordable and increments otherwise.
- **Equivalence (deterministic):** online loop vs `applyOffline` over `N < sweepInterval`, no
  legacy, RAM under cap → equal `totalEarned`.
- **Equivalence (tolerance):** with a legacy daemon → within ~2%.
- **Non-punishing retained:** an offline replay of `> sweepInterval` seconds does **not** advance
  `sweepsSurvived` and never OOMs; milestones/automation do not fire/buy offline (the existing
  Phase A / #17 / #19 tests stay green).
- **Cap:** `applyOffline(s, hugeSeconds)` never simulates more than `offlineCapS(s)` seconds
  (assert `playtime` grows by ≤ the cap).
- Persistence: `offlineCap` round-trips and coerces; a pre-version save loads with `0`.

## Docs impact (lockstep)

- `docs/architecture/003-persistence.md` — the cap, `offlineCapS`, the step budget, and the
  equivalence guarantee.
- `docs/architecture/001-simulation-core.md` — the `nohup` upgrade row and the `offlineCap`
  state row.
- `docs/architecture/002-render-system.md` — the `nohup` button.
- **ADR** `docs/decisions/0010-offline-fidelity.md` — records keeping the non-punishing policy
  and measuring equivalence against a sweep-free online reference (the deliberate deviation from
  the issue's literal wording).
- `npm run check` green; a browser screenshot reporting the button and the cap.

## Risks / open questions

- **Acceptance deviation.** We satisfy "matches an equivalent online run" against a sweep-free
  reference, not a fully faithful one. Recorded in ADR 0010; revisit only if the policy changes.
- **Cost/tuning.** `1e7 · 5^n` and `+4h/level` are first-pass; both are data.
- **Perf.** A large cap replays many 1-second steps; the step budget is the guard. If caps grow
  very large, revisit with a discrete-event model.
- **RNG divergence.** The tolerance exists because legacy crashes use unseeded `Math.random`; a
  future change that seeds them would tighten it.

## Alternatives considered

- **Make offline faithful / punishing** (sweeps + OOM during a gap) — rejected: reverses Phase A's
  "idling is never punished"; too harsh for idle play (the dialogue reversed this).
- **Hybrid: sweeps offline but softened, or grace-bounded** — rejected for now: more tuning and a
  different rule to test; the kind-to-idle policy stays simple.
- **Discrete-event stepping** — rejected: heat's continuous effect on income cannot be jumped
  without integrating it, so it risks drifting from the (safe-regime) online reference.
- **Piggyback the cap on `gc`/`cooling`** — rejected: couples unrelated concerns.
