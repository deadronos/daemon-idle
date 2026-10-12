# 0012 — Achievements pay through the one per-tick multiplier hook

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Milestones (doc [010](../architecture/010-milestones.md)) are the goal layer but are
deliberately **content-only**: "a milestone never changes income directly". #21 adds
**achievements** — named, data-driven goals whose earned rows grant a **small permanent income
multiplier** (1–5% each, ≈1.25× for the full roster). This introduces a new numeric reward into
an economy that already has several multipliers (`survivalMult`, `lineageMult`, perks) and a
legacy-rate snapshot (`baseCyclesPerSec`) that `doFork` copies into each legacy daemon's rate.

The design constraint: a multiplier applied in more than one place — or baked into the legacy
snapshot and then applied again per tick — would double-count. The achievement layer therefore
had to pick exactly one income hook, and decide whether legacy daemons share it.

## Decision

Apply the achievement multiplier in **`rawCyclesPerSec` only** — the same per-tick hook
`lineageMult` uses:

```
achievementMult = Π (1 + mult)  over earned achievements          // Decimal
rawCyclesPerSec = perkedBaseCyclesPerSec × lineageMult × achievementMult
```

- **Not in `baseCyclesPerSec`.** That value is the legacy snapshot source; keeping it
  achievement-free means an earned achievement can never be baked into a fork's rate and
  applied a second time. `baseCyclesPerSec` stays perk- and achievement-free.
- **Not applied to legacy daemons.** `tick` scales legacy income by
  `lineageMult × legacyRateMult` only. This is the one place achievements differ from lineage
  (which also scales legacy income); it is the deliberate cost of "one documented hook".
- **Sticky and idempotent.** `evaluateAchievements` fires met + not-done rows, marks them done,
  and returns the ids; a non-monotonic metric (`children`) later dropping does not un-earn.
- **Live-only.** Evaluation runs at the end of `tick`, after the `offline` early-return, so an
  offline catch-up grants none (no offline log spam; `applyOffline` totals unchanged).
- **Data-driven roster.** `src/config/achievements.ts` is a leaf; `src/achievements.ts` is pure
  logic over a narrow `AchievementInput` reusing the milestone `METRICS`/`MetricInput` layer
  (achievements → milestones is the only import direction). No new metric, no new currency.

## Alternatives considered

- **Bake `achievementMult` into `baseCyclesPerSec`** — rejected: `doFork` snapshots that value
  into legacy rates, so `tick` would apply the multiplier again — the exact double-count the
  lineage-free snapshot exists to avoid.
- **Apply the multiplier to legacy daemons too (mirror lineage fully)** — rejected: that is a
  second income hook and weakens the "one documented hook" acceptance.
- **Reuse `milestonesDone`/`unlocks` for achievements** — rejected: conflates content gates with
  numeric rewards, and `unlocks` is open-ended, so it cannot be roster-rebuilt/sanitized the way
  a bounded achievement record can.
- **Add a `legacy` metric** — rejected: the six existing metrics already cover the roster; a new
  reader is unjustified.
- **Make `mult` a `Decimal`** — rejected: the roster is tiny and `mult` is a fraction; the
  product is promoted to `Decimal` when it enters the income path, so a plain number is enough.
- **A spendable achievement currency** — rejected: achievements are permanent passive
  multipliers; a second currency overlaps the perk tree.

## Consequences

- **Positive:** one documented income hook; the legacy snapshot stays clean and double-count-free;
  the roster is data-tunable and sanitized on load; earned achievements persist additively.
- **Negative:** legacy-daemon income does not benefit from achievements, unlike lineage. The
  online/offline equivalence claim (doc [003](../architecture/003-persistence.md)) holds only
  with `achievementsDone` held equal, since the grant is live-only.
- **Persistence:** `achievementsDone` is additive, so `SAVE_VERSION` 6 → 7 is a staged no-op
  (`if (from < 7)`); `sanitizeAchievements` rebuilds the record from the roster.
- **Follow-ups:** roster thresholds and 1–5% magnitudes are first-pass data. If legacy income
  should later share the achievement multiplier, that is a new ADR superseding this one.

See [`docs/architecture/011-achievements.md`](../architecture/011-achievements.md) for the
current contract.
