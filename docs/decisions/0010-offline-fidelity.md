# 0010 — Offline fidelity and the upgradable cap

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Phase A made offline progress deliberately kind: `applyOffline` replays the gap as 1-second
`tick(s, dt, { offline: true })` calls that **skip the cleanup sweep and the OOM killer**, so
"idling is never punished". The cap was a fixed `OFFLINE_CAP_S = 8h`.

#24 asks for an **upgradable cap**, **event-aware** resolution, and totals that **match an
equivalent online run within a stated tolerance**. The last point is in tension with the Phase
A rule: a fully faithful offline would sweep and OOM, which is exactly what "idling is never
punished" forbids.

## Decision

Keep offline **non-punishing** and deliver the cap plus a verified equivalence guarantee:

- **Upgradable cap.** A new cycles-cost `nohup` upgrade raises `offlineCapS(s) =
  BASE_OFFLINE_CAP_S + s.offlineCap * OFFLINE_CAP_STEP` (8 h base, +4 h per level, `1e7 · 5ⁿ`).
  A step budget (`OFFLINE_MAX_STEPS`) bounds the replay loop.
- **Non-punishing retained.** Offline still skips sweeps and OOM; milestones and automation
  stay live-only; legacy daemons still produce, crash, and respawn across the gap. The `tick`
  offline branch is unchanged.
- **Equivalence against a sweep-free online reference.** The replay is proven to match an
  online run in the *safe regime* — no sweep fires and RAM stays under the cap, which is
  exactly the regime offline promises. It is equal (no legacy) or within ~2% (legacy crash
  timing is unseeded). This is the deliberate interpretation of "matches an equivalent online
  run": the reference is an online run with the punishing events excluded.

## Alternatives considered

- **Make offline faithful / punishing** (sweeps + OOM during a gap) — rejected: it reverses
  Phase A's "idling is never punished" and is too harsh for idle play. (The design dialogue
  initially chose this and reversed.)
- **Hybrid: sweeps offline but softened, or grace-bounded** — rejected for now: more tuning and
  a different rule to test; the kind-to-idle policy stays simple.
- **Discrete-event stepping** — rejected: heat's continuous effect on income (`heatMult`)
  cannot be jumped without integrating it, so it risks drifting from the safe-regime reference.
- **Piggyback the cap on `gc`/`cooling`** — rejected: couples unrelated concerns.

## Consequences

- **Positive:** players spend cycles to bank idle time; the offline total is provably faithful
  in the regime offline promises; the save change is additive (`SAVE_VERSION` 5 → 6, a no-op
  step).
- **Negative:** offline is not fully faithful by design — a gap cannot reap your board, so a
  long absence is never a real threat. This is intentional and recorded here; revisit only if
  the policy changes.
- **Follow-ups:** `1e7 · 5ⁿ` and `+4h/level` are first-pass data; a very large cap could want a
  discrete-event model.

See [`docs/architecture/003-persistence.md`](../architecture/003-persistence.md) for the current
contract.
