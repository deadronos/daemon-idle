import { describe, expect, it } from "vite-plus/test";
import { MAX_SANE_COUNT, OFFLINE_CAP_S, applyOffline, decode, encode, loadFrom } from "./persistence";
import { BASE, newGame } from "./sim";

describe("decode — save hardening", () => {
  it("round-trips a healthy save", () => {
    const s = decode(encode(newGame()));
    expect(s.cycles.eq(0)).toBe(true);
    expect(s.totalEarned.eq(0)).toBe(true);
    expect(s.counts).toEqual([0, 0, 0, 0, 0]);
  });

  it("loads a corrupt save to a finite state and never throws", () => {
    const raw =
      '{"sweepInterval":0,"ramCap":-5,"heat":1e999,"nice":null,"shields":{},"cooling":[],"forks":"many","sweepTimer":"soon","playtime":-3,"leak":-9,"counts":["a",-1,2.7,null,1e999],"legacy":[null],"log":"nope"}';
    const s = decode(raw);
    expect(s.sweepInterval).toBeGreaterThanOrEqual(1);
    expect(s.ramCap).toBeGreaterThanOrEqual(BASE.ramCap);
    expect(s.heat).toBe(0);
    expect(Number.isFinite(s.sweepTimer)).toBe(true);
    expect(s.sweepTimer).toBeGreaterThanOrEqual(0);
    expect(s.sweepTimer).toBeLessThanOrEqual(s.sweepInterval);
    expect(s.playtime).toBe(0);
    expect(s.leak).toBe(0);
    expect(s.counts).toEqual([0, 0, 2, 0, 0]);
    expect(s.legacy).toEqual([]);
    expect(Array.isArray(s.log)).toBe(true);
  });

  it("clamps sweepInterval to at least 1", () => {
    expect(decode('{"sweepInterval":0}').sweepInterval).toBeGreaterThanOrEqual(1);
  });

  it("clamps a negative ramCap to BASE.ramCap", () => {
    expect(decode('{"ramCap":-5}').ramCap).toBe(BASE.ramCap);
  });

  it("resets a non-array counts to zeros", () => {
    expect(decode('{"counts":"nope"}').counts).toEqual([0, 0, 0, 0, 0]);
  });

  it("caps a huge finite count to MAX_SANE_COUNT", () => {
    const s = decode('{"counts":[1e9,0,0,0,0]}');
    expect(s.counts[0]).toBe(MAX_SANE_COUNT);
  });

  it("drops a null legacy entry and rejects a NaN rate", () => {
    const s = decode('{"legacy":[null,{"name":"x","rate":"NaN"}]}');
    expect(s.legacy).toHaveLength(1);
    expect(Number.isFinite(s.legacy[0].rate.toNumber())).toBe(true);
    expect(s.legacy[0].rate.toNumber()).toBe(0);
  });

  it("defaults missing numeric fields", () => {
    const s = decode("{}");
    const numbers = [
      s.ramCap,
      s.leak,
      s.heat,
      s.cooling,
      s.nice,
      s.shields,
      s.gc,
      s.forks,
      s.sweepTimer,
      s.sweepInterval,
      s.sweepsSurvived,
      s.rngState,
      s.oomCount,
      s.playtime,
      s.lastSave,
      ...s.counts,
    ];
    for (const n of numbers) expect(Number.isFinite(n)).toBe(true);
  });
});

describe("offline progress", () => {
  it("does not reap the process table while offline", () => {
    const s = newGame();
    s.counts = [0, 10, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepInterval = 1;
    s.sweepTimer = 1;
    applyOffline(s, 50);
    expect(s.counts[1]).toBe(10);
    expect(s.sweepsSurvived).toBe(0);
  });

  it("is monotonic in cycles over an offline gap", () => {
    const s = newGame();
    s.counts = [0, 10, 0, 0, 0];
    s.ramCap = 1000;
    s.sweepInterval = 1;
    s.sweepTimer = 1;
    const before = s.cycles;
    applyOffline(s, 3600);
    expect(s.cycles.gt(before)).toBe(true);
  });

  it("loadFrom applies offline and stamps lastSave", () => {
    const now = 1_000_000_000;
    const g = newGame();
    g.lastSave = now - 3.6e6; // one hour ago
    const s = loadFrom(encode(g), now);
    expect(s.lastSave).toBe(now);
    expect(s.playtime).toBeGreaterThan(0);
  });

  it("does not double-apply the same offline window", () => {
    const now = 1_000_000_000;
    const g = newGame();
    g.lastSave = now - 3.6e6;
    const first = loadFrom(encode(g), now);
    const again = loadFrom(encode(first), now);
    expect(again.cycles.eq(first.cycles)).toBe(true);
    expect(again.playtime).toBe(first.playtime);
  });

  it("caps offline at OFFLINE_CAP_S", () => {
    const now = 10_000_000_000;
    const g = newGame();
    g.lastSave = 1; // non-zero old stamp, so the gap is real (not masked by a `|| now`)
    const s = loadFrom(encode(g), now);
    expect(s.playtime).toBeGreaterThan(0);
    expect(s.playtime).toBeLessThanOrEqual(OFFLINE_CAP_S + 1);
  });

  it("never runs the OOM killer while offline", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 10]; // 10 cron daemons = 160MB, far over the 16MB cap
    s.ramCap = 16;
    applyOffline(s, 10);
    expect(s.oomCount).toBe(0);
    expect(s.counts[4]).toBe(10);
  });
});
