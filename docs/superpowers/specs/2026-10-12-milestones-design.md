# Milestone Gating — Design

- **Issue:** #17 (Epic #6, Phase B)
- **Date:** 2026-10-12
- **Status:** Approved (design) — pending implementation

## Context

Progression in `daemon` is purely **affordability-gated**: the only thing standing between a
new player and any upgrade is `cycles`. There is nothing to _strive toward_ except larger
numbers, and no way for content (automation, tiers) to arrive as a reward. The one existing
escalation — sweep directives unlocking at `sweepsSurvived` thresholds
([doc 008](../../architecture/008-sweep-directives.md)) — is a hardcoded `unlockAt` field, not
a general goal system.

#17 asks for a **data-driven milestone system**: named goals with predicates and rewards,
shown in a panel, persisted, and evaluated in the sim. It is the foundation **#18** (buy-max),
**#19** (auto-nice/malloc/free), and **#23** (tiers) gate through, and **#21**
(achievements) will reuse its multiplier-adjacent hook.

## Goals

- Add **milestones**: named, data-driven goals, each a single `metric >= at` predicate, that
  fire **once** and grant **unlocks**.
- Expose one gate, `hasUnlock(s, id)`, so features (and later issues) check a stable id
  instead of a milestone.
- Ship a small **starter set** that gates existing content (so the system is real now) plus
  **forward unlock ids** for the Phase B ladder.
- Keep `sim.ts` pure/deterministic; persist the achieved and unlocked sets; add a panel.
- Be additive-safe for saves and extend the staged migration chain.

## Non-goals

- **Multipliers.** Milestones grant unlocks only; numeric rewards are #21's (achievements),
  which will extend the same definition additively.
- **Implementing the gated features.** Buy-max, auto-\*, and new tiers arrive in #18/#19/#23;
  #17 defines their unlock ids and gates `nice`/`gc` as the demonstration.
- **Folding the sweep-directive `unlockAt` escalation into milestones.** Directives key off
  `sweepsSurvived` for a deterministic draw pool; unifying them is a separate consideration.
- **Composite predicates** (AND of several conditions) — a single numeric metric is enough
  for now; a condition list is an additive upgrade later.

## Decisions (from the design dialogue)

1. **Boundary:** milestones gate content (unlocks + tier gates); **multipliers are #21's**.
2. **Reward mechanism:** named unlock flags written to persisted `unlocks`, gated by
   `hasUnlock(s, id)`. No reward closures.
3. **Predicate:** one numeric `metric >= at`, with a data `METRICS` table.
4. **Starter set scope:** two existing gates now (`nice`, `gc`) + forward unlock ids for
   #18/#19/#23 (their milestone rows authored by those issues).
5. **Architecture:** mirror #22's subsystem shape — `src/config/milestones.ts` (data) +
   `src/milestones.ts` (logic) + `sim.ts` (state/actions/tick).
6. **Sticky:** a fired milestone stays fired (`milestonesDone` is a sticky set); `unlocks` is
   a separate set so features don't couple to milestone ids.

## Design

### File layout

| File                                           | Owns                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/config/milestones.ts`                     | `MilestoneId`, `MetricId`, `MilestoneDef`, the `MILESTONES` roster, the `UNLOCK` id constants. No runtime imports (leaf). |
| `src/milestones.ts`                            | Pure logic: `METRICS`, `milestoneMet`, `milestoneProgress`, `evaluateMilestones`, `hasUnlock`.                            |
| `src/sim.ts`                                   | The two persisted fields, the `tick` evaluation call, and the `nice`/`gc` gates.                                          |
| `src/persistence.ts`                           | `sanitizeMilestones`, `sanitizeUnlocks`, the v3 migration step.                                                           |
| `src/main.ts` + `index.html` + `src/style.css` | The milestones panel and the locked-upgrade hints.                                                                        |

Runtime dependency direction is one-way: `config/milestones.ts` → (nothing);
`milestones.ts` → `config/milestones.ts`; `sim.ts` → both; `persistence.ts` → all.

### State

Two sticky records, both defaulted in `newGame()` (additive-safe):

| Field            | Type                        | Meaning                                                    | Default |
| ---------------- | --------------------------- | ---------------------------------------------------------- | ------- |
| `milestonesDone` | `Record<MilestoneId, true>` | Milestones that have fired (sticky).                       | `{}`    |
| `unlocks`        | `Record<string, true>`      | Unlock ids granted by rewards; features check `hasUnlock`. | `{}`    |

`unlocks` is deliberately separate from `milestonesDone`: a feature checks
`hasUnlock(s, "gc")` while any milestone (or a future source) may grant it. Firing is
**idempotent** (writing `true` twice is a no-op), so re-evaluating every tick is safe.

### Data model (`src/config/milestones.ts`)

```ts
export type MilestoneId = string;
export type MetricId =
  | "totalEarned"
  | "sweepsSurvived"
  | "forks"
  | "playtime"
  | "children"
  | "ramCap"
  | "directivesSeen";

