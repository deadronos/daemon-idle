# 0009 — Milestone gating model

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

Progression in `daemon` was purely affordability-gated: the only gate was `cycles`. There was
no way for content (automation, tiers) to *arrive as a reward*, and nothing for a player to
strive toward beyond larger numbers. The one escalation — sweep directives unlocking at
`sweepsSurvived` thresholds — is a hardcoded `unlockAt` field, not a general goal system.

Phase B needs a foundation that #18 (buy-max), #19 (auto-*), and #23 (tiers) gate through, and
that #21 (achievements) can sit beside. The question was the shape of the goal→reward model.

## Decision

Add a data-driven **milestone** system:

- **Goals are data.** A milestone is `{ metric, at, unlocks }` — one comparable metric against
  one threshold. Metrics live in a `METRICS` table (`totalEarned`, `sweepsSurvived`, `forks`,
  `playtime`, `children`, `ramCap`). No per-goal predicates.
- **Rewards are named unlock flags.** Firing a milestone writes string ids into persisted
  `unlocks`; features gate via `hasUnlock(s, id)`. Features are decoupled from milestone ids.
- **Milestones gate content, not numbers.** Multipliers are #21's (achievements); a milestone
  does not change income.
- **Sticky.** A fired milestone is recorded in `milestonesDone` and stays fired.
- **Evaluate once per live tick**, at the end of `tick`, after the offline early-return.
- **Ship real content now.** `nice` is gated behind `first-blood` (survive 1 sweep) and `gc`
  behind `grown-up` (24 MB ceiling); the forward ids (`buy-max`, `auto-*`, `tier:<n>`) are
  declared for the dependent issues to consume.
- **Layout mirrors the perk subsystem.** `src/config/milestones.ts` (data) +
  `src/milestones.ts` (pure logic over a narrow `MilestoneInput`) + `sim.ts` (state/tick/gates).

## Alternatives considered

- **Milestones also grant multipliers** — rejected: overlaps #21's micro-multipliers; keep
  "goals gate content, achievements nudge numbers".
- **A typed reward union** (`{ type: "unlock" | "multiplier" | … }`) — rejected as YAGNI: flags
  extend additively when #21 adds a multi-kind.
- **Per-milestone predicate/reward closures** — rejected: pushes logic into per-entry functions,
  unprovable as one aggregate, against the repo's declarative pattern.
- **Persist only `unlocks` and derive "done"** — rejected: `children` can decrease, so a derived
  state would flicker; an explicit sticky set is testable.
- **All in `sim.ts`** — rejected: inconsistent with the `config/` + subsystem shape #22
  established one change earlier.
- **Fold the sweep-directive `unlockAt` escalation into milestones** — out of scope: the
  directive pool is a deterministic, previewable draw, not a reward.

## Consequences

- **Positive:** goal-gated progression with a single gate API (`hasUnlock`); adding a goal, a
  metric, or an unlock id is data, not a branch; the machinery is ready for #18/#19/#23 and
  extends additively to #21.
- **Negative:** two new persisted records and a `SAVE_VERSION` bump to 3; gating `nice`/`gc`
  changes the first minutes of play (thresholds are data and retunable); `milestones.ts` reads a
  structural `MilestoneInput` rather than `GameState` to avoid a runtime cycle.
- **Follow-ups:** the later issues author their milestone rows on the forward ids; a
  `directivesSeen` metric was deferred (it would need `sim.ts` internals); the growing `sim.ts`
  is due for a deliberate split.

See [`docs/architecture/010-milestones.md`](../architecture/010-milestones.md) for the current
contract.
