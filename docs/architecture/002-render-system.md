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

Two cheap diffs avoid needless DOM churn:

- **Log:** rebuilt only when the joined log string changes (`lastLogSig`).
- **Legacy list:** rows rebuilt only when the `name:crashed` signature changes
  (`legacyPanel.dataset.sig`); live rates are refreshed in place each frame.

## DOM binding

`index.html` defines fixed element ids; `main.ts` grabs them once via a typed `$` helper
that throws on a missing id. If you add a HUD element, add the id in `index.html` and the
reference in the `el` map.

## Buttons

Both panels share an `ActionButton` shape:

```ts
{ el, name(): string, cost(): number, enabled(): boolean, run(): void }
```

- **Spawn buttons** are built once from `TIERS`. Each shows `count · cost` and is disabled
  when `canSpawn` is false; a `⚠ ram` suffix appears when the tier would exceed the RAM cap.
- **Upgrade buttons** are registered via `addUpgrade(...)` with closures over the current
  state, so labels and affordability track live state.

`enabled()` gates the button; `run()` performs the action; both call back into `sim.ts`.
Cost text is tinted green (`.ok`) when affordable.

## Meters

- **RAM bar:** two segments — the child footprint (`ramBar`, green, turns red at >90% of
  cap) and the leak (`leakBar`, purple, offset to start where the footprint ends).
- **Sweep bar:** fill = `1 - sweepTimer / sweepInterval`; the label shows the countdown and
  an estimate of victims for the next sweep (mirrors the severity math from doc 001).

## Style

All presentation lives in `src/style.css` (CSS custom properties for the palette). The
layout is a two-column grid that collapses to one column under 760px. No inline styles
except the meter widths and the RAM bar's danger color, which are set per frame.

## Contract

- `main.ts` never computes game rules — it calls `sim.ts` and displays the result.
- Keep `render()` free of side effects on `state`.
