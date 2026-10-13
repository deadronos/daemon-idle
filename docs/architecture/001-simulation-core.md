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
| `heat`           | number         | 0..100; throttles income above the threshold.   |
| `cooling`        | number         | Upgrade level; sheds heat faster, lower eq.     |
| `nice`           | number         | Upgrade level reducing sweep victims.           |
| `shields`        | number         | SIGTERM charges; each absorbs one sweep victim. |
| `gc`             | number         | Upgrade level of automatic leak flushing.       |
| `forks`          | number         | Prestige count; drives the lineage multiplier.  |
| `lineage`        | number         | Unspent lineage points for the perk tree.        |
| `perks`          | Record<PerkId, number> | Purchased perk level per node id (absent = 0). |
| `runBaseEarned`  | Decimal        | `totalEarned` at the last fork (depth base).     |
| `runStartPlaytime` | number       | `playtime` at the last fork (depth base).        |
| `sweepTimer`     | number         | Seconds until the next cleanup sweep.           |
| `sweepInterval`  | number         | Seconds between sweeps; derived each tick.      |
| `sweepsSurvived` | number         | Sweeps run so far; raises severity.             |
| `rngState`       | number         | Int32 PRNG cursor for the directive draw.       |
| `nextDirective`  | DirectiveId    | Directive resolved at the next sweep.           |
| `oomCount`       | number         | Times the OOM killer has fired.                 |
| `ramWarned`      | boolean        | Latches the ≥90% memory-pressure warning.       |
| `legacy`         | LegacyDaemon[] | Background producers left by forks.             |
| `milestonesDone` | Record<MilestoneId, true> | Milestones that have fired (sticky).  |
| `achievementsDone` | Record<AchievementId, true> | Achievements that have fired (sticky). |
| `unlocks`        | Record<string, true> | Unlock ids granted; gate via `hasUnlock`. |
| `buyMax`         | boolean        | `buy max` spawn toggle preference.              |
| `autoNice`       | boolean        | Auto-buy `nice` when affordable (unlock-gated). |
| `autoMalloc`     | boolean        | Auto-buy `malloc` when affordable (unlock-gated). |
| `autoFree`       | boolean        | Auto-`free()` the leak at `freeThreshold`.      |
| `freeThreshold`  | number         | Leak MB at which auto-free fires.               |
| `offlineCap`     | number         | `nohup` level; +4 h offline cap per level.      |
| `log`            | string[]       | Terminal feed, newest first, capped at 40.      |
| `playtime`       | number         | Seconds simulated (includes offline).           |
| `lastSave`       | number         | Epoch ms of last save; drives offline progress. |
| `saveVersion`    | number         | Save format version; drives `decode` migration. |

`newGame()` returns a fresh state with one child-tier array of zeros and the log seeded
with a boot line. `BASE` holds the tunable constants shared across the file.

### Numeric types

Unbounded values (`cycles`, `totalEarned`, `runBaseEarned`, tier/upgrade costs, child output,
legacy rates, the lineage multiplier, the survival multiplier) are `Decimal` from
`src/bignum.ts`. Bounded values (`counts`, `ramCap`, `leak`, `heat`, `cooling`, `nice`,
`shields`, `gc`, `lineage`, perk levels, timers, `playtime`) stay plain `number`.
See [ADR 0003](../decisions/0003-bignum-break-eternity.md).

## Tiers

Five child types, defined in the `TIERS` array. Each tier has its own `costGrowth`: the
cost of the next unit multiplies by that factor per purchase, so tiers have distinct cost
curves. `baseOutput` is cycles/s per unit at lineage ×1 and `survivalMult` ×1; `priority` is
only the source of the **default** sacrifice order (`DEFAULT_SACRIFICE_ORDER`, see below) —
the live sweep order is the player-controlled `sacrificeOrder`. `trait` tags a tier's
identity; `"leak-immune"` tiers (currently only the noop loop) consume RAM but never feed the
leak.

