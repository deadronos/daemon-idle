import { describe, expect, it } from "vite-plus/test";
import { decode, encode } from "./persistence";
import { BASE, newGame } from "./sim";

describe("decode — save hardening", () => {
  it("round-trips a healthy save", () => {
    const s = decode(encode(newGame()));
    expect(s.cycles.eq(0)).toBe(true);
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
