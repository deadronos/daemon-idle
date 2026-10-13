# 010 — Milestones

The goal layer: named, data-driven **milestones** that fire once when a metric threshold is
reached and grant named **unlocks**. Data and constants live in `src/config/milestones.ts`;
pure logic in `src/milestones.ts`; the two persisted records, the `tick` evaluation, and the
gates live in `src/sim.ts`.

Milestones gate **content**. Numeric rewards (micro-multipliers) are the achievements
subsystem's job (doc [011](./011-achievements.md)); a milestone never changes income directly.

## The two records

| Field            | Type                        | Meaning                                             |
| ---------------- | --------------------------- | --------------------------------------------------- |
| `milestonesDone` | `Record<MilestoneId, true>` | Milestones that have fired. **Sticky.**             |
| `unlocks`        | `Record<string, true>`      | Unlock ids granted; features gate via `hasUnlock`.  |

They are separate on purpose: a feature checks `hasUnlock(s, "gc")` — a stable id — while any
milestone may grant it. A fired milestone stays fired even if its metric later drops (only
`children` is non-monotonic), and firing is idempotent (writing `true` twice is a no-op), so
the sim can re-evaluate every tick safely.

## Data model (`src/config/milestones.ts`)

```ts
export type MetricId =
  | "totalEarned" | "sweepsSurvived" | "forks" | "playtime" | "children" | "ramCap";

export interface MilestoneDef {
  id: MilestoneId;
  name: string;
  desc: string;
  metric: MetricId;   // read from METRICS
  at: number;         // met when metric(s) >= at
  unlocks: string[];  // unlock ids granted on fire
}
```

`UNLOCK` declares the unlock ids: `nice`, `gc`, and `legacy-respawn` (granted by the starter
set), the forward ids `buy-max`, `auto-nice`, `auto-malloc`, `auto-free` that #18/#19 consume,
and #23's tier gates `tier5`/`tier6` (`"tier:5"`/`"tier:6"`, following the `tier:<index>`
convention). A feature that is not gated simply never calls `hasUnlock`.

## The starter set

| id               | metric           | `at` | unlocks                                 |
| ---------------- | ---------------- | ---- | --------------------------------------- |
| `first-blood`    | `sweepsSurvived` | 1    | `nice`                                  |
| `grown-up`       | `ramCap`         | 24   | `gc`                                    |
| `bulk-buy`       | `totalEarned`    | 1e5  | `buy-max`                               |
| `hands-off`      | `forks`          | 1    | `auto-nice`, `auto-malloc`, `auto-free` |
| `legacy-respawn` | `forks`          | 2    | `legacy-respawn`                        |
| `tier-5`         | `totalEarned`    | 1e7  | `tier:5`                                |
| `tier-6`         | `totalEarned`    | 1e9  | `tier:6`                                |

`nice` and `gc` are the only upgrades gated; `free()`, `malloc`, `cooling`, shields, and
`fork()` are available from the start. `bulk-buy` gates the spawn-panel `buy max` toggle
(bulk tier spawns — see [doc 001](./001-simulation-core.md)); `hands-off` gates the upgrades
panel's automation group (auto-nice/malloc/free); `legacy-respawn` (name "auto-respawn") gates
legacy auto-respawn (doc [004](./004-prestige-and-legacy.md)); `tier-5`/`tier-6` gate the
`k8s pod`/`bare-metal node` spawn tiers (doc [001](./001-simulation-core.md)).

## Metrics and predicate

```
milestoneMet(s, d)      = METRICS[d.metric](s) >= d.at
milestoneProgress(s, d) = min(1, METRICS[d.metric](s) / d.at)     // panel bar
```

`METRICS` maps each `MetricId` to a pure reader: `totalEarned` (`toNumber`, may be
`Infinity` — harmless for `>=` and clamped in progress), `sweepsSurvived`, `forks`,
`playtime`, `children` (Σ counts), and `ramCap` (the purchased ceiling). `METRICS` reads a
narrow `MilestoneInput` (a structural subset of `GameState`) so `milestones.ts` never imports
`sim.ts` at runtime — no cycle.

## Evaluation and tick placement

`evaluateMilestones(s)` walks `MILESTONES`, skips ones already done, and for each met-but-undone
milestone marks it done, writes its `unlocks`, and returns the fired ids. It does **not** log —
the `tick` caller logs, keeping logging in the sim.

`tick` calls it **once per live tick, at the very end**, after the `offline` early-return. So a
milestone met during live play fires the same tick, while one met during an offline catch-up
fires on the next live tick (no offline log spam, and `applyOffline` totals are unchanged).
No RNG is involved, so determinism holds.

## Gating

Rules live in `sim.ts`: `buyNice`/`buyGc` return `false` while
`!hasUnlock(s, UNLOCK.nice /* | gc */)`. The two new tiers reuse the same model:
`tierUnlocked(s, i)` reads `TIERS[i].unlock`, and `canSpawn`/`maxAffordable` refuse a locked
tier (doc [001](./001-simulation-core.md)). The UI mirrors the lock — the buttons render
**disabled with a `🔒 <milestone name>` hint** (not hidden), so the goal is discoverable
(doc 002).

## Persistence

Both records are plain objects (no `Decimal`), defaulted to `{}` in `newGame()`, and rebuilt
on load: `sanitizeMilestones` keeps only ids present in `MILESTONES`; `sanitizeUnlocks` keeps
string keys with truthy values (open-ended — later issues add ids). `SAVE_VERSION` is 8, with
additive `if (from < 3)` … `if (from < 8)` migration steps (doc 003).

## Extending

Add a `MILESTONES` row with a `metric`/`at`/`unlocks`; add a new `MetricId` (and its `METRICS`
reader) when a goal needs one; add an id to `UNLOCK` when a feature will check it. All three
are additive — no branches in the sim.
