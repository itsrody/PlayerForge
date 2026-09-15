import { logger } from "./logger.js";

/**
 * Performance diagnostics — active ONLY while debug logs are on.
 *
 * Two independent observers, each installed/destroyed independently:
 *
 * 1. Long Animation Frame (LoAF) — Firefox 138+ / Chrome 123+
 *    Reports frames delayed beyond 50ms with script attribution, including
 *    forced-style/layout breakdowns. Surfaces the worst jank offenders.
 *
 * 2. Event Timing — Firefox 129+ / Chrome 76+
 *    Reports slow input events (pointer, keyboard) that exceed 50ms total
 *    processing time. Complements LoAF by isolating event handler latency
 *    from frame-level paint/composite delays.
 *
 * Both are installed lazily on the first debug run and torn down on disable,
 * so a production user without debug toggled pays exactly zero cost.
 */

/** Report only the worst few per flush so the console isn't flooded. */
const MAX_REPORT = 3;
/** Only frames that crossed an interaction or took > this long are worth noise. */
const JANK_THRESHOLD_MS = 150;
/** Event timing threshold: pointer/keyboard handlers exceeding this are slow. */
const EVENT_THRESHOLD_MS = 50;

let loafObserver = null;
let eventObserver = null;
let enabled = false;

function reportLoaf(entries) {
  const list = entries.getEntries();
  const worst = list
    .filter((e) => e.duration >= JANK_THRESHOLD_MS)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_REPORT);
  for (const entry of worst) {
    const blocked = entry.blockingDuration ?? 0;
    const forced = entry.scripts?.reduce((sum, s) => sum + (s.forcedStyleAndLayoutDuration ?? 0), 0) ?? 0;
    logger.warn(
      "perf",
      `LoAF ${entry.duration.toFixed(0)}ms (blocking ${blocked.toFixed(0)}ms, forced style+layout ${forced.toFixed(1)}ms)`
    );
    for (const script of entry.scripts ?? []) {
      if (script.name) {
        logger.warn("perf", `  - ${script.name}`);
      }
      if (script.forcedStyleAndLayoutDuration > 0) {
        logger.warn("perf", `     forced style+layout ${script.forcedStyleAndLayoutDuration.toFixed(1)}ms`);
      }
    }
  }
}

function reportEvents(entries) {
  const list = entries.getEntries();
  const worst = list
    .filter((e) => e.duration >= EVENT_THRESHOLD_MS)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_REPORT);
  for (const entry of worst) {
    logger.warn(
      "perf",
      `Slow ${entry.name} event ${entry.duration.toFixed(0)}ms (interactionId: ${entry.interactionId})`
    );
  }
}

function install() {
  if (enabled || typeof PerformanceObserver === "undefined") {
    return;
  }
  // LoAF observer (Firefox 138+ / Chrome 123+).
  if (!loafObserver && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    try {
      loafObserver = new PerformanceObserver(reportLoaf);
      loafObserver.observe({ type: "long-animation-frame", buffered: false });
    } catch {
      loafObserver = null;
    }
  }
  // Event Timing observer (Firefox 129+ / Chrome 76+).
  if (!eventObserver && PerformanceObserver.supportedEntryTypes.includes("event")) {
    try {
      eventObserver = new PerformanceObserver(reportEvents);
      eventObserver.observe({ type: "event", buffered: false, durationThreshold: EVENT_THRESHOLD_MS });
    } catch {
      eventObserver = null;
    }
  }
}

function teardown() {
  if (loafObserver) {
    loafObserver.disconnect();
    loafObserver = null;
  }
  if (eventObserver) {
    eventObserver.disconnect();
    eventObserver = null;
  }
}

export function setPerfDiag(on) {
  if (on === enabled) {
    return;
  }
  enabled = on;
  if (on) {
    install();
  } else {
    teardown();
  }
}