| #   | name          | baseCost | costGrowth | baseOutput | ram | priority | trait       |
| --- | ------------- | -------- | ---------- | ---------- | --- | -------- | ----------- |
| 0   | noop loop     | 10       | 1.12       | 0.1        | 1   | 0        | leak-immune |
| 1   | fork()        | 100      | 1.15       | 1          | 2   | 1        | none        |
| 2   | worker thread | 1,000    | 1.15       | 12         | 4   | 2        | none        |
| 3   | microservice  | 10,000   | 1.18       | 150        | 8   | 3        | none        |
| 4   | cron daemon   | 100,000  | 1.22       | 2,000      | 16  | 4        | none        |

Cost of the next unit of tier `i`: `baseCost[i] * costGrowth[i]^counts[i]`.

`baseOutput` is chosen so **payback does not worsen with tier**: `baseCost / baseOutput` is
100 / 100 / 83.3 / 66.7 / 50 s for tiers 0–4 — flat-to-improving, so cheap spam no longer
wins. (Output is linear in count; the exponential growth comes from the global
`survivalMult`, below.)

## Income

```
survivalMult     = (1 + SURVIVAL_BONUS)^sweepsSurvived     // SURVIVAL_BONUS = 0.05
baseCyclesPerSec = childOutput * survivalMult + BASE.rootOutput        // perk- AND achievement-free (legacy snapshot)
perkedBase       = childOutput * survivalMult * incomeMult
                 + BASE.rootOutput * incomeMult * rootMult             // growth perks
achievementMult  = Π (1 + mult)  over earned achievements
rawCyclesPerSec  = perkedBase * lineageMult * achievementMult
cyclesPerSec     = rawCyclesPerSec * heatMult
childOutput      = Σ counts[i] * baseOutput[i] * synergyMult(i)
synergyMult(i)   = Π (1 + pct * counts[from])  for each SYNERGY link targeting i
heatMult         = 1 - MAX_THROTTLE * clamp((heat - HEAT_THROTTLE_AT) / (100 - HEAT_THROTTLE_AT), 0, 1)
```

- `BASE.rootOutput = 1` — the root process itself yields 1 cycle/s. **This is the
  bootstrap:** without it a fresh game earns nothing and can never afford the first child.
- `survivalMult = (1.05)^sweepsSurvived` — the **exponential engine**. Each sweep survived
  compounds children income by 5%, so the same signal that raises sweep severity also
  raises the economy. It is a `Decimal` (not a JS `number`): `1.05^n` overflows a double
  after ~14 000 sweeps and the game is idle for days. Because the multiplier is **global**,
  it scales every tier identically and composition is still decided by the base stats, RAM
  efficiency, and `SYNERGY`.
- The root is **outside** `survivalMult`: an empty board still earns exactly 1 cycle/s, so
  the bootstrap invariant holds no matter how many sweeps have been survived.
- `baseCyclesPerSec = childOutput * survivalMult + BASE.rootOutput` — income before perks,
  lineage, achievements, and heat. Perk- and achievement-free on purpose: legacy daemon rates
  snapshot this (see [doc 004](./004-prestige-and-legacy.md)), so applying either here too
  would double-count it; the snapshot therefore inherits the compounded `survivalMult` at fork
  time.
- `lineageMult = 1 + forks * 0.1` multiplies _all_ income (children, root, legacy).
- **Achievements** (see [doc 011](./011-achievements.md)) fold into `achievementMult`, the
  product of `(1 + mult)` over earned roster rows. It multiplies `rawCyclesPerSec` alongside
  `lineageMult` — the one per-tick hook — and is **excluded** from `baseCyclesPerSec`, so it is
  never baked into a legacy snapshot; unlike lineage, it is deliberately **not** applied to
  legacy-daemon income (ADR 0012).
- **Prestige perks** (see [doc 009](./009-prestige-perk-tree.md)) apply inside `perkedBase`:
  `incomeMult` scales children and root, `rootMult` the root term only. They are applied in
  `perkedBase`, **not** in `baseCyclesPerSec`, so the legacy-rate snapshot stays perk-free;
  legacy daemons receive only the `legacyRateMult` perk (doc 004).
