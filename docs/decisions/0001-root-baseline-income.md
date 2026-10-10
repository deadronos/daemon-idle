# 0001 — Root baseline income for bootstrap

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

A fresh game started with `cycles = 0` and no children. The cheapest child (`noop loop`)
costs 10, and income came only from children. With zero children, income was `0/s`, so a
new player could never afford the first purchase — the game was unwinnable from a fresh
save. A playtest confirmed it: a page left running for 176 seconds held at 0 cycles, 0
cycles/s, 0 children. This only went unnoticed earlier because test saves had currency
injected.

An idle game needs a working opening curve: the player must be able to make the first
purchase from a standing start.

## Decision

The root process itself yields a baseline **1 cycle/s**, defined as
`BASE.rootOutput = 1` in `src/sim.ts` and included in `cyclesPerSec` before the lineage
multiplier:

```
cyclesPerSec = (childOutput + BASE.rootOutput) * lineageMult
```

So a fresh player reaches 10 cycles in 10 seconds and can buy the first `noop loop`, after
which the normal exponential curve takes over. The baseline scales with lineage like all
other income.

## Alternatives considered

- **Grant one free `noop loop` at game start** — works, but leaves income at exactly 0
  until that child exists, and makes the first action implicit rather than earned.
- **Start with a small cycle bank (e.g. 25)** — one-time; if the player spends it badly the
  game can still stall with no income, so it does not guarantee recovery.
- **Do nothing** — rejected; the game is unplayable.

The baseline income was chosen because it is thematic (the process is alive and ticking
regardless), guarantees the opening always progresses, and needs no special-case code.

## Consequences

- **Positive:** a fresh game always bootstraps; the opening curve works; no special-case
  spawn logic; it also lifts very early prestige slightly (the fork-time peak now includes
  the baseline).
- **Negative:** adds a small constant to all income, so displayed early numbers start at 1
  rather than 0; balance tuning must remember the floor exists (e.g. sweep timing at 10
  cycles/child-cost interacts with it).
- **Follow-ups:** none required. If early pacing feels too fast or slow, tune
  `BASE.rootOutput` — that is a balance change, not a new decision.