export interface MilestoneDef {
  id: MilestoneId;
  name: string;
  desc: string;
  metric: MetricId; // read from METRICS
  at: number; // met when metric(s) >= at
  unlocks: string[]; // unlock ids granted on fire (usually one)
}

export const MILESTONES: MilestoneDef[] = [/* starter set, below */];

/** Forward unlock ids: declared here, consumed by #18/#19/#23. */
export const UNLOCK = {
  nice: "nice",
  gc: "gc",
  buyMax: "buy-max",
  autoNice: "auto-nice",
  autoMalloc: "auto-malloc",
  autoFree: "auto-free",
} as const;
```

### Starter set

The only `MILESTONES` entries in #17:

| id            | name        | metric           | `at` | unlocks |
| ------------- | ----------- | ---------------- | ---- | ------- |
| `first-blood` | first blood | `sweepsSurvived` | 1    | `nice`  |
| `grown-up`    | grown-up    | `ramCap`         | 24   | `gc`    |

- `first-blood` fires after the first cleanup sweep — teaches the sweep axis via `nice`.
- `grown-up` fires after the first `malloc` (8 → 24 MB) — teaches RAM scaling via `gc`.

`nice` and `gc` are the **only** upgrades gated in #17. `free()`, `malloc`, `cooling`,
shields, and `fork()` stay available from the start (they never call `hasUnlock`).

### Metrics and predicate (`src/milestones.ts`)

| `MetricId`       | value                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `totalEarned`    | `s.totalEarned.toNumber()` (may be `Infinity`; safe for `>=` and clamped in progress) |
| `sweepsSurvived` | `s.sweepsSurvived`                                                                    |
| `forks`          | `s.forks`                                                                             |
| `playtime`       | `s.playtime`                                                                          |
| `children`       | `Σ counts`                                                                            |
| `ramCap`         | `s.ramCap` (the purchased ceiling; see the rebase note for `ramCapTotal`)             |
| `directivesSeen` | `unlockedDirectives(s).length`                                                        |

```ts
milestoneMet(s, d)      = METRICS[d.metric](s) >= d.at
milestoneProgress(s, d) = Math.min(1, METRICS[d.metric](s) / d.at)   // panel bar
```

### Evaluation and `tick` placement

```ts
export function evaluateMilestones(s: GameState): MilestoneId[] {
  const fired: MilestoneId[] = [];
  for (const d of MILESTONES) {
    if (s.milestonesDone[d.id]) continue;
    if (!milestoneMet(s, d)) continue;
    s.milestonesDone[d.id] = true;
    for (const u of d.unlocks) s.unlocks[u] = true;
    if (d.unlocks.length > 0) log(s, `milestone: ${d.name} — unlocked`);
    fired.push(d.id);
  }
  return fired;
}

