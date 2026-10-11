# 008 — Sweep Directives (`src/sim.ts`)

The periodic **cleanup sweep** is not one rule but a roster of named **directives**. Each
directive owns its victim-selection rule, budget fraction, and optional side effect; the
sweeps get harder as `sweepsSurvived` climbs and new directives unlock. Everything here is
pure `src/sim.ts` logic keyed off `GameState`; the shared state fields (`sweepTimer`,
`sweepInterval`, `sweepsSurvived`, `rngState`, `nextDirective`, `sacrificeOrder`) are
described in [doc 001](./001-simulation-core.md).

## The `SweepDirective` contract

```ts
interface SweepDirective {
  id: DirectiveId;
  name: string; // shown on the countdown and in the sweep log line
  flavor: string; // short description
  unlockAt: number; // minimum sweepsSurvived before it can be drawn
  ignoresNice: boolean; // when true, sweepVictimMult is not applied
  budget(s: GameState, totalChildren: number): number;
  victims(s: GameState, budget: number): number[]; // tier indices, in kill order
  pre?(s: GameState): void; // optional side effect before selection
}
```

- `budget` returns the number of victims for this sweep (before selection); the eventual
  list may be shorter if fewer children are owned.
- `victims` returns the tier indices to reap, in kill order, one entry per victim — length
  equals the number actually killed.
- `pre` is optional and runs **before** selection, even when the process table is empty.
- `DIRECTIVES: SweepDirective[]` is the ordered roster; `directiveById: Map<DirectiveId,
  SweepDirective>` resolves an id to its directive (used by `runSweep`).

## Severity and budget

Severity rises with the number of sweeps survived, capped at 35%; `nice` cuts the victim
count, floored at 30%:

```
severity        = min(0.35, 0.15 + sweepsSurvived * 0.002)
sweepVictimMult = max(0.3, 1 - nice * 0.03)   // nice cuts victims, floored at 30%
budget          = max(1, round(totalChildren * severity * frac * niceMult))
niceMult        = ignoresNice ? 1 : sweepVictimMult
```

`frac` is the directive's own budget fraction (see the roster). `standard` (`frac = 1`,
`nice` applies, player sacrifice order) reproduces the original flat sweep exactly, so the
pre-roster balance and tests carry over unchanged.

## Roster

| id             | `unlockAt` | budget `frac` | victim selection                          | `nice` applies | `pre`         |
| -------------- | ---------- | ------------- | ----------------------------------------- | -------------- | ------------- |
| `standard`     | 0          | `1`           | player sacrifice order                    | yes            | —             |
| `sigkill`      | 3          | `1`           | player sacrifice order                    | **no**         | —             |
| `scavenger`    | 6          | `0.6`         | highest `baseOutput` first                | yes            | —             |
| `group-kill`   | 10         | `1`           | densest tier first, ties keep lower index | yes            | —             |
| `backpressure` | 15         | `0.5`         | player sacrifice order                    | yes            | zero the leak |

Every directive selects through the shared
`reapInOrder(s, order, budget)` helper, which takes up to `budget` from the ordering and
never more than are owned.

- `standard`, `sigkill`, and `backpressure` pass `priorityOrder(s)` — the player's sacrifice
  order (see below).
- `scavenger` passes a static order sorted by descending `baseOutput` (ties keep the lower
  tier index).
- `group-kill` sorts tiers by `counts` descending, breaking ties by the lower tier index.
- `backpressure.pre` sets `s.leak = 0`, so the leak is reclaimed on every `backpressure`
  sweep before any children are chosen.

## Selection and escalation

- The unlocked pool is `DIRECTIVES.filter(d => d.unlockAt <= s.sweepsSurvived)`; thresholds
  are **inclusive**, so e.g. `sigkill` is drawable at exactly 3 sweeps survived.
- `runSweep` resolves the stored `s.nextDirective` via `directiveById`, falling back to
  `standard` for an unknown (e.g. stale-loaded) id. It applies `pre`, lets shields absorb
  victims (see below), reaps via `reapInOrder(s, order, budget)`, increments
  `s.sweepsSurvived`, then **always** redraws `s.nextDirective` — even when the process
  table was empty and nothing was reaped.
- With nothing owned it logs "nothing to reap"; the sweep is still counted and the directive
  is still redrawn.
- The tick only calls a sweep when `sweepTimer <= 0`, then resets it to `sweepInterval`;
  see the tick order in [doc 001](./001-simulation-core.md).

## Cadence escalation

