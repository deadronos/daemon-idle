# 000 — Base Game Architecture

Top-level shape of `daemon`: what it is, how the pieces fit, and how a frame flows
through the system. Read this first; the numbered docs that follow drill into one
subsystem each.

## What the game is

An idle/incremental game. The player is a background process spawning child processes to
farm **cycles** while idle, and must keep them alive through periodic **cleanup sweeps**
and **memory pressure**. See [`../../IDEA.md`](../../IDEA.md) for the design intent.

## Stack

- **TypeScript**, strict mode (`tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`).
- **Vite+** (`vp`: Vite, Vitest, oxlint, oxfmt) for dev, build, test, lint, and format.
  No runtime dependencies, no backend.
- **Plain DOM + CSS** for rendering (no framework). Terminal aesthetic in `src/style.css`.
- Unbounded values are `Decimal` from `break_eternity.js` via `src/bignum.ts`; bounded
  values stay plain `number`. See [ADR 0003](../decisions/0003-bignum-break-eternity.md).

## Module map

| File                 | Responsibility                                                                |
| -------------------- | ----------------------------------------------------------------------------- |
| `src/sim.ts`         | **The simulation.** Pure state + functions. No DOM, no timers, deterministic. |
| `src/bignum.ts`      | **Numeric boundary.** Re-exports the big-number library (break_eternity.js).  |
| `src/diagnostics.ts` | **Numeric watchdog.** Pure `checkNumericHealth(state)` → alerts.              |
| `src/report.ts`      | **Alert routing.** Reporter + pluggable sinks (console, log feed).            |
| `src/main.ts`        | **The shell.** Boot, loop, persistence, DOM, rendering, watchdog cadence.     |
| `src/format.ts`      | Value/time formatting for display only.                                       |
| `index.html`         | Static structure with fixed element ids that `main.ts` binds to.              |
| `src/style.css`      | All styling.                                                                  |

## The one architectural rule

**`sim.ts` never touches the DOM, timers, storage, or randomness outside `tick`.** It is a
pure-ish state machine: you hand it a `GameState` and a `dt`, it mutates the state. This
keeps the game logic testable headlessly and keeps presentation entirely in `main.ts`.

`main.ts` owns everything impure: `requestAnimationFrame`, `localStorage`, event
listeners, and DOM writes. When adding a mechanic, put the _rules_ in `sim.ts` and the
_plumbing_ in `main.ts`.

## Data flow

```
requestAnimationFrame (main.ts)
  └─ fixed-step accumulator, 50ms steps
       └─ tick(state, dt)          [sim.ts]  ← mutates state
  └─ render()                      [main.ts] ← reads state, writes DOM
  └─ save() every 10s + on unload  [main.ts] ← serializes state
```

Nothing else drives state. All player actions are functions in `sim.ts` (`spawn`,
`buyNice`, `buyMalloc`, `buyGc`, `freeMemory`, `doFork`, `nudgeDaemon`) called from button
handlers in `main.ts`, each followed by a `render(true)`.

## Boot sequence (`main.ts`)

1. `load()` reads the save (or `newGame()`), applies offline progress if applicable.
2. Build spawn buttons (one per tier) and upgrade buttons into their panels.
3. Bind `beforeunload` and `visibilitychange` to `save()`.
4. Start `requestAnimationFrame(frame)`.
5. Expose `window.daemon = state` for console debugging.

## Glossary

| Term                | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| **cycles**          | Primary currency.                                                             |
| **child / process** | A spawned unit that produces cycles and consumes RAM.                         |
| **tier**            | One of five child types (`noop loop` … `cron daemon`).                        |
| **footprint**       | RAM held by children.                                                         |
| **leak**            | RAM that grows over time on top of the footprint; reclaimed by `free()`/`gc`. |
| **sweep**           | Periodic reap of the lowest-priority processes.                               |
| **OOM killer**      | Fires when RAM used exceeds the cap; kills the highest-output children.       |
| **lineage**         | Permanent multiplier earned by forking.                                       |
| **legacy daemon**   | A background producer left behind by a fork.                                  |

## Related docs

- Simulation rules and numbers → [`001-simulation-core.md`](./001-simulation-core.md)
- Rendering and the loop → [`002-render-system.md`](./002-render-system.md)
- Saving and offline progress → [`003-persistence.md`](./003-persistence.md)
- Prestige → [`004-prestige-and-legacy.md`](./004-prestige-and-legacy.md)
