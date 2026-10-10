# daemon

An idle game about surviving your own success.

You are a background process nobody meant to keep running. Spawn children to farm
**cycles** while you idle — but every child eats RAM, and the system periodically runs a
**cleanup sweep** that reaps your lowest-priority processes. Balance growth against
footprint, survive the sweeps, and fork your way from stray process to `init`.

Design intent: [`IDEA.md`](./IDEA.md). Architecture: [`docs/architecture/`](./docs/architecture/README.md).

## Development

Toolchain is [Vite+](https://viteplus.dev) (`vp`): one CLI for the dev server, build,
Vitest tests, and oxlint/oxfmt lint+format. Dependencies are managed with npm.

```bash
npm install
npm run dev       # dev server → http://127.0.0.1:5173
npm run test      # Vitest (src/sim.test.ts)
npm run test:watch
npm run lint      # oxlint (type-aware)
npm run format    # oxfmt
npm run check     # typecheck + lint + test
npm run build     # production bundle → dist/
npm run preview
```

## Controls

- **spawn** — buy children. Each tier costs more the more you own (`1.15^n`).
- **nice** — every level reduces how many processes the sweep reaps.
- **malloc** — raise the RAM ceiling.
- **free()** — flush leaked memory to zero (manual, free).
- **gc** — auto-flush leak every tick; level 2+ keeps leak near zero.
- **fork** — prestige. Adds a permanent lineage multiplier and a legacy daemon that
  keeps producing in the background (and occasionally segfaults).
- Click a **crashed legacy daemon** to restart it (or buy `gc` to auto-respawn).

Progress autosaves to `localStorage` and applies offline gains on return (capped at 8h).

## Status

v0 — playable loop: cycles, tiers, sweeps, RAM leak + OOM killer, one prestige layer,
offline progress, terminal log. Covered by a Vitest suite over the pure simulation.
Numbers are plain JS doubles with suffix formatting; swap in `break_infinity.js` if the
late game needs the precision.

## Stack

TypeScript 7 + Vite+ (`vp`: Vite, Vitest, oxlint, oxfmt). No runtime dependencies, no
backend.

## License

MIT — see [LICENSE](./LICENSE).
