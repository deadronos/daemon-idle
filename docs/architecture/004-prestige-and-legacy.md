# 004 — Prestige and Legacy Daemons

The meta-layer: `fork()` resets the working set and leaves behind permanent boosts. Rules
live in `src/sim.ts`; the panel is rendered in `src/main.ts`.

## `fork()` — prestige

- **Gate:** `canFork(s)` is true when `totalEarned >= forkCost`, where
  `forkCost = 1e6 * 10^forks`. The lifetime total, not the current balance, is what counts.
- **On fork:**
  1. Capture `peak = rawCyclesPerSec(s)` (children + root, at current lineage,
     unthrottled so heat is not baked into the legacy rate).
  2. Increment `forks`; push a legacy daemon with
     `rate = max(0.1, peak * LEGACY_SHARE)` where `LEGACY_SHARE = 0.1`.
  3. **Reset the working set:** `cycles = 0`, `counts = zeros`, `leak = 0`,
     `ramCap = BASE.ramCap`, `heat = 0`, `cooling = 0`, `shields = 0`, `nice = 0`,
     `gc = 0`, `sweepTimer = BASE.sweepInterval`.
  4. **Keep:** `totalEarned`, `forks`, `legacy`, `playtime`, log.

## Lineage multiplier

```
lineageMult = 1 + forks * 0.1
```

Applied to _all_ income — children, the root baseline, and legacy daemons. Shown in the
HUD as `×N.N`. This is the only permanent numeric carry-over.

## Legacy daemons

Each fork adds one `LegacyDaemon { name, rate, crashed, respawn }`, named `legacy-N`.

- **Produce:** while alive, contribute `rate * dt * lineageMult` cycles/s.
- **Crash:** each second there is a `LEGACY_CRASH_CHANCE = 0.002` chance to crash
  (per daemon; implemented as `1 - exp(-0.002 * dt)`). On crash, `respawn = 10`.
- **Respawn:** if `gc > 0`, a crashed daemon auto-restarts when its respawn timer expires.
  Otherwise it stays down until the player clicks it (`nudgeDaemon`).

Legacy daemons are the active-play hook of the meta-layer: without `gc` you occasionally
have to click a crashed row in the panel to bring it back.

## Design notes

- The legacy `rate` is a snapshot of peak income at fork time, so forking _earlier_ with
  less income leaves a weaker permanent daemon — an intentional "build before you fork"
  pressure.
- `rate` is floored at 0.1 so a very early fork still yields a (tiny) producer.
- Legacy daemons are **not** affected by sweeps or RAM — they are outside the process
  table, which is what makes them permanent.

## UI

`renderLegacy()` in `main.ts` shows each daemon with its live rate, marks crashed ones in
red with "click to restart", and wires the click to `nudgeDaemon`. The empty state reads
"none yet — fork to leave one behind".
