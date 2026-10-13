import { describe, expect, it } from "vite-plus/test";
import { d } from "./bignum";
import { checkNumericHealth } from "./diagnostics";
import { newGame } from "./sim";

describe("checkNumericHealth", () => {
  it("is quiet for a healthy fresh game", () => {
    expect(checkNumericHealth(newGame())).toEqual([]);
  });

  it("flags NaN cycles as a player-facing error", () => {
    const s = newGame();
    s.cycles = d(Number.NaN);
    const nan = checkNumericHealth(s).find((a) => a.code === "numeric.nan.cycles");
    expect(nan?.level).toBe("error");
    expect(nan?.audience).toBe("player");
  });

  it("flags non-finite totals", () => {
    const s = newGame();
    s.totalEarned = d(Number.POSITIVE_INFINITY);
    expect(checkNumericHealth(s).some((a) => a.code === "numeric.infinite.totalEarned")).toBe(true);
  });

  it("warns (dev-only) when a value passes the runaway canary", () => {
    const s = newGame();
    s.cycles = d("1e120");
    const alert = checkNumericHealth(s).find((a) => a.code === "numeric.runaway.cycles");
    expect(alert?.level).toBe("warn");
    expect(alert?.audience).toBe("dev");
  });

  it("does not flag large-but-sane Decimals", () => {
    const s = newGame();
    s.cycles = d("1e30");
    s.totalEarned = d("1e30");
    expect(checkNumericHealth(s)).toEqual([]);
  });

  it("flags a non-finite heat as a player error", () => {
    const s = newGame();
    s.heat = Number.NaN;
    const heat = checkNumericHealth(s).find((a) => a.code === "numeric.nan.heat");
    expect(heat?.level).toBe("error");
    expect(heat?.audience).toBe("player");
  });

  it("flags non-finite cooling and shields", () => {
    const s = newGame();
    s.cooling = Number.POSITIVE_INFINITY;
    s.shields = Number.NaN;
    const codes = checkNumericHealth(s).map((a) => a.code);
    expect(codes).toContain("numeric.nan.cooling");
    expect(codes).toContain("numeric.nan.shields");
  });

  it("flags non-finite ramCap and forks", () => {
    const s = newGame();
    s.ramCap = Number.POSITIVE_INFINITY;
    s.forks = Number.NaN;
    const codes = checkNumericHealth(s).map((a) => a.code);
    expect(codes).toContain("numeric.nan.ramCap");
    expect(codes).toContain("numeric.nan.forks");
  });

  it("flags each non-finite counts entry", () => {
    const s = newGame();
    s.counts[0] = Number.NaN;
    s.counts[2] = Number.POSITIVE_INFINITY;
    const codes = checkNumericHealth(s).map((a) => a.code);
    expect(codes).toContain("numeric.nan.counts.0");
    expect(codes).toContain("numeric.nan.counts.2");
  });
});

describe("repeatables and the watchdog", () => {
  it("stays quiet at a high repeatable level", () => {
    const s = newGame();
    s.repeatables = { overclock: 1e6, swapfile: 1e6, undervolt: 1e6 };
    s.cycles = d(1e12);
    s.counts = [0, 0, 0, 0, 0, 0, 0];
    expect(checkNumericHealth(s)).toEqual([]);
  });
});
