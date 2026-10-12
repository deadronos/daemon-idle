# 002 — Render System (`src/main.ts`)

How the game is drawn and driven. Everything impure lives here: the frame loop, DOM
wiring, and rendering.

## Frame loop

`requestAnimationFrame` drives a **fixed-step accumulator**:

```
TICK_MS = 50                    // simulation step
acc += min(1000, now - last)    // clamp to avoid a huge catch-up burst
while (acc >= TICK_MS):
    tick(state, TICK_MS / 1000)
    acc -= TICK_MS
render()
```

The clamp caps a single frame's catch-up at 1 second so a backgrounded tab does not
tumble hundreds of steps at once on return (offline progress handles long gaps — doc 003).

## Render cadence

`render()` runs every frame and writes the HUD, meters, and buttons from `state`. It is
idempotent — it reads state and reflects it. Called with `render(true)` (force) right
after a player action, so the UI updates before the next frame.

Three cheap diffs avoid needless DOM churn:

- **Log:** rebuilt only when the joined log string changes (`lastLogSig`).
- **Legacy list:** rows rebuilt only when the `name:crashed` signature changes
  (`legacyPanel.dataset.sig`); live rates are refreshed in place each frame.
- **Sacrifice order:** rows rebuilt only when the joined `sacrificeOrder` changes
  (`priorityPanel.dataset.sig`).
- **Prestige panel:** node buttons rebuilt only when lineage or the owned perks change
  (`perkPanel.dataset.sig`); the next-fork preview is refreshed each frame.

## DOM binding

`index.html` defines fixed element ids; `main.ts` grabs them once via a typed `$` helper
that throws on a missing id. If you add a HUD element, add the id in `index.html` and the
reference in the `el` map.

## Buttons

Both panels share an `ActionButton` shape:

```ts
{ el, name(): string, cost(): Decimal, enabled(): boolean, run(): void }
```

- **Spawn buttons** are built once from `TIERS`. Each shows `count · cost` and is disabled
  when `canSpawn` is false; a `⚠ ram` suffix appears when the tier would exceed the RAM cap.
- **Upgrade buttons** are registered via `addUpgrade(...)` with closures over the current
  state, so labels and affordability track live state. The panel covers `free()`, `nice`,
  `malloc`, `SIGTERM handler`, `gc`, `cooling`, and `fork()`; the `cooling` button labels
  the current level, costs `coolCost(state)`, and runs `buyCooling(state)` — it is disabled
  while `state.cycles` is below the cost.

`enabled()` gates the button; `run()` performs the action; both call back into `sim.ts`.
Cost text is tinted green (`.ok`) when affordable. The `nice` and `gc` buttons render disabled
with a `🔒 <milestone name>` hint until their milestone fires (see
[doc 010](./010-milestones.md)) — the lock is a sim rule, so `enabled()` checks `hasUnlock`.

The spawn panel also has a **`buy max` toggle** (`#buyMaxToggle`), shown only once
`hasUnlock(state, "buy-max")`. While it is on, a spawn click calls `spawnMax` (buy the maximum
affordable units) instead of `spawn`, and the cost line gains a `×max` marker; the preference is
the persisted `state.buyMax`.

The upgrades panel has an **`automation` group** (`#autoWrap`), shown only once
`hasUnlock(state, "auto-nice")`: three checkboxes (`auto-nice`, `auto-malloc`, `auto-free`) bound
to `state.autoNice`/`autoMalloc`/`autoFree`, plus a number input for `state.freeThreshold`. The
group uses a `[hidden]`-safe rule (`.automation[hidden] { display: none }`) so the attribute is
not defeated by the flex layout.

## Sacrifice order panel

The `sacrifice order` panel (`#priorityPanel`) lists `state.sacrificeOrder` top-to-bottom,
where the top row is reaped first. Each row shows the tier name plus `▲`/`▼` buttons that
call `movePriority(state, tier, -1 | 1)` and re-render; `▲` is disabled on the first row and
`▼` on the last. Rows are rebuilt only when the joined order changes
(`priorityPanel.dataset.sig`). A `.hint` caption explains that only priority-based sweeps
honour this order — scavenger and group-kill ignore it. The panel never reorders state
itself; `main.ts` delegates the swap to `sim.ts`.

## Prestige panel

The `prestige` panel (`#perkSection`) is hidden until `forks >= 1` (the first fork creates
claimable points). `renderPerks()` builds three columns — `growth | survival | lineage` —
from `PERKS`, ordered within a branch by prerequisite depth. Each node is an `ActionButton`
line showing the name, current level, next cost (`perkCost`), and effect; it is disabled
unless `canBuyPerk` is true, and clicking it calls `buyPerk` and re-renders. The header shows
`lineage: N pt` and a `next fork grants ≈ P pt` preview
(`floor(pointsForFork(state) * perkMods(state).pointsMult)`). Node buttons are rebuilt only
when lineage or the owned perks change (`perkPanel.dataset.sig`); the preview text updates
every frame. See [doc 009](./009-prestige-perk-tree.md) for the tree itself.

## Milestones panel

The `milestones` panel (`#milestonePanel`) lists `MILESTONES` pending-first by
`milestoneProgress` descending, then achieved ones dimmed below. Each row shows the name,
description, and — for a pending goal — a progress bar and `value / at`; an achieved goal
shows `✓ unlocked: <ids>`. Rows are rebuilt only when the `milestonesDone` + `unlocks`
signature changes (`milestonePanel.dataset.sig`); the progress numbers refresh each frame.
Rows are never interactive (milestones fire from state, not clicks). The locked `nice`/`gc`
buttons in the upgrades panel point at their milestone by name.

## Meters

- **RAM bar:** two segments — the child footprint (`ramBar`, green, turns red at >90% of
  cap) and the leak (`leakBar`, purple, offset to start where the footprint ends).
- **Sweep bar:** fill = `1 - sweepTimer / sweepInterval`; the label names the incoming
  sweep directive (`nextDirective`), the countdown, and the victim count for the next
  sweep. The count comes from `sim.ts`'s `estimateVictims(state)`, which mirrors
  `runSweep` (directive budget, then shield absorption) without mutating state, so the
  number matches the directive that will actually fire — including a non-standard one.
- **Heat bar:** fill = `heat` (0–100). The value reads `heat N / 100`; above
  `HEAT_THROTTLE_AT` both the value and the bar turn the danger color, signalling that
  income is being throttled (`heatMult`).
- **Shields readout:** `#shieldRow` shows `shields N` and is hidden while
  `state.shields <= 0`; charges absorb sweep victims before selection.

## Style

All presentation lives in `src/style.css` (CSS custom properties for the palette). The
layout is a two-column grid that collapses to one column under 760px. No inline styles
except the meter widths and the RAM and heat bars' danger color (the heat bar also tints
its value text), which are set per frame.

## Contract

- `main.ts` never computes game rules — it calls `sim.ts` and displays the result.
- Keep `render()` free of side effects on `state`.
