# 001 — Simulation Core (`src/sim.ts`)

The rules of the game. Pure state plus functions; no DOM, no timers. Everything here is
deterministic given a `GameState` and a `dt` (except the legacy-daemon crash roll and PID
cosmetics, which use `Math.random`).

## State — `GameState`

| Field            | Type           | Meaning                                         |
| ---------------- | -------------- | ----------------------------------------------- |
| `cycles`         | Decimal        | Current spendable currency.                     |
| `totalEarned`    | Decimal        | Lifetime earned; gates prestige.                |
| `counts`         | number[]       | Owned children per tier (index = tier).         |
| `ramCap`         | number         | RAM ceiling in MB.                              |
| `leak`           | number         | Leaked RAM on top of the footprint.             |
| `nice`           | number         | Upgrade level reducing sweep victims.           |
| `gc`             | number         | Upgrade level of automatic leak flushing.       |
| `forks`          | number         | Prestige count; drives the lineage multiplier.  |
| `sweepTimer`     | number         | Seconds until the next cleanup sweep.           |
| `sweepInterval`  | number         | Seconds between sweeps.                         |
| `sweepsSurvived` | number         | Sweeps run so far; raises severity.             |
| `rngState`       | number         | Int32 PRNG cursor for the directive draw.       |
| `nextDirective`  | DirectiveId    | Directive resolved at the next sweep.           |
| `oomCount`       | number         | Times the OOM killer has fired.                 |
| `ramWarned`      | boolean        | Latches the ≥90% memory-pressure warning.       |
| `legacy`         | LegacyDaemon[] | Background producers left by forks.             |
| `log`            | string[]       | Terminal feed, newest first, capped at 40.      |
| `playtime`       | number         | Seconds simulated (includes offline).           |
| `lastSave`       | number         | Epoch ms of last save; drives offline progress. |

`newGame()` returns a fresh state with one child-tier array of zeros and the log seeded
with a boot line. `BASE` holds the tunable constants shared across the file.

### Numeric types

Unbounded values (`cycles`, `totalEarned`, tier/upgrade costs, child output, legacy rates,
the lineage multiplier) are `Decimal` from `src/bignum.ts`. Bounded values (`counts`,
`ramCap`, `leak`, `nice`, `gc`, timers, `playtime`) stay plain `number`. See
[ADR 0003](../decisions/0003-bignum-break-eternity.md).

## Tiers

Five child types, defined in the `TIERS` array. `cost` grows per purchase by
`COST_GROWTH = 1.15`; `baseOutput` is cycles/s at lineage ×1; `priority` decides sweep
order (lower dies first).

| #   | name          | baseCost | baseOutput | ram | priority |
| --- | ------------- | -------- | ---------- | --- | -------- |
| 0   | noop loop     | 10       | 0.1        | 1   | 0        |
| 1   | fork()        | 100      | 1          | 2   | 1        |
| 2   | worker thread | 1,000    | 8          | 4   | 2        |
| 3   | microservice  | 10,000   | 60         | 8   | 3        |
| 4   | cron daemon   | 100,000  | 400        | 16  | 4        |

Cost of the next unit of tier `i`: `baseCost[i] * 1.15^counts[i]`.

## Income

```
cyclesPerSec = (childOutput + BASE.rootOutput) * lineageMult
childOutput  = Σ counts[i] * baseOutput[i]
```

- `BASE.rootOutput = 1` — the root process itself yields 1 cycle/s. **This is the
  bootstrap:** without it a fresh game earns nothing and can never afford the first child.
- `lineageMult = 1 + forks * 0.1` multiplies _all_ income (children, root, legacy).

## RAM

```
childRam = Σ counts[i] * ram[i]
ramUsed  = childRam + leak
```

A spawn is allowed only if `cycles >= cost` **and** `ramUsed + ram[i] <= ramCap`.
`malloc(+1)` raises `ramCap` by `MALLOC_STEP = 8`.

## The leak

Every tick, the leak grows at `LEAK_RATE = 0.01` (1% of the _footprint_ per second):

```
growth = childRam * 0.01 * dt
leak  += growth
if gc > 0: leak -= growth * gc * 0.9   // clamped at 0
```

So `gc` level 1 removes 90% of new growth (net +10%); level 2+ keeps the leak near zero.
`free()` zeroes the leak outright and is free to press.

## Tick order (`tick(s, dt)`)

Order matters — later steps observe the effects of earlier ones.