- `heatMult` throttles children + root income only, and only above `HEAT_THROTTLE_AT = 60`
  (see [Heat](#heat)). Legacy daemons are entirely unaffected by heat: their per-tick income
  is not part of `cyclesPerSec`, and their fork-time rate is seeded from the unthrottled,
  lineage-free `baseCyclesPerSec = childOutput * survivalMult + BASE.rootOutput`.

### Cross-tier synergy

Tiers reinforce each other, so the best board is a _composition_, not a stack of the
priciest tier. The links live in the data-driven `SYNERGY` table (`src/sim.ts`) and are
applied per-tier by `synergyMult`:

| boosted tier  | boosted by   | per-unit boost |
| ------------- | ------------ | -------------- |
| worker thread | microservice | +2% output     |
| microservice  | cron daemon  | +5% output     |

So a worker's output is `baseOutput * (1 + 0.02 * counts[microservice])`, and a
microservice's is `baseOutput * (1 + 0.05 * counts[cron daemon])`. Tiers with no incoming
link (noop loop, fork(), cron daemon) are exactly `1×`. The table is declared as
`Array<{ tier; from; pct }>` and read in a loop, so adding a link is a data edit, not a new
branch.

## RAM

```
childRam = Σ counts[i] * ram[i]
ramUsed  = childRam + leak
```

A spawn is allowed only if `cycles >= cost` **and** `ramUsed + ram[i] <= ramCapTotal`,
where `ramCapTotal = ramCap + perkMods.ramCapAdd` (the `oomguard` perk bonus). `malloc(+1)`
raises the stored `ramCap` by `MALLOC_STEP = 16`.

## The leak

Every tick, the leak grows at `LEAK_RATE = 0.01` (1% of the _leak footprint_ per second) —
the footprint being `childRam` minus `"leak-immune"` tiers:

```
leakFootprint = Σ counts[i] * ram[i]  for tiers where trait != "leak-immune"
growth = leakFootprint * 0.01 * dt
leak  += growth
if gc > 0:
  growthFlush   = growth * gc * 0.9
  standingFlush = leak * (1 - (1 - min(1, gc * 0.1)) ** dt)  // 10%/s decay, compounded over dt
  leak -= growthFlush + standingFlush   // clamped at 0
```

So `gc` level 1 removes 90% of new growth (net +10%) and sheds 10% per second of any
standing leak; level 2+ keeps the leak near zero. The standing term matters when little
new growth is being produced — e.g. once leak-prone children have been swept — so `gc`
drains the residual leak instead of leaving it for `free()` or a `backpressure` sweep.
`free()` zeroes the leak outright and is free to press.

Immune tiers still consume RAM (they count in `childRam`, `ramUsed`, and spawn gating);
they simply never contribute to leak growth. So a board of noop loops leaks nothing,
while the same footprint of fork()s leaks at the usual rate.

## Heat

A second pressure axis alongside RAM: children run hot, and heat throttles income. Decay is
**proportional to heat**, so heat has an interior equilibrium rather than a bang-bang
saturation. `tick` integrates the exponential exactly, so it is correct for any `dt`:

```
eq    = heatEquilibrium(s) = childRam * HEAT_PER_RAM / (HEAT_DECAY_RATE * (1 + cooling * 0.5)) * heatGenMult
rate  = HEAT_DECAY_RATE * (1 + cooling * 0.5)   // HEAT_DECAY_RATE = 0.02 /s
heat  = eq + (heat - eq) * exp(-rate * dt)
heat  = clamp(heat, 0, 100)
```

Because `HEAT_PER_RAM === HEAT_DECAY_RATE`, the equilibrium simplifies to
`heat_eq = childRam / (1 + cooling * 0.5)` MB — roughly **1 heat per MB of child RAM**,
halved per two cooling levels. The time constant is τ = 50 s at `cooling = 0`. The
60 → 100 throttle ramp is therefore an **interior equilibrium**: a board can settle partway
up it, and it only saturates at the cap once the equilibrium passes 100 — i.e. a footprint
above `100 * (1 + cooling * 0.5)` MB (~100 MB at `cooling = 0`, ~150 MB at level 1).

`heatMult` stays `1` up to `HEAT_THROTTLE_AT = 60`, then falls linearly to
`1 - MAX_THROTTLE = 0.5` at heat 100 — so a hot board loses up to half its children + root
income. Legacy daemons are exempt on both counts: their per-tick income ignores `heatMult`,
and `doFork` seeds a new legacy daemon's rate from the unthrottled, lineage-free
`baseCyclesPerSec`, so a throttled board does not permanently cripple the daemons it forks
off. `cooling` is the counter-upgrade: each level both sheds heat 50% faster **and lowers the
equilibrium**, buying back headroom for a bigger footprint. The `heatsink` perk (doc 009)
lowers the equilibrium by a further `heatGenMult` factor.

## Tick order (`tick(s, dt, opts)`)

Order matters — later steps observe the effects of earlier ones.

1. `playtime += dt`.
2. Accrue income: `cycles` and `totalEarned` += `cyclesPerSec * dt`.
3. Update heat from the child footprint and cooling, then clamp to `[0, 100]`. This runs
   **after** income so the throttle set here applies to the next tick's accrual.
4. Grow the leak; apply `gc` flushing.
5. Run legacy daemons (produce, roll for crash, auto-respawn if `hasUnlock(s, "legacy-respawn")`).
6. Recompute `s.sweepInterval` from progress (`sweepIntervalFor`, see
   [doc 008](./008-sweep-directives.md)), then decrement `s.sweepTimer`; when ≤ 0, run a
   sweep (resolve the stored `nextDirective`, then redraw it from the unlocked pool) and
   reset the timer to the escalated interval.
7. Memory-pressure check: if `ramUsed > 0.9 * ramCapTotal` and not already warned, log once;
   clear the latch below `0.8 * ramCapTotal`.
8. If `ramUsed > ramCapTotal * OOM_TOLERANCE`, run the OOM killer.
9. Evaluate milestones (see [doc 010](./010-milestones.md)): fire any whose metric threshold is
   met, granting their unlock flags.
10. Evaluate achievements (see [doc 011](./011-achievements.md)): fire any whose metric
    threshold is met, marking it done and logging its `+N% income` multiplier.

Between the offline early-return and the sweep, a live tick also runs **earned automation**
(`runAutomation`): auto-`free` (when `leak >= freeThreshold`), then auto-`malloc`, then
auto-`nice`, each at most once per tick and each gated by `toggle ∧ hasUnlock(…)`. Running
before the sweep lets auto-`nice` reduce this tick's victims, and before the OOM check lets
auto-`malloc` raise the ceiling in time. It is live-only, so offline catch-up never auto-buys.

`tick(s, dt, { offline: true })` is the offline catch-up path (see
[doc 003](./003-persistence.md)): it runs steps 1–5 only, so an idle gap still earns
(heat-throttled) income and runs legacy daemons but **never reaps the table (step 6), never
OOMs (steps 7–8), and never fires milestones or achievements (steps 9–10)**. The sweep timer is
therefore **frozen, not decremented**, while offline: it resumes counting down from where it left
off. The default `opts` is `{}` (live play), so the non-offline path is unchanged.

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

Fires when `ramUsed > ramCapTotal * OOM_TOLERANCE` (`OOM_TOLERANCE = 1.02`), i.e. RAM may
exceed the ceiling by up to **2%** before the killer reaps. This grace means a bar filled
exactly to the cap survives the first leak increment. Kills children from the **highest `baseOutput`
tier downward** until under the cap — i.e. it destroys your most valuable processes first.
If the leak alone is still over the cap, it is reclaimed. Then `cycles *= 0.9` and
`oomCount++`. Because the drain recovers to the cap, the killer only re-arms once the leak
re-crosses `+2%`, so the `*0.9` penalty no longer compounds tick-over-tick.

## Upgrade costs

| Upgrade           | Cost                        | Effect                                       |
| ----------------- | --------------------------- | -------------------------------------------- |
| `nice(+1)`        | `250 * 2.2^n`               | −3% sweep victims per level (floor 30%). Gated by `first-blood` (doc 010). |
| `malloc(+1)`      | `150 * 1.6^((ramCap-8)/16)` | +16 MB ceiling.                              |
| `gc(+1)`          | `400 * 3^n`                 | Faster automatic leak flushing. Gated by `grown-up` (doc 010). |
| `cooling(+1)`     | `1000 * 2.5^n`              | Heat sheds faster and its equilibrium drops. |
| `free()`          | 0                           | Zero the leak.                               |
| `SIGTERM handler` | `500 * 2^shields`           | +1 charge; each absorbs one sweep victim.    |
| `fork()`          | `1e6 * 10^forks * forkCostMult` | Prestige — see doc 004.                  |
| `nohup(+1)`       | `1e7 * 5^n`                 | +4 h offline cap (doc 003).                  |

`malloc` is the real gate to the upper tiers: its `1.6` growth and `+16 MB` step let RAM
scale fast enough to reach the cron daemon within a session, instead of leaving it
unreachable under the old `1.85` / `+8`.

The sweep now has more pressure axes (directives, sacrifice order, shields, heat throttling,
cross-tier synergy), so `nice` and `malloc` grow slightly slower to keep the early game playable.

## Prestige perks

The permanent perk tree (see [doc 009](./009-prestige-perk-tree.md)) folds into one pure
aggregate, `perkMods(s)`, which the formulas above read in place: `incomeMult`/`rootMult`
(income), `tierCostMult` (`tierCost`), `ramCapAdd` (`ramCapTotal`), `niceAdd` (added to
`s.nice` inside `sweepVictimMult`), `heatGenMult` (`heatEquilibrium`), `forkCostMult`
(`forkCost`, floored), `pointsMult` and `legacyRateMult` (`doFork`). `buyPerk` spends lineage;
`canBuyPerk` gates on prerequisite, level cap, and affordability. `baseCyclesPerSec` stays
perk-free so the legacy snapshot is clean.

## Milestones

Named, one-shot goals (`MILESTONES` in `src/config/milestones.ts`) that fire when a metric
threshold is reached and grant named unlocks. State is two sticky records (`milestonesDone`,
`unlocks`); `evaluateMilestones` runs at the end of a live tick; features gate via
`hasUnlock(s, id)` — `nice`, `gc`, and `legacy-respawn` are the starter gates. Full contract in
[doc 010](./010-milestones.md).

**Achievements** ([doc 011](./011-achievements.md)) are the numeric counterpart: named,
one-shot goals (`ACHIEVEMENTS` in `src/config/achievements.ts`) whose earned rows each grant a
small permanent income multiplier through `rawCyclesPerSec`. State is the sticky
`achievementsDone` record; `evaluateAchievements` runs at the end of a live tick, after the
milestone loop. They reuse the milestone `METRICS` readers (`MetricInput`) and never gate
content.

The bulk-spawn ability is also gated: `maxAffordable(s, i)` returns the largest number of
tier-`i` units buyable now (bounded by both `cycles` and `ramCapTotal`, solved in closed form
with a rounding correction), and `spawnMax(s, i)` bulk-buys that many in one action. `spawnMax`
refuses until `hasUnlock(s, "buy-max")` (the `bulk-buy` milestone); the persisted `buyMax`
boolean is only the toggle *preference*, not the capability.

## Invariants

- `sim.ts` imports nothing from the DOM or `main.ts`.
- `tick` is the only place time advances.
- All mutating actions return `boolean` (false = refused) so callers can re-render.
