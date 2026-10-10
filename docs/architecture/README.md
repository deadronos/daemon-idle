# Architecture Docs — `daemon`

Living architecture documentation for the `daemon` idle game. These describe **how the
game is built today**, and they are expected to change as the code changes.

## The lockstep rule

Implementation and architecture docs move together:

- **Changing behavior?** Update the code **and** the relevant doc in the same change.
- **New subsystem?** Add the next numbered doc (`00N-<name>.md`) and register it below.
- **Removing a subsystem?** Delete or rewrite its doc; never leave a doc describing code
  that no longer exists.

A change is not done until the docs match the code. See [`../../AGENTS.md`](../../AGENTS.md).

## What these are NOT

These are **living docs**, not ADRs. An ADR is an immutable record of a single decision,
frozen once accepted and superseded by a later ADR. That audit trail lives in
[`../decisions/`](../decisions/README.md) (`NNNN-title.md`, append-only) — do not try to
make these files immutable, and do not try to make ADRs track the current state. Pick one
purpose per file.

## Index

| Doc                                                                      | Covers                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [`000-base-game-architecture.md`](./000-base-game-architecture.md)       | Whole-game overview, stack, module map, data flow, glossary       |
| [`001-simulation-core.md`](./001-simulation-core.md)                     | `src/sim.ts` — state, tick order, tiers, income, sweeps, leak/OOM |
| [`002-render-system.md`](./002-render-system.md)                         | `src/main.ts` — loop, render cadence, DOM, buttons, meters        |
| [`003-persistence.md`](./003-persistence.md)                             | Save/load, autosave, offline progress, save-shape guards          |
| [`004-prestige-and-legacy.md`](./004-prestige-and-legacy.md)             | `fork()`, lineage multiplier, legacy daemons                      |
| [`005-tooling-and-tests.md`](./005-tooling-and-tests.md)                 | Vite+ toolchain, commands, tests, lint/format config              |
| [`006-diagnostics-and-reporting.md`](./006-diagnostics-and-reporting.md) | Numeric watchdog: detection, alert routing, sinks                 |
| [`007-deployment.md`](./007-deployment.md)                               | GitHub Pages deployment: pipeline, triggers, base path            |

## Conventions

- **Numbering:** `NNN-kebab-case-title.md`, three digits, zero-padded, monotonic. Numbers
  are stable ids — never renumber. New subsystems take the next free number.
- **One subsystem per doc.** If a doc outgrows one subsystem, split it and register both.
- **State the contract, not the code.** Describe the rule and why, plus the exact numbers
  that matter (cost curves, intervals, caps). Point at the file; don't paste it.
- **Keep the index above in sync** when adding or removing a doc.
