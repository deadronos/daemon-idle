# Decision Records (ADRs) — `daemon`

Immutable records of **significant decisions**: what we chose, why, and what it costs.
This is the "why" layer. It is not a changelog (that is `git log`) and not a description
of current state (that is [`../architecture/`](../architecture/README.md)).

## The rule

**An ADR is immutable.** Once `Accepted`, its text is frozen.

- If the decision changes, write a **new** ADR that supersedes the old one, and set the old
  one's status to `Superseded by ADR-NNNN`. Do not edit the old ADR's decision.
- Update the **architecture doc** to describe the new state. Architecture = what _is_;
  ADRs = what we _chose_.

## What earns an ADR

Write one when a decision is **consequential** — a real trade-off, hard to reverse, or
something a future reader would ask "why is it like this?" about.

Do **not** write one for routine changes, bug fixes, or tweaks with an obvious single
answer. When in doubt, ask: "would a new contributor be confused or tempted to undo this
without the reasoning?" If no, skip it.

## Format

Use [`template.md`](./template.md). Keep it short: Context → Decision → Consequences, plus
the alternatives you rejected. Record the trade-off, not a story.

## Index

| ADR                                                   | Title                                    | Status   |
| ----------------------------------------------------- | ---------------------------------------- | -------- |
| [`0001`](./0001-root-baseline-income.md)              | Root baseline income for bootstrap       | Accepted |
| [`0002`](./0002-lint-and-test-toolchain.md)           | Lint and test toolchain (Vite+)          | Accepted |
| [`0003`](./0003-bignum-break-eternity.md)             | Big-number core (break_eternity.js)      | Accepted |
| [`0004`](./0004-numeric-watchdog-and-diagnostics.md)  | Numeric watchdog and diagnostics routing | Accepted |
| [`0005`](./0005-pages-deploy-on-tag.md)               | Deploy to GitHub Pages on release tags   | Accepted |
| [`0006`](./0006-sweep-directive-model.md)             | Sweep directive model                    | Accepted |
| [`0007`](./0007-player-controlled-sacrifice-order.md) | Player-controlled sacrifice order        | Accepted |

## Naming

`NNNN-kebab-case-title.md`, four digits, zero-padded, monotonic. Numbers are permanent
ids — never renumber, never reuse. Add each new ADR to the index above.
