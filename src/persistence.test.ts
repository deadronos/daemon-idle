import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import {
  MAX_SANE_COUNT,
  applyOffline,
  decode,
  encode,
  loadFrom,
  sanitizePerks,
  sanitizeMilestones,
  sanitizeUnlocks,
} from "./persistence";
import { BASE, BASE_OFFLINE_CAP_S, SAVE_VERSION, newGame, tick } from "./sim";

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

  it("caps a huge sweepsSurvived to MAX_SANE_COUNT", () => {
    expect(decode('{"sweepsSurvived":1e15}').sweepsSurvived).toBe(MAX_SANE_COUNT);
  });

  it("treats a non-object JSON value as an empty save (never throws)", () => {
    for (const raw of ["null", "42", '"nope"', "true"]) {
      expect(() => decode(raw)).not.toThrow();
      const s = decode(raw);
      expect(s.counts).toEqual([0, 0, 0, 0, 0]);
      expect(s.saveVersion).toBe(SAVE_VERSION);
    }
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

describe("save versioning", () => {
  it("stamps a fresh game at SAVE_VERSION and round-trips it", () => {
    expect(newGame().saveVersion).toBe(SAVE_VERSION);
    expect(decode(encode(newGame())).saveVersion).toBe(SAVE_VERSION);
  });

  it("migrates a version-less save's legacy rates by dividing out the baked lineage", () => {
    // Old `doFork` snapshotted `rawCyclesPerSec`, so the k-th daemon's rate carried a
    // `1 + k*0.1` factor that `tick` now applies again. decode() must undo it.
    const raw = JSON.stringify({
      legacy: [
        { name: "legacy-1", rate: "22", crashed: false, respawn: 0 },
        { name: "legacy-2", rate: "33", crashed: false, respawn: 0 },
        { name: "legacy-3", rate: "44", crashed: false, respawn: 0 },
      ],
    });
    const s = decode(raw);
    expect(s.saveVersion).toBe(SAVE_VERSION);
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(22 / 1, 5);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33 / 1.1, 5);
    expect(s.legacy[2].rate.toNumber()).toBeCloseTo(44 / 1.2, 5);
  });

  it("leaves a SAVE_VERSION save's legacy rates untouched", () => {
    const g = newGame();
    g.legacy = [
      { name: "legacy-1", rate: d(22), crashed: false, respawn: 0 },
      { name: "legacy-2", rate: d(33), crashed: false, respawn: 0 },
    ];
    const s = decode(encode(g));
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(22, 5);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33, 5);
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

  it("caps offline at the base cap", () => {
    const now = 10_000_000_000;
    const g = newGame();
    g.lastSave = 1; // non-zero old stamp, so the gap is real (not masked by a `|| now`)
    const s = loadFrom(encode(g), now);
    expect(s.playtime).toBeGreaterThan(0);
    expect(s.playtime).toBeLessThanOrEqual(BASE_OFFLINE_CAP_S + 1);
  });

  it("never runs the OOM killer while offline", () => {
    const s = newGame();
    s.counts = [0, 0, 0, 0, 10]; // 10 cron daemons = 160MB, far over the 16MB cap
    s.ramCap = 16;
    applyOffline(s, 10);
    expect(s.oomCount).toBe(0);
    expect(s.counts[4]).toBe(10);
  });

  it("bounds the offline leak at the RAM cap so returning does not wipe the board", () => {
    const s = newGame();
    s.counts = [0, 5, 0, 0, 0]; // 10 MB leak-prone footprint
    s.ramCap = 1000;
    s.gc = 0; // no auto-flush: the leak would grow without bound if offline let it
    applyOffline(s, 8 * 3600);
    expect(s.leak).toBeLessThanOrEqual(s.ramCap);
    expect(s.leak).toBeCloseTo(s.ramCap, 5); // it did reach the cap
    tick(s, 0.01); // first live tick must not OOM the board away
    expect(s.oomCount).toBe(0);
    expect(s.counts).toEqual([0, 5, 0, 0, 0]);
  });
});

describe("perk persistence", () => {
  it("round-trips the new fields", () => {
    const s = newGame();
    s.lineage = 12;
    s.perks = { spin: 1, pipeline: 4 };
    s.runBaseEarned = d(1e6);
    s.runStartPlaytime = 123;
    const out = decode(encode(s));
    expect(out.lineage).toBe(12);
    expect(out.perks).toEqual({ spin: 1, pipeline: 4 });
    expect(out.runBaseEarned.toNumber()).toBe(1e6);
    expect(out.runStartPlaytime).toBe(123);
  });

  it("sanitizes corrupt perks without throwing", () => {
    expect(sanitizePerks({ spin: 99, pipeline: 3.7, ghost: 5, tailcall: "x" })).toEqual({
      spin: 1,
      pipeline: 3,
    });
    expect(sanitizePerks(null)).toEqual({});
    expect(sanitizePerks([1, 2])).toEqual({});
  });

  it("does NOT re-divide legacy rates for a v2 save under SAVE_VERSION 3", () => {
    // A v2 save's legacy rates are already lineage-free; re-dividing the k>=1 entry
    // would corrupt it. Only a pre-versioning save (no saveVersion) may be divided.
    const raw = JSON.stringify({
      saveVersion: 2,
      legacy: [
        { name: "legacy-1", rate: "22", crashed: false, respawn: 0 },
        { name: "legacy-2", rate: "33", crashed: false, respawn: 0 },
      ],
    });
    const s = decode(raw);
    expect(s.legacy[0].rate.toNumber()).toBeCloseTo(22, 5);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33, 5);
  });

  it("still divides baked lineage out of a pre-versioning save", () => {
    const raw = JSON.stringify({
      legacy: [
        { name: "legacy-1", rate: "22", crashed: false, respawn: 0 },
        { name: "legacy-2", rate: "33", crashed: false, respawn: 0 },
      ],
    });
    const s = decode(raw);
    expect(s.legacy[1].rate.toNumber()).toBeCloseTo(33 / 1.1, 5);
  });
});

describe("offline progress with perks", () => {
  it("applies perk income multipliers during offline catch-up", () => {
    const perked = newGame();
    perked.perks = { spin: 1 }; // +10% income
    const plain = newGame();
    applyOffline(perked, 60);
    applyOffline(plain, 60);
    expect(plain.cycles.toNumber()).toBeCloseTo(60, 3); // root 1/s
    expect(perked.cycles.toNumber()).toBeCloseTo(66, 3); // 1.1/s
  });
});

describe("milestone persistence", () => {
  it("round-trips the two records", () => {
    const s = newGame();
    s.milestonesDone = { "first-blood": true };
    s.unlocks = { nice: true, "auto-nice": true };
    const out = decode(encode(s));
    expect(out.milestonesDone).toEqual({ "first-blood": true });
    expect(out.unlocks).toEqual({ nice: true, "auto-nice": true });
  });
  it("drops unknown milestone ids and garbage unlocks", () => {
    expect(
      sanitizeMilestones({ "first-blood": true, ghost: true, "grown-up": false }),
    ).toEqual({ "first-blood": true });
    expect(sanitizeMilestones(null)).toEqual({});
    expect(sanitizeUnlocks({ nice: true, bad: false, zero: 0 })).toEqual({ nice: true });
    expect(sanitizeUnlocks([1, 2])).toEqual({});
    expect(sanitizeUnlocks("x")).toEqual({});
  });
  it("loads a pre-version save with empty records", () => {
    const s = decode('{"cycles":"0","totalEarned":"0"}');
    expect(s.milestonesDone).toEqual({});
    expect(s.unlocks).toEqual({});
    expect(s.saveVersion).toBe(SAVE_VERSION);
  });
});

describe("sanitizeUnlocks cap", () => {
  it("caps the number of unlock keys kept", () => {
    const raw: Record<string, true> = {};
    for (let i = 0; i < 300; i++) raw[`u${i}`] = true;
    expect(Object.keys(sanitizeUnlocks(raw)).length).toBe(256);
  });
});

describe("buyMax persistence", () => {
  it("round-trips and coerces a corrupt value to boolean", () => {
    const s = newGame();
    s.buyMax = true;
    expect(decode(encode(s)).buyMax).toBe(true);
    expect(decode('{"buyMax":"nope"}').buyMax).toBe(true); // truthy
    expect(decode("{}").buyMax).toBe(false);
  });
});

describe("automation persistence", () => {
  it("round-trips the fields and coerces/clamps corrupt values", () => {
    const s = newGame();
    s.autoNice = true;
    s.autoFree = true;
    s.freeThreshold = 40;
    const out = decode(encode(s));
    expect(out.autoNice).toBe(true);
    expect(out.autoFree).toBe(true);
    expect(out.freeThreshold).toBe(40);
    expect(decode('{"autoMalloc":1,"freeThreshold":-5}').autoMalloc).toBe(true);
    expect(decode('{"freeThreshold":-5}').freeThreshold).toBe(0);
    expect(decode("{}").freeThreshold).toBe(16);
  });
});

describe("offlineCap persistence", () => {
  it("round-trips and coerces the level", () => {
    const s = newGame();
    s.offlineCap = 3;
    expect(decode(encode(s)).offlineCap).toBe(3);
    expect(decode('{"offlineCap":-2}').offlineCap).toBe(0);
    expect(decode("{}").offlineCap).toBe(0);
  });
});

describe("applyOffline cap and equivalence", () => {
  it("never simulates more than offlineCapS seconds", () => {
    const s = newGame();
    const before = s.playtime;
    applyOffline(s, 100 * 3600); // 100h requested, base cap 8h
    expect(s.playtime - before).toBeLessThanOrEqual(BASE_OFFLINE_CAP_S + 1);
  });

  it("matches an online run in the safe regime (no sweep, RAM under cap)", () => {
    const online = newGame();
    const offline = newGame();
    for (const s of [online, offline]) {
      s.cycles = d(1e6);
      s.counts = [4, 0, 0, 0, 0];
      s.sweepTimer = 1e9; // no sweep fires within N seconds
    }
    const N = 600;
    for (let t = 0; t < N; t++) tick(online, 1);
    applyOffline(offline, N);
    expect(offline.totalEarned.toNumber()).toBeCloseTo(online.totalEarned.toNumber(), 0);
  });

  it("stays within tolerance with a legacy daemon", () => {
    const online = newGame();
    const offline = newGame();
    for (const s of [online, offline]) {
      s.ramCap = 200; // room for the children, so no OOM in either run
      s.sweepTimer = 1e9;
      s.gc = 5; // auto-respawn, so crashes are transient
      s.counts = [0, 0, 0, 0, 4]; // children income dominates the small legacy share
      s.legacy = [{ name: "legacy-1", rate: d(100), crashed: false, respawn: 0 }];
    }
    const N = 3600;
    for (let t = 0; t < N; t++) tick(online, 1);
    applyOffline(offline, N);
    const a = online.totalEarned.toNumber();
    const b = offline.totalEarned.toNumber();
    expect(Math.abs(a - b) / a).toBeLessThan(0.02);
  });

  it("does not advance sweepsSurvived offline (non-punishing retained)", () => {
    const s = newGame();
    s.counts = [4, 0, 0, 0, 0];
    applyOffline(s, 600); // > the 60s sweep interval
    expect(s.sweepsSurvived).toBe(0);
  });
});
