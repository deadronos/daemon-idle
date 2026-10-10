# AGENTS.md — `daemon-idle`

Guidance for agents (and humans) working in this repo. Keep it short; put detail in the
architecture docs.

## What this is

`daemon` — an idle/incremental game in TypeScript + Vite. Design intent lives in
[`IDEA.md`](./IDEA.md); current architecture lives in
[`docs/architecture/`](./docs/architecture/README.md); significant decisions are recorded
in [`docs/decisions/`](./docs/decisions/README.md).

## Commands

```bash
npm install
npm run dev        # dev server on http://127.0.0.1:5173
npm run build      # tsc --noEmit + vite build
npm run typecheck  # types only
npm run preview    # serve the built bundle
```

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
  **not** edit the numbered architecture docs to be immutable. Living docs describe *what
  is*; ADRs record *what we chose and when*. Keep the two purposes in separate files.

If you touch game rules, the numbers in `001-simulation-core.md` must still be true when
you are done. If you touch the loop, DOM, or meters, check `002-render-system.md`. If you
touch saves, check `003-persistence.md`.

## Architecture in one line

`src/sim.ts` is pure game logic (no DOM, no timers, deterministic); `src/main.ts` is the
shell (loop, DOM, storage). Put rules in `sim.ts`, plumbing in `main.ts`. Details in
[`docs/architecture/000-base-game-architecture.md`](./docs/architecture/000-base-game-architecture.md).

## Verify before claiming done

1. `npm run build` — must pass typecheck.
2. For rule changes, exercise them headlessly (bundle `sim.ts` with esbuild and run a
   script that ticks and asserts), then confirm in the browser.
3. For UI changes, drive the dev server in a real browser and screenshot; report the
   values the UI shows. Localhost works with the browser tool
   (`browser.ssrfPolicy.allowedHostnames` includes `127.0.0.1`).

## Conventions

- TypeScript strict; `noUnusedLocals`/`noUnusedParameters` are on — no dead imports.
- All mutating sim actions return `boolean` (false = refused) so the UI can re-render.
- Add new persistent state fields with a sane default in `newGame()`; saves merge over
  defaults, so additive changes are safe (see doc 003).
- Prefer editing `sim.ts` over adding new files; split only when a real subsystem appears.