export function hasUnlock(s: GameState, id: string): boolean {
  return Boolean(s.unlocks[id]);
}
```

`tick` calls `evaluateMilestones(s)` **once per live tick, at the very end**, i.e. **after the
`offline` early-return**. So:

- a milestone met during live play fires the same tick;
- a milestone met during an offline catch-up fires on the next live tick (no offline log
  spam, and `applyOffline` totals are unchanged);
- no RNG is involved, so determinism holds.

### Gating `nice` and `gc`

Rules live in `sim.ts`, so both the action and the UI respect the lock:

```
buyNice(s)  →  if (!hasUnlock(s, UNLOCK.nice)) return false;   // then the existing logic
buyGc(s)    →  if (!hasUnlock(s, UNLOCK.gc))   return false;
```

In `main.ts`, those two upgrade buttons render **shown-but-disabled with a `🔒 <milestone
name>` hint** while locked (not hidden), so the goal is discoverable. All other upgrades are
ungated.

### Persistence and migration (`src/persistence.ts`)

- `newGame()` defaults `milestonesDone: {}`, `unlocks: {}`; both are plain objects, so
  `encode` needs no special handling.
- `SAVE_VERSION` bumps **2 → 3**, adding one staged step:
  ```ts
  const from = coerceFinite(parsed.saveVersion, 0);
  if (from < 2) {
    /* legacy-rate division — unchanged */
  }
  if (from < 3) {
    /* additive: milestones/unlocks come from newGame() defaults; no-op */
  }
  ```
- `sanitizeMilestones(raw)` — keep only keys present in `MILESTONES` with a truthy value;
  non-object → `{}`. Rebuilt from the roster, so stale ids never survive.
- `sanitizeUnlocks(raw)` — keep string keys with a truthy value, capped at a sane count;
  non-object → `{}`. Open-ended on purpose (later issues add unlock ids), so it is **not**
  restricted to the current `UNLOCK` registry.

**Rebase note.** This branch is based on a `main` where `SAVE_VERSION = 2` and the perk
subsystem does not yet exist. If PR #48 (the perk tree) lands first:

- #22 already occupies the `< 3` migration step, so #17's step becomes `< 4` and the constant
  becomes `4`;
- the `ramCap` metric should read `ramCapTotal(s)` instead of `s.ramCap`, so the `oomguard`
  perk's RAM bonus counts toward `grown-up`.

Both are mechanical and are recorded here so the conflict is expected rather than surprising.

### UI (`src/main.ts`)

A new `milestones` panel (always visible — it is the game's goal list), built like the other
panels:

- **Rows** from `MILESTONES`: name, `desc`, and status.
  - **achieved:** `✓ unlocked: nice` (dimmed, sorted to the bottom).
  - **pending:** a small progress bar (`milestoneProgress`) plus `value / at`
    (e.g. `0 / 1 sweep`, `8 / 24 MB`).
- **Order:** pending first by `milestoneProgress` descending (closest to firing on top), then
  achieved; ties keep `MILESTONES` order.
- **Locked upgrades:** the `nice`/`gc` buttons in the `upgrades` panel show
  `🔒 <milestone name>` and are disabled until unlocked.
- **Rebuild diff:** rows rebuilt only when the `milestonesDone` + `unlocks` signature changes
  (`milestonePanel.dataset.sig`); progress refreshes each frame. New ids in `index.html`; a
  `.milestones` block in `style.css`.

## Testing

New `src/milestones.test.ts` plus additions to `src/sim.test.ts` and
`src/persistence.test.ts`. The sim is pure, so this is all node-testable.

- **Roster integrity:** unique ids; every `metric` is a real `MetricId`; `at > 0`; every
  `unlocks` entry non-empty.
- **`METRICS`:** each metric reads the expected value, including `ramCap` from `s.ramCap`,
  `children` summing counts, and `directivesSeen` from `unlockedDirectives`.
- **`milestoneMet` / `milestoneProgress`:** met at and above `at`; progress clamps to `[0,1]`
  and is `Infinity`-safe for a huge `totalEarned`.
- **`evaluateMilestones`:** fires once and is idempotent; **sticky** (stays done when its
  metric later drops, e.g. `children` after a sweep); grants the unlock ids; returns newly
  fired ids; logs once.
- **Gating:** `buyNice`/`buyGc` return `false` before the unlock and `true` after; other
  upgrades are unaffected. Update the existing fresh-game `nice`/`gc` fixtures to unlock first.
- **`tick`:** a live tick fires a newly-met milestone at the end; an `{ offline: true }` tick
  does not.
- **Persistence:** round-trip both records; `sanitizeMilestones` drops unknown ids;
  `sanitizeUnlocks` keeps `string:true` and drops non-objects/garbage; a pre-version save
  loads with both `{}`; the staged chain still does not re-divide a v2 save.

## Docs impact (lockstep)

- **New** `docs/architecture/010-milestones.md` — the goal→reward contract: the two records,
  `METRICS`, the predicate/progress shapes, `hasUnlock`, tick placement, and the forward-id
  convention. Register it in the `docs/architecture/README.md` index.
- **Touch** `001-simulation-core.md` (state table, tick order, the `nice`/`gc` gate),
  `002-render-system.md` (the panel), `003-persistence.md` (fields, `SAVE_VERSION` 3, staged
  step).
- **ADR** `docs/decisions/0009-milestone-gating-model.md` — records the data-driven goal/flag
  model and the rejected alternatives.
- `npm run check` green; a browser screenshot of the panel with the values it shows.

## Risks / open questions

- **Early-game pacing shift.** Gating `nice` and `gc` changes the first minutes; confirm it
  reads as tutorial rather than as a wall (tune `at` if not). Both thresholds are data.
- **Inert-forward ids.** `buyMax`/`auto*` unlock ids do nothing until #18/#19 land. The panel
  does not surface them (their milestones are authored by those issues), so there is no
  user-visible inert state — but a reviewer may want a note in `010`.
- **Non-monotonic metrics.** Only `children` can fall; `milestonesDone` is sticky precisely so
  a fired `children` milestone does not un-fire.
- **Rebase on #48.** The `SAVE_VERSION`/migration collision is expected and documented above.
- **A wider refactor is due.** #22 and #17 both add a `src/config/*` + pure-subsystem pair;
  `sim.ts` keeps growing. Splitting it is a deliberate, separate follow-up, not part of this
  change.

## Alternatives considered

- **Milestones also grant multipliers** — rejected (decision 1): overlaps #21's
  micro-multipliers; keep "goals gate content, achievements nudge numbers".
- **A typed reward union** (`{ type: "unlock" | … }`) — rejected (decision 2): machinery
  #17 does not need; flags extend additively when #21 adds a multiplier kind.
- **Per-milestone predicate/reward closures** — rejected: pushes logic into per-entry
  functions, unprovable as one aggregate, and against the repo's declarative pattern.
- **Persisting only `unlocks` and deriving "done"** — rejected: `children` can decrease, so a
  derived state would flicker; a sticky `milestonesDone` is explicit and testable.
- **All in `sim.ts`** — rejected (decision 5): inconsistent with the `config/` + subsystem
  shape established one change earlier by #22.
- **Fold the sweep-directive `unlockAt` escalation into milestones** — out of scope; the
  directive pool is a deterministic, previewable draw, not a reward.
