# 0002 — Lint and test toolchain: Vite+

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The project needs "clean code" tooling and a TDD loop. TypeScript 7 is the native (Go)
compiler (`tsgo`); the `typescript-eslint` plugin that powers type-aware ESLint caps its
supported TypeScript at `<6.1.0`, so it cannot lint this project's TS 7. A sibling project
(SpaceAutoBattler) already runs VoidZero's Vite+ (`vp`) toolchain on TS 7.

Constraints:

- Linting must work against TS 7 (the Go compiler), including type-aware rules.
- Tests must cover the pure simulation in `src/sim.ts`.
- Prefer consistency with the sibling project over a bespoke stack.

## Decision

Adopt **Vite+** (`vite-plus@1.1.0`, the `vp` CLI) as the unified toolchain, mirroring
SpaceAutoBattler:

- `vite` is aliased to `@voidzero-dev/vite-plus-core@1.1.0` (with a matching `overrides`
  entry) so `vp build`/`vp dev` use the bundled core.
- Lint: **oxlint** via `vp lint`, with `options.typeAware`/`typeCheck` enabled — type-aware
  rules run through the Go-based **oxlint-tsgolint**, which is what makes TS 7 work.
- Format: **oxfmt** via `vp fmt`.
- Test: **Vitest** via `vp test`, importing from the `vite-plus/test` entry point.

Config lives in `vite.config.ts` (`lint`, `fmt`, and `test` blocks). Tests are colocated as
`src/*.test.ts`.

## Alternatives considered

- **Biome** — fast lint+format, but no real type-aware engine and inconsistent with the
  sibling project's toolchain.
- **ESLint + typescript-eslint** — rejected: peer range `typescript <6.1.0` cannot support
  TS 7 without downgrading TypeScript, which contradicts the modern-toolchain goal.
- **oxlint standalone** — the right linter, but without Vite+'s unified config, dev server,
  build, and test runner.

## Consequences

- **Positive:** one CLI (`vp`) for dev, build, test, lint, and format; type-aware linting
  works on TS 7; tooling matches SpaceAutoBattler, so procedures transfer between projects.
- **Negative:** npm needs the `vite` alias plus an `overrides` entry, because Vitest
  declares `peer vite ^6.4||^7||^8` and the aliased core reports version `1.1.0`, which does
  not satisfy that range numerically. `vp migrate` writes this setup and `vp install` keeps
  it aligned. Test files must import from `vite-plus/test`, not `vitest`.
- **Follow-ups:** if oxlint's rule set or tsgolint coverage proves insufficient, revisit —
  but do not reintroduce typescript-eslint while the project is on TS 7.
