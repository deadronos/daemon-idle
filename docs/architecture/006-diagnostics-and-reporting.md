# 006 — Diagnostics and Reporting

A numeric watchdog: detect values that pass a type boundary or turn invalid, and route the
alerts to the right audience. Design rationale in
[ADR 0004](../decisions/0004-numeric-watchdog-and-diagnostics.md).

## Two modules

| File                 | Role                                          | Purity                |
| -------------------- | --------------------------------------------- | --------------------- |
| `src/diagnostics.ts` | Detect — `checkNumericHealth(state): Alert[]` | Pure (no DOM/console) |
| `src/report.ts`      | Route — `makeReporter(sinks)` + sinks         | Impure sinks          |

This split follows the doc-000 rule: detection is pure and testable; surfacing is the
shell's job.

## `Alert`

```ts
interface Alert {
  level: "info" | "warn" | "error";
  audience: "dev" | "player"; // dev = design canary; player = gameplay-facing
  code: string; // stable id, used for de-duplication
  message: string;
  context?: Record<string, string | number>;
}
```

## Rules (`checkNumericHealth`)

Unbounded **Decimal** values (`cycles`, `totalEarned`, `cyclesPerSec`, `topTierCost`, each
legacy rate):

- `NaN` → `error`, `player`.
- non-finite → `error`, `player`.
- `> RUNAWAY` (1e100) → `warn`, `dev`.

Bounded **number** values (`ramUsed`, `leak`, `playtime`, `sweepTimer`, `heat`, `cooling`,
`shields`, `ramCap`, `forks`, and each `counts[i]`):

- non-finite → `error`, `player`.
- `> Number.MAX_SAFE_INTEGER` → `warn`, `dev`.

Each `counts` entry is checked with its index in the code: `numeric.nan.counts.N` (for
example `numeric.nan.counts.2`).

After the bignum migration, "value exceeds double precision" is **not** an alert — large
Decimals are expected. See ADR 0003.

## Wiring (in `main.ts`)

- Sinks: `consoleSink` (all), `logFeedSink` (player → in-game log), plus a HUD banner
  rendered from the current player-audience alerts.
- Cadence: every `WATCHDOG_MS` (1 s) inside the frame loop.
- De-duplication: report only alerts whose `code` was not active last run, so an ongoing
  condition logs once and clears when resolved.

## Testing

`src/diagnostics.test.ts` covers the pure rules (quiet on a healthy state, NaN/Infinity
errors, the runaway warn, and no false positive on a large-but-sane value). The shell wiring
is verified in a browser: poisoning `window.daemon.cycles` with NaN shows the banner, the
log line, and a console error.
