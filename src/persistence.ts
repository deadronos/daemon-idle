// Persistence boundary for `daemon` — pure, DOM-free.
//
// Encoding, decoding, and the offline catch-up live here so they stay testable in
// node (main.ts runs DOM code at module top level). `decode` is deliberately
// defensive: saves are user-local and long-lived, so every field is coerced to a
// finite, sane value before it reaches the simulation.

import { d, Decimal } from "./bignum";
import { MILESTONES } from "./config/milestones";
import { fmt, fmtTime } from "./format";
import {
  type GameState,
  type LegacyDaemon,
  BASE,
  SAVE_VERSION,
  TIERS,
  log,
  newGame,
  sanitizeSacrificeOrder,
  tick,
} from "./sim";

export const OFFLINE_CAP_S = 8 * 3600;
const OFFLINE_MIN_S = 5;

/** A finite number, else `fallback`. Rejects strings, `NaN`, and `±Infinity`. */
export function coerceFinite(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A non-negative integer count: `max(0, floor(coerceFinite(v, 0)))`. */
export function coerceCount(v: unknown): number {
  return Math.max(0, Math.floor(coerceFinite(v, 0)));
}

/** A finite Decimal from a number, numeric string, or Decimal; else `fallback`. */
export function coerceDecimal(v: unknown, fallback: Decimal): Decimal {
  if (v instanceof Decimal) return v.isFinite() ? v : fallback;
  if (typeof v === "number") return Number.isFinite(v) ? d(v) : fallback;
  if (typeof v === "string") {
    const parsed = d(v);
    return parsed.isFinite() ? parsed : fallback;
  }
  return fallback;
}

/**
 * Upper bound on a sanitized tier count. Far above anything reachable in play, but
 * finite — a hand-edited count like `1e9` would otherwise let `runOom` churn.
 */
export const MAX_SANE_COUNT = 1_000_000;

/** One sanitized count per tier; a non-array (or short array) becomes zeros. */
export function sanitizeCounts(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  return TIERS.map((_, i) => Math.min(MAX_SANE_COUNT, coerceCount(arr[i])));
}

/** Legacy daemons: drop non-objects, coerce name/rate/crashed/respawn. */
export function sanitizeLegacy(raw: unknown): LegacyDaemon[] {
  if (!Array.isArray(raw)) return [];
  const out: LegacyDaemon[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const l = entry as { name?: unknown; rate?: unknown; crashed?: unknown; respawn?: unknown };
    out.push({
      name: typeof l.name === "string" ? l.name : "legacy",
      rate: coerceDecimal(l.rate, d(0)),
      crashed: Boolean(l.crashed),
      respawn: coerceCount(l.respawn),
    });
  }
  return out;
}

/**
 * Milestones that have fired: keep only ids present in `MILESTONES` whose value is truthy;
 * a non-object yields `{}`. Rebuilt from the roster, so stale ids never survive.
 */
export function sanitizeMilestones(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const m of MILESTONES) if (rec[m.id]) out[m.id] = true;
  return out;
}

/**
 * Unlock ids: keep string keys with a truthy value, capped at `MAX_UNLOCKS`. Open-ended on
 * purpose (later issues add ids), so this is deliberately NOT restricted to the current
 * `UNLOCK` registry.
 */
export const MAX_UNLOCKS = 256;
export function sanitizeUnlocks(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  let n = 0;
  for (const key of Object.keys(rec)) {
    if (!rec[key]) continue;
    out[key] = true;
    if (++n >= MAX_UNLOCKS) break;
  }
  return out;
}

/**
 * Clamp every bounded numeric field of `s` in place. This is what stops a corrupt
 * save from soft-locking: `sweepInterval` can never be 0 (the `render()` ÷0), `ramCap`
 * never below `BASE.ramCap` (the OOM soft-lock), and no field can stay `NaN`/`Infinity`.
 */
