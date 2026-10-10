const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc", "UDc", "DDc"];

/**
 * Format a number for the terminal UI. Small numbers stay readable; large ones get
 * suffix notation and eventually scientific notation.
 */
export function fmt(n: number, digits = 2): string {
  if (!isFinite(n)) return n > 0 ? "∞" : "-∞";
  if (n < 0) return "-" + fmt(-n, digits);
  if (n < 1000) {
    if (n === 0) return "0";
    if (n < 10 && n !== Math.floor(n)) return n.toFixed(Math.min(digits, 2));
    return Math.floor(n).toString();
  }
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIXES.length) return n.toExponential(digits);
  const scaled = n / Math.pow(10, tier * 3);
  const str = scaled.toFixed(digits);
  return `${str}${SUFFIXES[tier]}`;
}

export function fmtInt(n: number): string {
  return fmt(Math.floor(n), 0);
}

export function fmtRate(n: number): string {
  return `${fmt(n)}/s`;
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