The interval between sweeps is **derived from progress**, not fixed at load time.
`sweepIntervalFor(s)` shrinks it from `BASE.sweepInterval` (60 s) toward a hard floor as
`sweepsSurvived` climbs, and `nice` softens the escalation (stretching the interval back
toward 60 s):

```
progress        = min(1, sweepsSurvived / SWEEP_ESCALATE_SWEEPS)
sweepInterval   = max(SWEEP_INTERVAL_MIN,
                      BASE.sweepInterval
                      - (BASE.sweepInterval - SWEEP_INTERVAL_MIN) * progress * sweepVictimMult)
SWEEP_INTERVAL_MIN     = 10   // cadence floor (s)
SWEEP_ESCALATE_SWEEPS  = 60   // sweeps survived to reach the floor
```

So the cadence is 60 s at 0 sweeps, 35 s at 30, and the 10 s floor at ≥60 sweeps. `nice`
reuses the same victim multiplier (`max(0.3, 1 - nice * 0.03)`), so it can hold the cadence
up to ~45 s at the escalation horizon — buying `nice` trades offence for cadence. The
function is deterministic (no `Math.random`) and monotone in `sweepsSurvived`.

`tick` recomputes `s.sweepInterval = sweepIntervalFor(s)` every frame, just before it
decrements `s.sweepTimer`; the post-sweep reset (`s.sweepTimer = s.sweepInterval`) then uses
the freshly escalated value. The field is therefore a cache the render layer already reads:
the countdown (`sweepTimer` / `sweepInterval`) previews the new cadence with **no render
change**.

## Seeded draw (`nextRng`, `pickNextDirective`)

Selection is deterministic given the state (no `Math.random`), so a save reloads with the
same pending directive and the same upcoming draw:

- `nextRng(s)` is a mulberry32-style step: it advances the int32 `s.rngState` and returns a
  float in `[0, 1)`.
- `pickNextDirective` computes `choices` = the unlocked pool **minus the just-fired
  directive** when more than one directive is unlocked (so there are no back-to-back
  repeats), then picks `choices[floor(nextRng(s) * choices.length)]`.
- `newGame()` seeds `rngState` from `Date.now() | 0` (falling back to `1`) and starts
  `nextDirective` at `standard`.

## SIGTERM handler shields

`GameState.shields` is a pool of charges bought with cycles (`500 * 2^shields` each). In
`runSweep`, after `pre` has run and the directive's budget is known, charges absorb victims
**before any are selected**:

```
absorbed = min(s.shields, budget)
s.shields -= absorbed
budget   -= absorbed
```

The reduced budget is then passed to `d.victims(s, budget)`, so a charge cancels exactly one
victim regardless of which directive is firing. Neither value can go negative: a sweep with
`shields >= budget` reaps nothing and keeps the surplus charges. The sweep log notes the
absorbed count. Shields are pure state (no timer, no `Math.random`); `buyShield(s)` returns
`false` when the cost is unaffordable.

## Sacrifice order

Which children die first is player-controlled. `GameState.sacrificeOrder` is a permutation
of the tier indices — earlier entries are reaped sooner. Default is
`DEFAULT_SACRIFICE_ORDER`, the tier indices sorted by ascending `TIERS.priority`
(`[0, 1, 2, 3, 4]`).

- `priorityOf(s, tier)` = the tier's rank = `s.sacrificeOrder.indexOf(tier)`.
- `priorityOrder(s)` = the tier indices sorted by `priorityOf` — the single source of truth
  used by the directives; nothing else re-derives an order.
- `movePriority(s, tier, delta)` swaps `tier` one slot earlier (`-1`) or later (`+1`) and
  returns `true`; returns `false` without mutating when the move would leave the range.
- `sanitizeSacrificeOrder(order: unknown)` accepts save-decode input and returns a copy of
  the order when it is a valid permutation (length `TIERS.length`, each index present
  exactly once), else a copy of `DEFAULT_SACRIFICE_ORDER`.
- Only `standard`, `sigkill`, and `backpressure` honor the order. `scavenger` and
  `group-kill` ignore it by design and use their own selection.

`TIERS.priority` is now only the source of that default; the live order is the persisted,
player-editable `sacrificeOrder`. The decision that made the order movable is recorded in
[ADR 0007](../decisions/0007-player-controlled-sacrifice-order.md).

## Relationship to the OOM killer

`runOom` (see [doc 001](./001-simulation-core.md)) is **not** a sweep. It does not read the
directive roster, ignores `sacrificeOrder`, and kills the **highest `baseOutput` first** —
the most valuable children go before the cheap ones. The OOM killer fires from memory
pressure; the sweep fires on its own timer.
