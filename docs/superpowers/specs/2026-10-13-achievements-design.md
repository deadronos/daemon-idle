# Achievements with Micro-Multipliers — Design

- **Issue:** #21 (Epic #6, Phase B)
- **Date:** 2026-10-13
- **Status:** Approved (design) — pending implementation
- **Depends on:** B1 (#17 milestones), B8 (#24 offline), #20 — stacked on `feat/phase-b`

## Context

Milestones (doc [010](../architecture/010-milestones.md)) are the goal layer, but they are
deliberately **content-only**: "a milestone never changes income directly". There is no numeric
micro-goal to chase — a player has nothing to earn between prestige runs except a bigger
`survivalMult`.

#21 adds **achievements**: named, data-driven goals that fire once when a metric threshold is
reached and grant a **small permanent income multiplier**. Achievements are the numeric
counterpart to milestones' content unlocks. They reuse the milestone metric readers rather than
introducing a parallel metric layer, and they feed income through **one** documented hook — the
same per-tick path `lineageMult` uses — so they are never baked into the legacy-rate snapshot.

## Goals

- A data-driven achievement roster; each met threshold grants a small permanent multiplier.
- Earned achievements persist (additive save change) and survive a reload.
- The multiplier feeds income through **exactly one** documented hook, never the legacy-rate
  snapshot.
- Evaluation is **sticky** and **idempotent**, and **live-only** (an offline catch-up grants
  none).
- An achievements panel listing earned + pending goals with a progress bar.
- Reuse the milestone metric readers (DRY): one `MetricInput`, one `METRICS` table.

## Non-goals

- New metrics. The six existing `MetricId`s are enough; no `legacy` metric.
- Content unlocks (gating content stays milestones' job).
- Multiplying legacy-daemon income (that would be a second hook — see Decisions).
- A new spendable currency, or any way to lose an earned achievement.

## Decisions

1. **Two new modules, split data from logic.** `src/config/achievements.ts` is a leaf (data +
   types only): `AchievementId`, `AchievementDef { id, name, desc, metric, at, mult }`,
   `ACHIEVEMENTS`, `achievementById`. `src/achievements.ts` is pure logic with **no DOM and no
   runtime `GameState` import** — it reads a narrow `AchievementInput` (mirroring
   `src/milestones.ts`). `mult` is a small positive **fraction** (`0.02` = +2%), a plain number.

2. **Reuse the milestone metric readers (DRY).** In `src/milestones.ts`, extract a narrow
   `MetricInput` (`totalEarned`, `sweepsSurvived`, `forks`, `playtime`, `counts`, `ramCap`),
   make `MilestoneInput extends MetricInput`, and retype `METRICS` on `MetricInput`.
   `src/achievements.ts` imports `METRICS`, `MetricId`, and `MetricInput` from `./milestones`;
   `achievements → milestones` is the only direction, so there is no cycle. No new metric is
   added.

3. **State + persistence.** Add `achievementsDone: Record<AchievementId, true>` to `GameState`
   and `newGame()` (additive). Bump `SAVE_VERSION` 6 → 7 with a **staged** `if (from < 7)` no-op
   step, and sanitize with `sanitizeAchievements` — a truthy-key map rebuilt from `ACHIEVEMENTS`,
   mirroring `sanitizeMilestones`/`sanitizeUnlocks`.

4. **Pure logic.** `evaluateAchievements(s)` fires every met + not-done achievement, marks it
   done, and returns the newly-earned ids (sticky + idempotent, like `evaluateMilestones`).
   `achievementMet`, `achievementProgress`, and `orderedAchievements` (pending-by-progress first)
   support the UI.

5. **Income hook — exactly one.** `achievementMult(s): Decimal` is the product of `(1 + mult)`
   over earned achievements. It is applied in `rawCyclesPerSec` alongside `lineageMult`:

   ```
   rawCyclesPerSec = perkedBaseCyclesPerSec × lineageMult × achievementMult
   ```

   `baseCyclesPerSec` stays achievement-free, so `doFork`'s legacy-rate snapshot never bakes the
   multiplier in (no double-count). Legacy daemons receive only `lineageMult × legacyRateMult`;
   achievements are deliberately **not** applied there — one hook, per the acceptance. This is
   the one place achievements differ from lineage (which also scales legacy income), and it is
   recorded in ADR 0012.

6. **Tick placement.** `evaluateAchievements(s)` runs **live-only at the end of `tick`**, after
   the offline early-return, next to the milestone loop; the sim logs each newly-earned one
   (`achievement: <name> — +N% income`).

7. **Roster: ~8 rows, 1–5% each**, spread across the six metrics. Values are tunable data.

8. **UI.** An achievements panel wired like the milestones panel (earned + pending with a
   progress bar); `index.html`/`style.css` changes stay minimal and reuse the milestone row
   styles.

9. **Docs lockstep.** New `docs/architecture/011-achievements.md` (+ register in the index);
   update `001` (income hook + tick step + state row), `002` (panel), `003` (state + version 7 +
   sanitize); add ADR `docs/decisions/0012-achievements-multiplier-hook.md` and register it.

## Design

### Data model (`src/config/achievements.ts`)

```ts
import type { MetricId } from "./milestones"; // type-only: stays a leaf, no runtime edge

export type AchievementId = string;

export interface AchievementDef {
  id: AchievementId;
  name: string;
  desc: string;
  metric: MetricId; // read from METRICS in src/milestones.ts
  at: number;       // met when METRICS[metric](s) >= at
  mult: number;     // small positive fraction, e.g. 0.02 = +2% income
}

export const ACHIEVEMENTS: AchievementDef[] = [ /* roster below */ ];

export function achievementById(id: AchievementId): AchievementDef | undefined { … }
```

### Roster (tunable data)

| id               | name           | desc                           | metric           | `at` | `mult` |
| ---------------- | -------------- | ------------------------------ | ---------------- | ---- | ------ |
| `first-earnings` | first earnings | earn 1,000 cycles              | `totalEarned`    | 1e3  | +2%    |
| `grinder`        | grinder        | earn 1,000,000,000 cycles      | `totalEarned`    | 1e9  | +5%    |
| `survivor`       | survivor       | survive 10 cleanup sweeps      | `sweepsSurvived` | 10   | +2%    |
| `veteran`        | veteran        | survive 100 cleanup sweeps     | `sweepsSurvived` | 100  | +4%    |
| `forker`         | forker         | fork once                      | `forks`          | 1    | +2%    |
| `crowd`          | crowd          | run 50 children at once        | `children`       | 50   | +3%    |
| `headroom`       | headroom       | raise the RAM ceiling to 64 MB | `ramCap`         | 64   | +3%    |
| `uptime`         | uptime         | play for one hour              | `playtime`       | 3600 | +2%    |

Eight rows cover all six metrics. The full-roster product is ≈ 1.25× — a meaningful but small
permanent boost, well under the milestone/prestige layers. All numbers are data.

### Logic (`src/achievements.ts`)

```ts
export interface AchievementInput extends MetricInput {
  achievementsDone: Record<AchievementId, true>;
}

achievementMet(s, def)      = METRICS[def.metric](s) >= def.at
achievementProgress(s, def) = def.at <= 0 ? 1 : min(1, METRICS[def.metric](s) / def.at)

achievementMult(s) = Π (1 + def.mult)  for def where s.achievementsDone[def.id]   // Decimal

evaluateAchievements(s): AchievementId[]   // fire met + not-done, mark done, return ids
orderedAchievements(s): AchievementDef[]   // pending by progress desc, then earned
```

`achievementMult` folds over the `ACHIEVEMENTS` roster, so a stale/unknown key in
`achievementsDone` cannot affect income (and `sanitizeAchievements` drops it on load anyway).
Like `evaluateMilestones`, `evaluateAchievements` never logs — the `tick` caller logs.

### Income hook

```
survivalMult     = (1 + SURVIVAL_BONUS)^sweepsSurvived
baseCyclesPerSec = childOutput × survivalMult + BASE.rootOutput        // perk- AND achievement-free (legacy snapshot)
perkedBase       = childOutput × survivalMult × incomeMult
                 + BASE.rootOutput × incomeMult × rootMult
achievementMult  = Π (1 + mult) over earned achievements
rawCyclesPerSec  = perkedBase × lineageMult × achievementMult
cyclesPerSec     = rawCyclesPerSec × heatMult
```

- The multiplier sits exactly where `lineageMult` sits — the **per-tick income path** — and is
  deliberately excluded from `baseCyclesPerSec`. Because `doFork` snapshots `baseCyclesPerSec`
  into each legacy daemon's rate, an earned achievement can never be baked into a snapshot and
  applied again per tick.
- Legacy daemons are **not** multiplied by achievements: `tick` scales them by
  `lineageMult × legacyRateMult` only. One hook, one documented place. (Lineage also scales
  legacy income; this is a deliberate scope difference, recorded in ADR 0012.)

### Tick placement

At the very end of `tick`, immediately after the milestone loop (and after the
`if (opts.offline) return;` early-return):

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

### Persistence

`achievementsDone` is a plain object (no `Decimal`), defaulted to `{}` in `newGame()` and rebuilt
on load:

- `sanitizeAchievements(raw)` keeps only ids present in `ACHIEVEMENTS` whose value is truthy; a
  non-object (or array) yields `{}` — stale ids never survive.
- `decode` wires `s.achievementsDone = sanitizeAchievements(parsed.achievementsDone)`.
- `SAVE_VERSION` 6 → 7, with an additive `if (from < 7)` no-op placeholder so the migration chain
  stays staged (doc [003](../architecture/003-persistence.md)).

### UI

A new `achievements` panel (`#achievementPanel`) rendered by `renderAchievements()`, mirroring
`renderMilestones()`: `orderedAchievements` pending-first by `achievementProgress` descending,
then earned ones dimmed. A pending row shows a progress bar and `value / at <unit>`; an earned
row shows `✓ +N% income`. Rows are rebuilt only when the earned-set signature changes; progress
numbers refresh each frame. The panel reuses the milestone row styles (`.achievements` added to
the `.milestones` container selector) — minimal HTML/CSS.

## Testing

- **Roster shape:** unique ids, every `metric in METRICS`, `at > 0`, `0 < mult ≤ 0.05`.
- **Predicate:** `achievementMet` at/above the threshold, not below; `achievementProgress`
  clamps to `[0, 1]` and stays finite for a huge `totalEarned`.
- **Evaluation:** fires a met achievement once, grants nothing offline, is sticky when a
  non-monotonic metric (`children`) later drops, and idempotent on re-run.
- **Multiplier:** `1` with none earned; the product of `(1 + mult)` over earned ids.
- **Ordering:** pending by progress descending, earned last.
- **MetricInput refactor:** `METRICS` reads a bare `MetricInput` (no milestone/achievement
  records); the existing milestones suite stays green.
- **Hook:** `rawCyclesPerSec` scales by `(1 + mult)`; `baseCyclesPerSec` is unchanged by an
  earned achievement; a forked daemon's `rate` is identical with and without earned
  achievements (not baked into the snapshot).
- **Live-only:** a live tick grants a met achievement; an offline tick grants none.
- **Persistence:** round-trip, stale-key drop, non-object → `{}`, a pre-v7 save loads with `{}`
  and stamps `SAVE_VERSION === 7`.
- **UI:** drive the dev server, screenshot, and report the panel's values.

## Docs impact (lockstep)

- **New** `docs/architecture/011-achievements.md` (roster, logic, hook, tick, persistence, UI);
  register it in `docs/architecture/README.md`.
- `docs/architecture/001-simulation-core.md` — the income formula (`achievementMult` in
  `rawCyclesPerSec`; `baseCyclesPerSec` achievement-free), the `achievementsDone` state row, the
  tick step, and the offline sentence.
- `docs/architecture/002-render-system.md` — the achievements panel.
- `docs/architecture/003-persistence.md` — `sanitizeAchievements`, the version-7 row and
  "Why v7".
- **ADR** `docs/decisions/0012-achievements-multiplier-hook.md` — the same per-tick hook as
  lineage, **not** in the legacy snapshot, and not applied to legacy daemons; register it in
  `docs/decisions/README.md`.
- `npm run check` green; a browser screenshot reporting the panel.

## Risks / open questions

- **Legacy exclusion.** Achievements do not scale legacy-daemon income, unlike lineage. This is
  deliberate ("one documented hook") and recorded in ADR 0012; revisit only if legacy income
  should share the multiplier.
- **Tuning.** The thresholds and 1–5% magnitudes are first-pass data; the roster product is
  ≈ 1.25×.
- **Non-monotonic `children`.** `crowd` uses `children`, which can drop when a sweep reaps the
  table — sticky evaluation means it stays earned (same rule as milestones).
- **Compounding.** Eight small multipliers compose; kept small on purpose so the prestige/perk
  layers stay dominant.

## Alternatives considered

- **Bake `achievementMult` into `baseCyclesPerSec`.** Rejected: `doFork` snapshots that value
  into legacy rates, so `tick` would apply the multiplier again — the exact double-count the
  lineage-free snapshot exists to avoid.
- **Reuse `milestonesDone`/`unlocks` for achievements.** Rejected: conflates content gates with
  numeric rewards, and `unlocks` is open-ended, so it cannot be roster-rebuilt/sanitized the way
  a bounded achievement record can.
- **Add a `legacy` metric.** Rejected: the six existing metrics already cover the roster; a new
  reader is unjustified.
- **Apply the multiplier to legacy daemons too (mirror lineage fully).** Rejected: that is a
  second income hook and weakens the "one documented hook" acceptance.
- **Make `mult` a `Decimal`.** Rejected: the roster is tiny and `mult` is a fraction; the
  product is promoted to `Decimal` when it enters the income path, so a plain number is enough.
- **A spendable achievement currency.** Rejected: achievements are permanent passive multipliers;
  a second currency overlaps the perk tree.
