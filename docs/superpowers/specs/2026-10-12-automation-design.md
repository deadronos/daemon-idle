# Auto-Nice / Auto-Malloc / Auto-Free — Design

- **Issue:** #19 (Epic #6, Phase B)
- **Date:** 2026-10-12
- **Status:** Approved (design) — pending implementation
- **Depends on:** #17 (milestone gating) — stacked on `feat/18-buymax` → `feat/17-milestones`

## Context

`nice`, `malloc`, and `free()` are manual forever. Once the board is large, keeping it healthy
is a clicking chore, not a decision — exactly the late-game tedium #18's bulk-spawn addresses
for spawning. #19 makes each of the three **earned** and **independently toggleable**, run
inside `tick` deterministically, and never over-spending.

#19 is the "earned automation" the Phase B exit criteria call for ("late-game tedium is
handled by earned automation").

## Goals

- Add three toggles — `auto-nice`, `auto-malloc`, `auto-free` — gated by #17 milestones, each
  running inside `tick`.
- Add one `hands-off` milestone granting all three unlock ids at once.
- Add a configurable leak threshold for `auto-free` (the "configurable level" the issue names).
- Keep the automation deterministic, at most once per action per tick, and never over-spending.

## Non-goals

- A cycles **reserve** (deliberate: "buy when affordable", no buffer) — a possible later tweak.
- Automating **spawning** (that is #18's toggle) or any other upgrade.
- Running automation during offline catch-up.
- Auto-respawning legacy daemons (that is #20).

## Decisions (from the design dialogue)

1. **Policy:** affordability-driven for `auto-nice`/`auto-malloc`; a **configurable leak
   threshold** for `auto-free`.
2. **No reserve** — automation buys whenever `cycles` affords it.
3. **One milestone** (`hands-off`) grants all three ids; the three toggles stay independent.
4. **Placement:** an `automation` group at the top of the **upgrades** panel.

## Design

### Milestone

`MILESTONES` gains one row (the dependent issue authors its own row on #17's forward ids):

| id          | name      | metric  | `at` | unlocks                                 |
| ----------- | --------- | ------- | ---- | --------------------------------------- |
| `hands-off` | hands-off | `forks` | 1    | `auto-nice`, `auto-malloc`, `auto-free` |

Automation arrives once you've prestiged. `UNLOCK` already declares all three ids (from #17).

### State and persistence

| Field           | Type    | Meaning                                  | Default | On `doFork` |
| --------------- | ------- | ---------------------------------------- | ------- | ----------- |
| `autoNice`      | boolean | Auto-buy `nice` when affordable.         | `false` | preserved   |
| `autoMalloc`    | boolean | Auto-buy `malloc` when affordable.       | `false` | preserved   |
| `autoFree`      | boolean | Auto-`free()` the leak at the threshold. | `false` | preserved   |
| `freeThreshold` | number  | Leak MB at which auto-free fires.        | `16`    | preserved   |

- The three booleans are **toggle preferences**; the capability is `hasUnlock(s, "auto-nice" |
  "auto-malloc" | "auto-free")`. A corrupt save with a toggle on but no unlock does nothing —
  the sim gate checks the unlock.
- `freeThreshold` is the configurable level; coerced with `coerceFinite` and clamped `>= 0`.
- `SAVE_VERSION` bumps (4 → 5 on this stack) with an additive staged no-op step.

### Automation in `tick`

The automation block runs **after the offline early-return and before the sweep step (6)**.
That placement is deliberate: it is live-only; auto-`nice` lands before `runSweep` (reducing
this tick's victims); auto-`malloc` raises the cap before the OOM check (step 8); auto-`free`
clears the leak before both.

Fixed intra-tick order, **each at most once per tick**, deterministic (no RNG):

```
if (hasUnlock(s, UNLOCK.autoFree)   && s.autoFree   && s.leak >= s.freeThreshold) freeMemory(s);
if (hasUnlock(s, UNLOCK.autoMalloc) && s.autoMalloc && s.cycles.gte(mallocCost(s))) buyMalloc(s);
if (hasUnlock(s, UNLOCK.autoNice)   && s.autoNice   && s.cycles.gte(niceCost(s)))   buyNice(s);
```

- `auto-free` first: it costs nothing, so it never competes for `cycles`.
- `buyNice` itself requires the `nice` milestone (`first-blood`), so `auto-nice` needs both
  unlocks; likewise `auto-malloc` needs only `hands-off` (malloc is ungated).
- Every action re-checks affordability, so automation can never over-spend. Buying at most one
  level of each per tick bounds the spend rate.

### UI (`src/main.ts`, `index.html`, `src/style.css`)

An `automation` group at the top of the **upgrades** panel, rendered only once
`hasUnlock(state, UNLOCK.autoNice)`:

- three checkboxes — `auto-nice`, `auto-malloc`, `auto-free` — bound to `state.autoNice` /
  `autoMalloc` / `autoFree`;
- a small number input (`leak ≥ <n> MB`) bound to `state.freeThreshold`.

Toggling or editing updates state and re-renders. The group is hidden until unlocked (and, like
the buy-max toggle, must use a `[hidden]`-safe style so the attribute is not defeated).

## Testing

- Each automation buys only when **toggled ∧ unlocked ∧ affordable**; does nothing when any of
  those is false.
- Runs **at most once per tick** (two consecutive ticks buy at most two levels, not a burst).
- `auto-free` fires exactly at `leak >= freeThreshold` and not below; a threshold of `0` fires
  whenever there is any leak.
- Automation **does not run** on `{ offline: true }` ticks.
- Automation never drives `cycles` negative (assert after a tick that spends).
- The `hands-off` milestone fires at `forks >= 1` and grants all three ids.
- The four fields round-trip; a corrupt save coerces the booleans and clamps `freeThreshold >= 0`.

## Docs impact (lockstep)

- `docs/architecture/001-simulation-core.md` — the automation block in the tick order, the four
  state rows, and the `nice`/`malloc`/`free` interaction.
- `docs/architecture/002-render-system.md` — the automation group.
- `docs/architecture/010-milestones.md` — the `hands-off` row.
- No new architecture doc or ADR: this extends existing systems.

## Risks / open questions

- **No reserve.** Enabling automation can drain the bank needed for spawning. The player steers
  with the toggles; if playtesting shows starvation, add a reserve (a later, additive change).
- **`freeThreshold` default 16 MB** and the `forks >= 1` gate are first-pass data.
- **Intra-tick order** matters when `cycles` are scarce (free → malloc → nice). It is fixed and
  documented; changing it changes which upgrade wins a tight tick.
- **Consolidation.** This branch stacks on #18 → #17; the `SAVE_VERSION` step becomes `< 5`. The
  Phase B integration merge resolves the numbering (and #22's `ramCapTotal`).

## Alternatives considered

- **Fixed thresholds for all three** — rejected: the issue names a _configurable_ level for
  auto-free.
- **Full per-upgrade config** — rejected as YAGNI; one threshold is enough.
- **Three (or two) milestones** — rejected in favor of one `hands-off` gate; independence lives
  in the toggles, not the gating.
- **A cycles reserve** — rejected for this issue (decision 2); revisit if automation starves the
  board.
- **Automating in the offline path** — rejected: offline stays simple and un-punishing, and
  milestones already do not fire offline.