export function sanitizeNumericState(s: GameState): void {
  s.ramCap = Math.max(BASE.ramCap, coerceFinite(s.ramCap, BASE.ramCap));
  s.leak = Math.max(0, coerceFinite(s.leak, 0));
  s.heat = Math.min(100, Math.max(0, coerceFinite(s.heat, 0)));
  s.cooling = coerceCount(s.cooling);
  s.nice = coerceCount(s.nice);
  s.shields = coerceCount(s.shields);
  s.gc = coerceCount(s.gc);
  s.forks = coerceCount(s.forks);
  s.sweepsSurvived = Math.min(MAX_SANE_COUNT, coerceCount(s.sweepsSurvived));
  s.oomCount = coerceCount(s.oomCount);
  s.playtime = Math.max(0, coerceFinite(s.playtime, 0));
  s.sweepInterval = Math.max(1, coerceFinite(s.sweepInterval, BASE.sweepInterval));
  s.sweepTimer = Math.min(
    s.sweepInterval,
    Math.max(0, coerceFinite(s.sweepTimer, s.sweepInterval)),
  );
  s.rngState = coerceFinite(s.rngState, 1) | 0 || 1;
  s.ramWarned = Boolean(s.ramWarned);
  s.lastSave = coerceFinite(s.lastSave, Date.now());
  s.counts = sanitizeCounts(s.counts);
}

/** Serialize a `GameState` to JSON; `Decimal` fields become strings. */
export function encode(s: GameState): string {
  return JSON.stringify({
    ...s,
    cycles: s.cycles.toString(),
    totalEarned: s.totalEarned.toString(),
    legacy: s.legacy.map((l) => ({ ...l, rate: l.rate.toString() })),
  });
}

/**
 * Parse a save, merging over fresh defaults, then coerce every field. Throws only if
 * `raw` is not valid JSON (callers fail closed to `newGame()`). A non-object JSON value
 * (`null`, a number, a string) decodes to a fresh game rather than throwing.
 */
export function decode(raw: string): GameState {
  const parsedRaw = JSON.parse(raw) as unknown;
  const parsed = (
    parsedRaw && typeof parsedRaw === "object" ? parsedRaw : {}
  ) as Partial<GameState>;
  const s: GameState = { ...newGame(), ...parsed };
  s.cycles = coerceDecimal(parsed.cycles, d(0));
  s.totalEarned = coerceDecimal(parsed.totalEarned, d(0));
  s.legacy = sanitizeLegacy(parsed.legacy);
  s.milestonesDone = sanitizeMilestones(parsed.milestonesDone);
  s.unlocks = sanitizeUnlocks(parsed.unlocks);
  s.buyMax = Boolean(parsed.buyMax);
  // Staged migrations, each keyed to the version it upgrades *from* (never a single
  // `saveVersion < SAVE_VERSION` check, which would re-run older steps on newer saves).
  const from = coerceFinite(parsed.saveVersion, 0);
  if (from < 2) {
    // Pre-versioning saves have lineage baked into each legacy `rate` (the old `doFork`
    // snapshotted `rawCyclesPerSec`), and `tick` now applies lineage again — so divide the
    // baked factor back out, keyed by the daemon's lineage index `k`.
    s.legacy.forEach((dm, k) => {
      dm.rate = dm.rate.div(d(1 + k * 0.1));
    });
  }
  // from < 3: the milestone records are additive only — newGame() defaults already filled
  // them and the rosters rebuild them, so there is nothing else to migrate.
  // from < 4: `buyMax` is additive too — newGame() defaults it to false.
  s.saveVersion = SAVE_VERSION;
  s.log = Array.isArray(s.log) ? s.log.map(String) : [];
  s.sacrificeOrder = sanitizeSacrificeOrder(s.sacrificeOrder);
  sanitizeNumericState(s);
  return s;
}

/** Simulate an offline gap in 1-second steps, then log the cycles gained. */
export function applyOffline(s: GameState, seconds: number): void {
  const before = s.cycles;
  let remaining = seconds;
  while (remaining > 0) {
    const dt = Math.min(1, remaining);
    tick(s, dt, { offline: true });
    remaining -= dt;
  }
  log(s, `offline ${fmtTime(seconds)}: +${fmt(s.cycles.sub(before))} cycles`);
}

/**
 * Decode a raw save and apply offline progress for the elapsed gap (capped at
 * `OFFLINE_CAP_S`, skipped below `OFFLINE_MIN_S`), then stamp `lastSave = now` so a
 * crash before the next save cannot re-apply the same window.
 */
export function loadFrom(raw: string, now: number): GameState {
  const s = decode(raw);
  // A real timestamp is always positive; a missing, invalid, or non-positive stamp
  // falls back to `now` (no gap).
  const last = Number.isFinite(s.lastSave) && s.lastSave > 0 ? s.lastSave : now;
  const elapsed = Math.min(OFFLINE_CAP_S, (now - last) / 1000);
  if (elapsed > OFFLINE_MIN_S) applyOffline(s, elapsed);
  s.lastSave = now;
  return s;
}
