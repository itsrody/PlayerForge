import { logger } from "./logger.js";

/**
 * Long Animation Frame (LoAF) diagnostic, active ONLY while debug logs are on.
 *
 * LoAF (Chromium 123+) reports frames delayed beyond 50ms with script
 * attribution, including forced-style/layout breakdowns. When debugging jank -
 * whether PlayerForge or an SDK caused it - this surfaces the worst offenders on
 * the console instead of requiring a tracing session. It is installed lazily on
 * the first debug run and torn down on disable, so a production user without
 * debug toggled pays exactly zero cost: no observer, no buffered entries.
 */

/** Report only the worst few per flush so the console isn't flooded. */
const MAX_REPORT = 3;
/** Only frames that crossed an interaction or took > this long are worth noise. */
const JANK_THRESHOLD_MS = 150;

let observer = null;
let enabled = false;

function report(entries) {
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

function install() {
  if (observer || enabled || typeof PerformanceObserver === "undefined") {
    return;
  }
  try {
    if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      return;
    }
    observer = new PerformanceObserver(report);
    observer.observe({ type: "long-animation-frame", buffered: false });
  } catch {
    observer = null;
  }
}

function teardown() {
  if (!observer) {
    return;
  }
  observer.disconnect();
  observer = null;
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
