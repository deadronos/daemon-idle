import { d, type Num } from "./bignum";

const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc", "UDc", "DDc"];

/**
 * Format a value for the terminal UI. Small numbers stay readable; large ones get
 * suffix notation and eventually scientific notation.
 */
export function fmt(value: Num | number, digits = 2): string {
  const v = d(value);
  if (v.isNan()) return "NaN";
  if (!v.isFinite()) return v.sign < 0 ? "-∞" : "∞";
  if (v.sign < 0) return `-${fmt(v.neg(), digits)}`;
  if (v.eq(0)) return "0";

  if (v.lt(1000)) {
    const n = v.toNumber();
    if (n < 10 && n !== Math.floor(n)) return n.toFixed(Math.min(digits, 2));
    return Math.floor(n).toString();
  }

  const exp = Math.floor(v.log10().toNumber());
  const tier = Math.floor(exp / 3);
  if (tier >= SUFFIXES.length) {
    const mantissa = v.div(d(10).pow(exp)).toNumber();
    return `${mantissa.toFixed(digits)}e${exp}`;
  }
  const scaled = v.div(d(10).pow(tier * 3)).toNumber();
  return `${scaled.toFixed(digits)}${SUFFIXES[tier]}`;
}

export function fmtRate(value: Num | number): string {
  return `${fmt(value)}/s`;
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
