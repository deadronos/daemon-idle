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
});
