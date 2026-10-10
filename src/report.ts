// Alert routing. A tiny reporter fans Alerts out to pluggable sinks — no event bus.
// One producer (diagnostics) and a few consumers (console, log feed, UI banner).

import type { Alert } from "./diagnostics";

export type Sink = (alert: Alert) => void;

/** Route each alert to every sink. */
export function makeReporter(sinks: Sink[]): (alerts: Alert[]) => void {
  return (alerts) => {
    for (const alert of alerts) {
      for (const sink of sinks) sink(alert);
    }
  };
}

/** Log alerts to the browser console. All audiences. */
export const consoleSink: Sink = (alert) => {
  const line = `[daemon][${alert.level}][${alert.code}] ${alert.message}`;
  const context = alert.context ?? {};
  if (alert.level === "error") console.error(line, context);
  else if (alert.level === "warn") console.warn(line, context);
  else console.info(line, context);
};

/** Push player-facing alerts into the in-game terminal log. */
export function logFeedSink(push: (message: string) => void): Sink {
  return (alert) => {
    if (alert.audience === "player") push(`⚠ ${alert.message}`);
  };
}
