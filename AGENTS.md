# AGENTS.md — `daemon-idle`

Guidance for agents (and humans) working in this repo. Keep it short; put detail in the
architecture docs.

## What this is

`daemon` — an idle/incremental game in TypeScript + Vite. Design intent lives in
[`IDEA.md`](./IDEA.md); current architecture lives in
[`docs/architecture/`](./docs/architecture/README.md); significant decisions are recorded
in [`docs/decisions/`](./docs/decisions/README.md).

## Commands

Vite+ (`vp`) is the unified toolchain: dev server, build, Vitest tests, and
oxlint/oxfmt lint+format. Dependencies are managed with npm.

```bash
npm install
npm run dev        # vp dev — dev server on http://127.0.0.1:5173
npm run build      # vp run typecheck && vp build
npm run test       # vp test run
npm run lint       # vp lint (type-aware via oxlint-tsgolint)
npm run lint:fix   # vp lint --fix
npm run format     # vp fmt . --write
npm run check      # typecheck + lint + format check + test
```

## Workflow

**Issues → branch → PR.** `main` is the integration branch; changes land through a pull
request, not a direct push.

1. **Issue** — open or find the issue that describes the change.
2. **Branch** — a short-lived branch off `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
3. **PR** — open a PR into `main`, reference the issue, run `npm run check`, then
   squash-merge to keep `main` linear.

Mark baseline states with tags (e.g. `v0.0.1-initial-scaffold`).

## The docs lockstep rule (important)

**Code and architecture docs change together. A change is not done until they match.**

- **Changing behavior?** Update the implementation **and** the relevant
  `docs/architecture/00N-*.md` in the same change.
- **New subsystem?** Add the next numbered doc (`docs/architecture/00N-kebab-title.md`)
  and register it in the index in `docs/architecture/README.md`.
- **Removing a subsystem?** Delete or rewrite its doc. Never leave a doc describing code
  that no longer exists.
- **Design decision worth remembering?** Add an immutable, append-only record under
  [`docs/decisions/`](./docs/decisions/README.md) (`NNNN-title.md`, four digits) — do
  **not** edit the numbered architecture docs to be immutable. Living docs describe _what
  is_; ADRs record _what we chose and when_. Keep the two purposes in separate files.

If you touch game rules, the numbers in `001-simulation-core.md` must still be true when
you are done. If you touch the loop, DOM, or meters, check `002-render-system.md`. If you
touch saves, check `003-persistence.md`.

## Architecture in one line

`src/sim.ts` is pure game logic (no DOM, no timers, deterministic); `src/main.ts` is the
shell (loop, DOM, storage, watchdog cadence). Unbounded values are `Decimal`s from
`src/bignum.ts` — never import the big-number library directly. `src/diagnostics.ts` is
pure numeric health checks; route its alerts through `src/report.ts` sinks. Put rules in
`sim.ts`, plumbing in `main.ts`. Details in
[`docs/architecture/000-base-game-architecture.md`](./docs/architecture/000-base-game-architecture.md).

## Verify before claiming done

1. `npm run check` — typecheck + lint + tests must all pass.
2. For rule changes, add or update a test in `src/*.test.ts` (the sim is pure, so cover
   it there), then confirm in the browser.
3. For UI changes, drive the dev server in a real browser and screenshot; report the
   values the UI shows. Localhost works with the browser tool
   (`browser.ssrfPolicy.allowedHostnames` includes `127.0.0.1`).

## Conventions

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` are on — no dead imports.
- All mutating sim actions return `boolean` (false = refused) so the UI can re-render.
- Add new persistent state fields with a sane default in `newGame()`; saves merge over
  defaults, so additive changes are safe (see doc 003).
- Prefer editing `sim.ts` over adding new files; split only when a real subsystem appears.
