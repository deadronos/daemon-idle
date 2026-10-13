# Sweep Directive Roster — Design

- **Issue:** #8 (Epic #5, Phase A)
- **Date:** 2026-10-11
- **Status:** Approved (design) — pending implementation

## Context

The only threat in `daemon` is the cleanup sweep. Today `runSweep` (`src/sim.ts`) applies
one flat rule: `severity = min(0.35, 0.15 + sweepsSurvived * 0.002)`, a budget of
`max(1, round(totalChildren * severity * sweepVictimMult))`, and it reaps the lowest
`priority` tier first. `nice` is the single counterplay. Every sweep is therefore
identical in shape, and the "strategic meat" promised in `IDEA.md` — two knobs, a
readable recurring threat — never materializes.

`IDEA.md` is explicit about the intended feel: _"Lean deterministic with a visible
countdown — readable tension beats surprise."_

Phase A's thesis is that the sweep should become the deep, adaptive core of the game.
This design covers the first slice: the `SweepDirective` model and a roster of named
sweep types. It is the contract that #9 (player-set priority), #10 (SIGTERM shields), and
#14 (rebalance) will consume.

## Goals

- Replace the single fixed sweep with a roster of named **directives**, each with its own
  victim-selection rule (and, where useful, its own budget rule and side effects).
- Introduce directives progressively as the player survives sweeps, so the threat evolves
  with progress.
- Keep it deterministic and previewable: a seeded draw chooses the next directive, the
  chosen directive is stored and shown on the countdown, and it survives save/load.
- The existing behavior must remain reachable exactly as the `standard` directive, so
  current balance and tests carry over unchanged.

## Non-goals

- Player-set priority groups (#9) — this change uses the current fixed per-tier priority.
- SIGTERM shields (#10), tier identity/curves (#5), heat (#13), and the upgrade rebalance
  (#14/#7).
- The full directive/victim UI (#15). Only a one-line addition to the existing sweep
  label is in scope, so the feature is observable.
- The ADR and a new numbered architecture doc — those are #16's deliverable.

## Design

### Data model (`src/sim.ts`)

```ts
export type DirectiveId = "standard" | "sigkill" | "scavenger" | "group-kill" | "backpressure";

export interface SweepDirective {
  id: DirectiveId;
  name: string; // shown on the countdown and in the sweep log line
  flavor: string; // short description
  unlockAt: number; // minimum sweepsSurvived before it can be drawn
  ignoresNice: boolean; // when true, sweepVictimMult is not applied
  /** Number of victims for this sweep, before selection. */
  budget(s: GameState, totalChildren: number): number;
  /** Tier indices to reap, in kill order; length == number of victims. */
  victims(s: GameState, budget: number): number[];
  /** Optional side effect applied before selection (e.g. reclaim the leak). */
  pre?(s: GameState): void;
}
```

`DIRECTIVES: SweepDirective[]` is the roster; `directiveById` maps an id back to its
definition (used by the log and the UI).

### Roster and escalation

Base severity is unchanged: `severity = min(0.35, 0.15 + sweepsSurvived * 0.002)`.
`sweepVictimMult = max(0.3, 1 - nice * 0.03)` is unchanged and applies to every directive
except those with `ignoresNice`.

| id             | `unlockAt` | budget           | victim selection                      | `nice` applies | `pre`         |
| -------------- | ---------- | ---------------- | ------------------------------------- | -------------- | ------------- |
| `standard`     | 0          | `severity`       | lowest `priority` first               | yes            | —             |
| `sigkill`      | 3          | `severity`       | lowest `priority` first               | **no**         | —             |
| `scavenger`    | 6          | `0.6 * severity` | highest `baseOutput` first            | yes            | —             |
| `group-kill`   | 10         | `severity`       | densest tier first, then next-densest | yes            | —             |
| `backpressure` | 15         | `0.5 * severity` | lowest `priority` first               | yes            | zero the leak |

- All budgets are `max(1, round(totalChildren * <fraction> * (ignoresNice ? 1 : sweepVictimMult)))`,
  matching today's rounding. When `totalChildren == 0`, `runSweep` logs "nothing to reap"
  and still counts the sweep (unchanged).
- Every directive selects via one shared helper `reapInOrder(s, order, budget)`, where
  `order` is the directive's tier ordering. `standard`'s order is exactly today's
  ascending-`priority` sort, so its output is identical.
- `backpressure.pre` sets `s.leak = 0`. Against a leaky (no-`gc`) build it eats the
  buffer; against a `gc` build it is a light sweep.

### Selection and escalation

- The unlocked pool is `DIRECTIVES.filter(d => d.unlockAt <= s.sweepsSurvived)`.
- `newGame()` sets `nextDirective = "standard"`.
- `runSweep` resolves `s.nextDirective`, applies it, increments `s.sweepsSurvived`, then
  draws the next directive from the pool based on the new count.

### Deterministic RNG

- A pure `nextRng(s): number` advances `s.rngState` (an int32 cursor) with a
  `mulberry32`-style step and returns a float in `[0, 1)`. No `Math.random`.
- The draw is `pool[floor(nextRng(s) * pool.length)]`, excluding the directive that just
  fired when the pool has more than one option (no back-to-back repeats).
- `newGame()` seeds `rngState` from `Date.now()`; tests set it explicitly to pin sequences.

### State and save impact

Two fields are added to `GameState`:

| Field           | Type          | Meaning                                         |
| --------------- | ------------- | ----------------------------------------------- |
| `rngState`      | number        | Int32 PRNG cursor.                              |
| `nextDirective` | `DirectiveId` | The directive that will fire at the next sweep. |

Both are additive-safe: `encode` spreads all fields, and `decode` merges the parsed save
over `newGame()` defaults, so old saves load with `nextDirective = "standard"` and a fresh
`rngState`. Storing the id (not an index) keeps saves valid if the roster is reordered.
No version bump is needed for this change (that is #25).

### UI

The sweep label in `main.ts`/`index.html` gains the directive name, e.g.
`next cleanup sweep: sigkill in 47s · reaping ~12`. The victim estimate is unchanged. The
directive/priority/victim UI is #15.

## Testing (`src/sim.test.ts`)

- Port the existing reap tests to assert the `standard` directive (same numbers).
- One test per directive:
  - `scavenger` hits the highest-`baseOutput` tier first;
  - `group-kill` removes from the densest tier first;
  - `sigkill` ignores `nice` (same budget with and without `nice`);
  - `backpressure` zeroes the leak and reaps the reduced budget.
- Pool membership: `nextDirective` is always within `{ d : d.unlockAt <= sweepsSurvived }`.
- No immediate repeat when more than one directive is unlocked.
- Determinism: identical `rngState` + `sweepsSurvived` produce the same next directive.
- `newGame()` defaults `nextDirective` to `"standard"`; a sweep advances it.

## Docs impact

- `docs/architecture/001-simulation-core.md`: rewrite the sweep section, add the two new
  state fields to the table, and note the directive step in the tick order.
- `docs/architecture/002-render-system.md`: update the sweep-meter description for the
  directive-name label.
- The ADR for the directive model and a new numbered arch doc are deferred to #16.

## Risks / open questions

- **Escalation pacing.** `unlockAt` thresholds (3/6/10/15 sweeps) are a first pass and
  will be re-tuned alongside #7/#14.
- **`backpressure` relevance.** It is weak once `gc` is owned; if playtesting shows it is
  always a non-event, fold it into #14's rebalance rather than dropping it here.
- **RNG coupling.** `rngState` is shared future RNG state for the sim; if later features
  need their own streams, split the cursor then.
