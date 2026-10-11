# 005 — Tooling and Tests

The build/lint/test toolchain and the TDD setup. See
[ADR 0002](../decisions/0002-lint-and-test-toolchain.md) for why Vite+ was chosen.

## Toolchain

**Vite+** (`vite-plus@1.1.0`, the `vp` CLI) is the single tool for dev, build, test, lint,
and format. Dependencies are managed with npm.

| Command            | Does                                   |
| ------------------ | -------------------------------------- |
| `vp dev`           | Dev server (Vite core)                 |
| `vp build`         | Production bundle                      |
| `vp test run`      | Vitest, single run                     |
| `vp lint`          | oxlint, type-aware via oxlint-tsgolint |
| `vp fmt . --write` | oxfmt                                  |

`vite` is aliased to `@voidzero-dev/vite-plus-core@1.1.0` (with a matching `overrides`
entry) so `vp` resolves its bundled core. Run `vp install` after dependency changes to keep
the alias aligned; `vp migrate` is the tool that establishes this setup.

## Configuration

All tool config lives in `vite.config.ts`:

- `lint` — oxlint plugins, categories, ignore patterns, and
  `options: { typeAware: true, typeCheck: true }` (the Go type-aware pass).
- `fmt` — oxfmt ignore patterns.
- `test` — Vitest `include` (`src/**/*.{test,spec}.ts`) and `environment: 'node'`.

Formatting exclusions are also listed in `.oxfmtignore`.

## Tests

Tests are colocated as `src/*.test.ts` and import from **`vite-plus/test`** (not `vitest`).

`src/sim.test.ts` covers the pure simulation: bootstrap income, per-tier cost curves (each
tier's own `costGrowth`) and upgrade cost curves, spawn gating (cycles + RAM), cross-tier
synergy, the cleanup sweep (priority order and `nice`) plus the sweep directive roster (one
test per directive — `standard`, `sigkill`, `scavenger`, `group-kill`, `backpressure` — with
`standard` reproducing the original sweep exactly), directive scheduling (escalation pool
membership, seeded determinism, no back-to-back repeat, advance-with-an-empty-table, and the
corrupt-id fallback), heat/cooling, SIGTERM shields, `estimateVictims`, the memory leak and
`gc`, the OOM killer, prestige, and big-number range. `src/diagnostics.test.ts` covers the
watchdog rules.

### Writing a sim test

The sim is pure, so tests need no DOM and no mocks: build a state with `newGame()`, set the
fields a scenario needs, call a function or `tick`, and assert on the state. Watch the RAM
cap — a large child count triggers the OOM killer and will corrupt unrelated assertions
(set `ramCap` high to isolate sweep/income behavior).

## Contract

- A behavior change adds or updates a test in `src/sim.test.ts` (see `AGENTS.md`).
- `npm run check` (typecheck + lint + test) is the pre-commit gate.
