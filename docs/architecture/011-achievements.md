# 011 — Achievements

The numeric goal layer: named, data-driven **achievements** that fire once when a metric
threshold is reached and grant a **small permanent income multiplier**. Data and types live in
`src/config/achievements.ts`; pure logic in `src/achievements.ts`; the persisted record, the
income hook, and the `tick` evaluation live in `src/sim.ts`.

Achievements are the counterpart to [milestones](./010-milestones.md) (doc 010): milestones gate
**content**, achievements pay **numbers**. They reuse the milestone metric readers rather than
introducing a parallel metric layer, and they feed income through **exactly one** hook — the
same per-tick path `lineageMult` uses — so they are never baked into the legacy-rate snapshot
(see [ADR 0012](../decisions/0012-achievements-multiplier-hook.md)).

## Data model (`src/config/achievements.ts`)

A leaf module (data + types only; `import type { MetricId }` keeps it runtime-free):

```ts
export type AchievementId = string;

export interface AchievementDef {
  id: AchievementId;
  name: string;
  desc: string;
  metric: MetricId;   // read from METRICS in src/milestones.ts
  at: number;         // met when METRICS[metric](s) >= at
  mult: number;       // small positive fraction, e.g. 0.02 = +2% income
}

export const ACHIEVEMENTS: AchievementDef[] = [ /* roster below */ ];
export function achievementById(id: AchievementId): AchievementDef | undefined;
```

## Roster (tunable data)

| id               | metric           | `at` | `mult` |
| ---------------- | ---------------- | ---- | ------ |
| `first-earnings` | `totalEarned`    | 1e3  | +2%    |
| `grinder`        | `totalEarned`    | 1e9  | +5%    |
| `survivor`       | `sweepsSurvived` | 10   | +2%    |
| `veteran`        | `sweepsSurvived` | 100  | +4%    |
| `forker`         | `forks`          | 1    | +2%    |
| `crowd`          | `children`       | 50   | +3%    |
| `headroom`       | `ramCap`         | 64   | +3%    |
| `uptime`         | `playtime`       | 3600 | +2%    |

Eight rows cover all six `MetricId`s; the full-roster product is ≈ 1.25× — a meaningful but
small permanent boost, well under the milestone/prestige layers. All numbers are data.

## Logic (`src/achievements.ts`)

Pure, DOM-free, and free of any runtime `GameState` import: the helpers read a narrow
`AchievementInput` (`MetricInput` + `achievementsDone`), mirroring `MilestoneInput`.

```
achievementMet(s, def)      = METRICS[def.metric](s) >= def.at
achievementProgress(s, def) = def.at <= 0 ? 1 : min(1, METRICS[def.metric](s) / def.at)

achievementMult(s)          = Π (1 + def.mult)   for def where s.achievementsDone[def.id]   // Decimal

evaluateAchievements(s)     = fire every met + not-done def, mark it done, return the ids
orderedAchievements(s)      = pending by progress descending, then earned
```

`achievementMult` folds over the `ACHIEVEMENTS` roster, so a stale/unknown key in
`achievementsDone` cannot affect income (and `sanitizeAchievements` drops it on load anyway).
`evaluateAchievements` is **sticky** (a fired achievement stays fired even if a non-monotonic
metric like `children` later drops) and **idempotent** (re-running adds nothing), so the sim may
call it every tick. Like `evaluateMilestones`, it never logs — the `tick` caller logs.

## Income hook — exactly one

```
survivalMult     = (1 + SURVIVAL_BONUS)^sweepsSurvived
baseCyclesPerSec = childOutput × survivalMult + BASE.rootOutput        // perk- AND achievement-free (legacy snapshot)
perkedBase       = childOutput × survivalMult × incomeMult
                 + BASE.rootOutput × incomeMult × rootMult
achievementMult  = Π (1 + mult) over earned achievements
rawCyclesPerSec  = perkedBase × lineageMult × achievementMult
cyclesPerSec     = rawCyclesPerSec × heatMult
```

The multiplier sits exactly where `lineageMult` sits — the per-tick income path — and is
deliberately excluded from `baseCyclesPerSec`. Because `doFork` snapshots `baseCyclesPerSec`
into each legacy daemon's rate (doc [004](./004-prestige-and-legacy.md)), an earned achievement
can never be baked into a snapshot and applied again per tick.

Legacy daemons are **not** multiplied by achievements: `tick` scales them by
`lineageMult × legacyRateMult` only. This is the one place achievements differ from lineage
(which also scales legacy income); it is deliberate ("one documented hook") and recorded in
[ADR 0012](../decisions/0012-achievements-multiplier-hook.md).

## Tick placement (live-only)

At the very end of `tick`, immediately after the milestone loop and after the
`if (opts.offline) return;` early-return:

```ts
// achievements: micro-multipliers, evaluated once per live tick alongside milestones
for (const id of evaluateAchievements(s)) {
  const def = achievementById(id);
  if (def) log(s, `achievement: ${def.name} — +${Math.round(def.mult * 100)}% income`);
}
```

So an achievement met during live play fires the same tick; one met during an offline catch-up
fires on the next live tick (no offline log spam, and `applyOffline` totals are unchanged). No
RNG is involved, so determinism holds.

## Persistence

`achievementsDone` is a plain object (no `Decimal`), defaulted to `{}` in `newGame()` and rebuilt
on load:

- `sanitizeAchievements(raw)` keeps only ids present in `ACHIEVEMENTS` whose value is truthy; a
  non-object (or array) yields `{}` — stale ids never survive.
- `decode` wires `s.achievementsDone = sanitizeAchievements(parsed.achievementsDone)`.
- `SAVE_VERSION` 6 → 7, with an additive `if (from < 7)` no-op placeholder so the migration chain
  stays staged (doc [003](./003-persistence.md)).

## UI

A new `achievements` panel (`#achievementPanel`) rendered by `renderAchievements()`, mirroring
`renderMilestones()`: `orderedAchievements` pending-first by `achievementProgress` descending,
then earned ones dimmed. A pending row shows a progress bar and `value / at <unit>`; an earned
row shows `✓ +N% income`. Rows are rebuilt only when the earned-set signature changes
(`achievementPanel.dataset.sig`); progress numbers refresh each frame. The panel reuses the
milestone row styles (`.achievements` is added to the `.milestones` container selector) —
minimal HTML/CSS (doc [002](./002-render-system.md)).

## Extending

Add an `ACHIEVEMENTS` row with a `metric`/`at`/`mult`; the roster is rebuilt on load and folded
by `achievementMult`, so a new row is additive — no branches in the sim. A new `MetricId` (and
its `METRICS` reader in `src/milestones.ts`) is only needed when a goal wants a metric the six
readers do not cover.
