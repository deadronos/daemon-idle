# `daemon` — an idle game about surviving your own success

> You are a background process nobody meant to keep running.

## The Pitch

An incremental/idle game where you spawn child processes to farm **cycles** while you
idle — and then have to keep them alive. Scaling is not free: every child eats RAM, and
the system periodically runs a **cleanup sweep** that kills your lowest-priority
processes. The whole game is the tension between _growing the herd_ and _not getting
reaped_.

Classic number-go-up at the surface, survival-management underneath. The theme is IT
ops, the humor is in the log lines, and the arc has a real payoff: you start as a
stray process and end as `init`.

## Why this, why now

- Idle games live or die on one fresh mechanic. Here it's the **kill sweep** — a
  recurring threat that makes "more children" a genuinely risky decision instead of a
  no-brainer purchase.
- The theme writes its own jokes: stack traces, segfault counters, "PID 1337 exited
  unexpectedly", OOM-killer as a boss.
- Technically cheap to build: a tick loop, a big-number library, and a fake terminal.
  Great fit for a TypeScript hobby prototype.

## Core Loop

1. **Earn cycles.** A single root process generates a trickle of cycles per second.
2. **Spawn children.** Children generate cycles too — faster and cheaper the further you
   progress. More children = steeper exponential curve.
3. **Spend cycles.** Upgrades: faster children, cheaper children, more RAM, higher
   process priority, better sweep-resistance.
4. **Survive.** RAM is finite. Over-allocate and you invite the sweep (and eventually
   the OOM killer). Balance growth against footprint.

The decision every player faces on a loop: _do I spawn one more child, or save RAM for
the next sweep?_

## The Twist — Cleanup Sweeps

- On an interval (faster/more brutal as you progress), the **supervisor** wakes up and
  kills processes, lowest-priority first.
- Priority is an upgradeable stat. The sweep takes a fixed **budget** of victims; high
  priority means you're picked last.
- **Memory pressure** is the second axis: total footprint vs. available RAM. Exceed it
  and the **OOM killer** takes a big bite — usually your best children — and costs you a
  chunk of progress.
- Result: two knobs to tune (priority, footprint) instead of one. This is the strategic
  meat.

## Prestige — Fork

- When you're reaped (or when you choose to), you **fork**: start a new instance with a
  small **permanent multiplier** based on how far you got.
- Your previous instances stay alive as **legacy daemons** in the background. They keep
  producing a fraction of their old output — and they _occasionally crash_, needing a
  manual nudge (or an automation upgrade) to restart. Gentle active-play flavor.
- Multiple forks stack; the multiplier compounds.

## The Arc

`process → service → daemon → init`

- **Process:** fragile, reaped constantly. Learn the loop.
- **Service:** stable enough to ignore for minutes at a time. Real idle territory.
- **Daemon:** detached, resilient, running for hours. Prestige layers kick in.
- **init:** endgame. _You_ are the supervisor. You set the sweep rules and decide what
  lives and dies — the thing that used to hunt you.

## Mechanics Detail

### Resources

- **Cycles** — primary currency (spend on children & upgrades).
- **RAM** — capacity constraint (spawn cost + upkeep).
- **Priority** — sweep resistance (upgradeable).
- **Lineage** — prestige points; permanent multipliers.

### Numbers (first pass)

- Root: `1 cycle/s`. Child tier _n_: cost grows geometrically (~`1.15^n`), output grows
  linearly, and per-tier payback is **flat-to-improving** (100 / 100 / 83 / 67 / 50 s) so
  cheap spam no longer wins.
- Income also carries a **global multiplier that compounds ×1.05 per sweep survived** — the
  exponential engine. It is a `Decimal`, so it never overflows however long you idle.
- Sweep interval: starts at 60s, shrinks toward the 10s floor as sweeps survived rises
  (escalation is now real), softened by priority upgrades.
- Sweep budget: `k` victims where `k` grows with tier; victims = lowest priority, ties
  broken by newest PID.
- OOM trigger: footprint > RAM → kills the top-3 output children + 10% cycle penalty.

### Upgrades (examples)

- `fork() +1` — spawn a basic child.
- `nice(5)` — +priority to all children.
- `malloc(+16MB)` — raise RAM ceiling.
- `SIGTERM handler` — children survive one sweep each.
- `cron()` — auto-respawn legacy daemons on crash.
- `noop loop` — flat passive cycles, no upkeep (early safety net).

## Tech Stack

- **Language:** TypeScript.
- **Rendering:** web (Vite + a tiny reactive layer; canvas or DOM — a fake terminal look
  is the whole aesthetic).
- **Big numbers:** `break_infinity.js` or `decimal.js` for the exponential late game.
- **State:** plain object + reducer; the tick loop is `requestAnimationFrame` with a
  fixed-step accumulator. Save to `localStorage` (JSON), with offline progress on load.
- **No backend** for v0. Deterministic sim = easy to test.

## MVP Scope (v0)

Ship this and it's playable:

- [ ] Tick loop + cycles + spawn a child.
- [ ] 3–4 child tiers with scaling cost/output.
- [ ] Cleanup sweep on an interval, priority-based victim selection.
- [ ] RAM cap + OOM-killer penalty.
- [ ] One prestige layer (fork → multiplier).
- [ ] Save/load + offline progress.
- [ ] Fake-terminal log feed for flavor.

## Milestones

1. **M1 — Loop:** cycles tick, one child type, one upgrade. Feels like something.
2. **M2 — Threat:** sweeps + priority + RAM/OOM. Now it's a _game_.
3. **M3 — Meta:** prestige, legacy daemons, offline progress.
4. **M4 — Arc:** init endgame, flavor pass, balancing.
5. **M5 — Polish:** sound, achievements, export/import saves.

## Open Questions

- Should the sweep be **deterministic** (plan around it) or **randomized** (panic)?
  Lean deterministic with a visible countdown — readable tension beats surprise.
- Active-play ceiling: how much manual nudging is fun before `cron()` automates it?
- Do legacy daemons give _cycles_ or a _separate_ passive resource that feeds upgrades?
- Balancing the risk dial so "greedy" is viable but never dominant.

---

_Started: 2026-10-10. Status: idea. Next step: v0 tick loop + sweep math._