1. `playtime += dt`.
2. Accrue income: `cycles` and `totalEarned` += `cyclesPerSec * dt`.
3. Grow the leak; apply `gc` flushing.
4. Run legacy daemons (produce, roll for crash, auto-respawn if `gc > 0`).
5. Decrement `sweepTimer`; when ≤ 0, run a sweep (resolve the stored `nextDirective`,
   then redraw it from the unlocked pool) and reset the timer.
6. Memory-pressure check: if `ramUsed > 0.9 * ramCap` and not already warned, log once;
   clear the latch below `0.8 * ramCap`.
7. If `ramUsed > ramCap`, run the OOM killer.

## Cleanup sweep (`runSweep`)

The sweep is a roster of named **directives** (`DIRECTIVES` in `src/sim.ts`), each with its
own victim-selection rule, budget fraction, and optional side effect. Severity and `nice`
are unchanged from the original model:

```
severity        = min(0.35, 0.15 + sweepsSurvived * 0.002)
sweepVictimMult = max(0.3, 1 - nice * 0.03)   // nice cuts victims, floored at 30%
budget          = max(1, round(totalChildren * severity * frac * niceMult))
niceMult        = ignoresNice ? 1 : sweepVictimMult
```

`standard` (`frac = 1`, `nice` applies, lowest-`priority` first) is exactly the original
sweep, so current balance and tests carry over unchanged.

| id             | `unlockAt` | budget (`frac`) | victim selection                      | `nice` applies | `pre`         |
| -------------- | ---------- | --------------- | ------------------------------------- | -------------- | ------------- |
| `standard`     | 0          | `1`             | lowest `priority` first               | yes            | —             |
| `sigkill`      | 3          | `1`             | lowest `priority` first               | **no**         | —             |
| `scavenger`    | 6          | `0.6`           | highest `baseOutput` first            | yes            | —             |
| `group-kill`   | 10         | `1`             | densest tier first, then next-densest | yes            | —             |
| `backpressure` | 15         | `0.5`           | lowest `priority` first               | yes            | zero the leak |

- Every directive selects through the shared `reapInOrder(s, order, budget)` helper, which
  takes up to `budget` from the ordering and never more than are owned. `standard`,
  `sigkill`, and `backpressure` use ascending `priority`; `scavenger` uses descending
  `baseOutput`; `group-kill` sorts by `counts` descending (ties keep the lower tier index).
- `backpressure.pre` sets `s.leak = 0` before selection, so the leak is reclaimed on every
  `backpressure` sweep.

### Selection and escalation

- The unlocked pool is `DIRECTIVES.filter(d => d.unlockAt <= s.sweepsSurvived)`; thresholds
  are inclusive, so `sigkill` unlocks at exactly 3 sweeps survived.
- `runSweep` resolves the stored `s.nextDirective` (falling back to `standard` for an
  unknown loaded id), applies it, increments `s.sweepsSurvived`, then **always** redraws
  `s.nextDirective` from the pool based on the new count — even when there was nothing to
  reap.
- The draw is seeded: `nextRng(s)` advances the int32 `s.rngState` with a mulberry32-style
  step and returns a float in `[0, 1)`; the pick is
  `choices[floor(nextRng(s) * choices.length)]`, where `choices` is the unlocked pool minus
  the just-fired directive when more than one is unlocked, so there are no back-to-back
  repeats. `newGame()` seeds `rngState` from `Date.now() | 0` (falling back to `1`) and
  starts `nextDirective` at `standard`.
- Nothing owned → log "nothing to reap"; the sweep is still counted and the directive is
  still redrawn.

## OOM killer (`runOom`)

Fires when `ramUsed > ramCap`. Kills children from the **highest `baseOutput` tier
downward** until under the cap — i.e. it destroys your most valuable processes first. If
the leak alone is still over the cap, it is reclaimed. Then `cycles *= 0.9` and
`oomCount++`.

## Upgrade costs

| Upgrade      | Cost                       | Effect                                   |
| ------------ | -------------------------- | ---------------------------------------- |
| `nice(+1)`   | `250 * 2.5^n`              | −3% sweep victims per level (floor 30%). |
| `malloc(+1)` | `150 * 1.9^((ramCap-8)/8)` | +8 MB ceiling.                           |
| `gc(+1)`     | `400 * 3^n`                | Faster automatic leak flushing.          |
| `free()`     | 0                          | Zero the leak.                           |
| `fork()`     | `1e6 * 10^forks`           | Prestige — see doc 004.                  |

## Invariants

- `sim.ts` imports nothing from the DOM or `main.ts`.
- `tick` is the only place time advances.
- All mutating actions return `boolean` (false = refused) so callers can re-render.
