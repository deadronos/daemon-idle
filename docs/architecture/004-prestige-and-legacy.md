# 004 — Prestige and Legacy Daemons

The meta-layer: `fork()` resets the working set and leaves behind permanent boosts. Rules
live in `src/sim.ts`; the panel is rendered in `src/main.ts`. The perk tree that also hangs
off `fork()` has its own doc — [009 — Prestige Perk Tree](./009-prestige-perk-tree.md).

## `fork()` — prestige

- **Gate:** `canFork(s)` is true when `totalEarned >= forkCost`, where
  `forkCost = 1e6 * 10^forks * forkCostMult`. The lifetime total, not the current balance,
  is what counts. `forkCostMult` is the `cheapfork` perk's reduction, floored at
  `FORK_COST_FLOOR = 0.25`.
- **On fork:**
  1. **Award lineage points** — `s.lineage += min(MAX_POINTS_PER_FORK,
     floor(pointsForFork(s) * pointsMult))`. The depth formula is in
     [doc 009](./009-prestige-perk-tree.md). This runs **before** the reset, so it measures
     the run you just played.
  2. Capture `peak = baseCyclesPerSec(s)` (children × `survivalMult`, plus root,
     **lineage-free**, unthrottled, and **perk-free** — so neither the lineage multiplier,
     heat, nor income perks are baked into the legacy rate; the compounded `survivalMult`
     **is**, which is what makes a late fork leave a strong daemon. Lineage and perks are
     applied per tick, below).
  3. Increment `forks`; push a legacy daemon with
     `rate = max(0.1, peak * LEGACY_SHARE)` where `LEGACY_SHARE = 0.1`.
  4. **Reset the working set:** `counts = zeros`, `leak = 0`, `ramCap = BASE.ramCap`,
     `heat = 0`, `cooling = 0`, `nice = 0`, `gc = 0`, `sweepTimer = BASE.sweepInterval`.
     Two reset values now come from perks: `cycles = startCycles` (the `startup` warm start)
     and `shields = startShieldsAdd` (the `sigblock` signal mask).
  5. **Snapshot the run:** `runBaseEarned = totalEarned`, `runStartPlaytime = playtime`
     (the bases for the next fork's depth score).
  6. **Keep:** `totalEarned`, `forks`, `legacy`, `lineage`, `perks`, `playtime`, `log`, and
     `sweepsSurvived` (so the new instance inherits both the escalated sweep cadence and the
     compounded `survivalMult`).

## Lineage multiplier

```
lineageMult = 1 + forks * 0.1
```

Applied to _all_ income — children, the root baseline, and legacy daemons. Shown in the
HUD as `×N.N`. Alongside the global `survivalMult` (which persists across a fork because
`sweepsSurvived` is kept), these are the permanent numeric carry-overs. **This flat
multiplier is unchanged by the perk tree** — the tree layers targeted modifiers on top
(doc 009).

## Legacy daemons

Each fork adds one `LegacyDaemon { name, rate, crashed, respawn }`, named `legacy-N`.

- **Produce:** while alive, contribute `rate * legacyRateMult * lineageMult * dt` cycles/s.
  `rate` is the fork-time snapshot (children × `survivalMult` + root), so lineage and the
  `cache` perk's `legacyRateMult` are applied exactly once here and the compounded survival
  multiplier is inherited at fork time.
- **Crash:** each second there is a `LEGACY_CRASH_CHANCE = 0.002` chance to crash
  (per daemon; implemented as `1 - exp(-0.002 * dt)`). On crash, `respawn = 10`.
- **Respawn:** if `gc > 0`, a crashed daemon auto-restarts when its respawn timer expires.
  Otherwise it stays down until the player clicks it (`nudgeDaemon`).

Legacy daemons are the active-play hook of the meta-layer: without `gc` you occasionally
have to click a crashed row in the panel to bring it back.

## Design notes

- The legacy `rate` is a snapshot of peak income at fork time, so forking _earlier_ with
  less income leaves a weaker permanent daemon — an intentional "build before you fork"
  pressure. Income **perks** are deliberately excluded from the snapshot, so the tree cannot
  retroactively inflate old daemons; only `cache` (`legacyRateMult`) touches them, applied at
  tick.
- `rate` is floored at 0.1 so a very early fork still yields a (tiny) producer.
- Legacy daemons are **not** affected by sweeps or RAM — they are outside the process
  table, which is what makes them permanent.

## UI

`renderLegacy()` in `main.ts` shows each daemon with its live rate, marks crashed ones in
red with "click to restart", and wires the click to `nudgeDaemon`. The empty state reads
"none yet — fork to leave one behind". The perk panel (`renderPerks`) is separate — see
[doc 002](./002-render-system.md).
