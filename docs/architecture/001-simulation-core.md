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
| `sacrificeOrder` | number[]       | Reap order: tier indices, earlier dies first.   |
| `ramCap`         | number         | RAM ceiling in MB.                              |
| `leak`           | number         | Leaked RAM on top of the footprint.             |
| `nice`           | number         | Upgrade level reducing sweep victims.           |
| `shields`        | number         | SIGTERM charges; each absorbs one sweep victim. |
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

Five child types, defined in the `TIERS` array. Each tier has its own `costGrowth`: the
cost of the next unit multiplies by that factor per purchase, so tiers have distinct cost
curves. `baseOutput` is cycles/s at lineage ×1; `priority` is only the source of the
**default** sacrifice order (`DEFAULT_SACRIFICE_ORDER`, see below) — the live sweep order is
the player-controlled `sacrificeOrder`. `trait` tags a tier's identity; `"leak-immune"`
tiers (currently only the noop loop) consume RAM but never feed the leak.

| #   | name          | baseCost | costGrowth | baseOutput | ram | priority | trait       |
| --- | ------------- | -------- | ---------- | ---------- | --- | -------- | ----------- |
| 0   | noop loop     | 10       | 1.12       | 0.1        | 1   | 0        | leak-immune |
| 1   | fork()        | 100      | 1.15       | 1          | 2   | 1        | none        |
| 2   | worker thread | 1,000    | 1.15       | 8          | 4   | 2        | none        |
| 3   | microservice  | 10,000   | 1.18       | 60         | 8   | 3        | none        |
| 4   | cron daemon   | 100,000  | 1.22       | 400        | 16  | 4        | none        |

Cost of the next unit of tier `i`: `baseCost[i] * costGrowth[i]^counts[i]`.

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

Every tick, the leak grows at `LEAK_RATE = 0.01` (1% of the _leak footprint_ per second) —
the footprint being `childRam` minus `"leak-immune"` tiers:

```
leakFootprint = Σ counts[i] * ram[i]  for tiers where trait != "leak-immune"
growth = leakFootprint * 0.01 * dt
leak  += growth
if gc > 0: leak -= growth * gc * 0.9   // clamped at 0
```

So `gc` level 1 removes 90% of new growth (net +10%); level 2+ keeps the leak near zero.
`free()` zeroes the leak outright and is free to press.

Immune tiers still consume RAM (they count in `childRam`, `ramUsed`, and spawn gating);
they simply never contribute to leak growth. So a board of noop loops leaks nothing,
while the same footprint of fork()s leaks at the usual rate.

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

## Sacrifice order

Which children die first is player-controlled. `GameState.sacrificeOrder` is a permutation
of the tier indices (default `DEFAULT_SACRIFICE_ORDER`, the tiers sorted by ascending
`TIERS.priority`); earlier entries are reaped sooner. `priorityOf`/`priorityOrder` are the
single source of truth for that rank, and `movePriority`/`sanitizeSacrificeOrder` drive edits
and load-time coercion (see [doc 003](./003-persistence.md)). `standard`, `sigkill`, and
`backpressure` honor the order; `scavenger` and `group-kill` do not. Details in
[doc 008](./008-sweep-directives.md).

## Cleanup sweep (`runSweep`)

The sweep is a roster of named **directives** (`DIRECTIVES` in `src/sim.ts`), each with its
own victim-selection rule, budget fraction (`frac`), and optional `pre` side effect. The
shared budget is `max(1, round(totalChildren * severity * frac * niceMult))`; the exact
`severity` and `sweepVictimMult` definitions live in
[doc 008](./008-sweep-directives.md).

`standard` (`frac = 1`, `nice` applies, player order) is exactly the original sweep, so the
pre-roster balance and tests carry over. Directives unlock as `sweepsSurvived` rises, are
stored in `nextDirective`, and are redrawn deterministically after every sweep. The full
roster, selection/escalation rules, and the seeded draw are in
[doc 008](./008-sweep-directives.md).

## OOM killer (`runOom`)

Fires when `ramUsed > ramCap`. Kills children from the **highest `baseOutput` tier
downward** until under the cap — i.e. it destroys your most valuable processes first. If
the leak alone is still over the cap, it is reclaimed. Then `cycles *= 0.9` and
`oomCount++`.

## Upgrade costs

| Upgrade           | Cost                       | Effect                                    |
| ----------------- | -------------------------- | ----------------------------------------- |
| `nice(+1)`        | `250 * 2.5^n`              | −3% sweep victims per level (floor 30%).  |
| `malloc(+1)`      | `150 * 1.9^((ramCap-8)/8)` | +8 MB ceiling.                            |
| `gc(+1)`          | `400 * 3^n`                | Faster automatic leak flushing.           |
| `free()`          | 0                          | Zero the leak.                            |
| `SIGTERM handler` | `500 * 2^shields`          | +1 charge; each absorbs one sweep victim. |
| `fork()`          | `1e6 * 10^forks`           | Prestige — see doc 004.                   |

## Invariants

- `sim.ts` imports nothing from the DOM or `main.ts`.
- `tick` is the only place time advances.
- All mutating actions return `boolean` (false = refused) so callers can re-render.
