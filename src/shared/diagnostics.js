/**
 * Debug runtime: the console logger and the debug-only jank diagnostics, kept
 * together because they share one toggle. `setDebugRuntime` flips both so no
 * observer can ever outlive (or miss) the log flag.
 */

/* - Logger - */

const PREFIX = "[PlayerForge]";

const STYLES = {
  kernel: "color: #FF6B35; font-weight: bold",
  shell: "color: #4ECDC4; font-weight: bold",
  warn: "color: #F38181; font-weight: bold",
  error: "color: #AA0000; font-weight: bold"
};

/**
 * Chatter (log/group) is compiled out at runtime until enable() flips it -
 * page-facing cost of a disabled log call is one boolean check, no string
 * building, no console I/O. warn/error stay unconditional: they mark
 * exceptional paths and must surface even in silent mode.
 */
let chatterEnabled = false;

function styleFor(channel) {
  return STYLES[channel] || "";
}

function log(channel, ...args) {
  if (!chatterEnabled) {
    return;
  }
  console.log(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", styleFor(channel), ...args);
}

function group(channel, label) {
  if (!chatterEnabled) {
    return;
  }
  console.group(`%c${PREFIX}%c[${channel}] ${label}`, "color: #FF6B35", styleFor(channel));
}

function groupEnd() {
  console.groupEnd();
}

function warn(channel, ...args) {
  console.warn(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.warn, ...args);
}

function error(channel, ...args) {
  console.error(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.error, ...args);
}

export const logger = {
  log,
  warn,
  error,
  group,
  groupEnd,
  /** Enable chatter - wired to the #pf-debug hash / debug setting in kernel. */
  enable() {
    chatterEnabled = true;
  },
  disable() {
    chatterEnabled = false;
  },
  get enabled() {
    return chatterEnabled;
  }
};

/* - Jank diagnostic (active ONLY while debug logs are on) - */

/**
 * The obvious source for this is LoAF (PerformanceLongAnimationFrameTiming),
 * which reports frames delayed past 50ms with script attribution. Gecko has
 * never shipped it - `long-animation-frame` is a Chromium-only
 * PerformanceObserver entry type - so a LoAF observer on this fork never
 * installs and the diagnostic was dead weight on the only platform we ship.
 *
 * What Gecko does have is the frame clock itself: every
 * requestAnimationFrame callback receives the frame's timestamp, so the gap
 * between consecutive frames IS the long-frame measurement, taken on the same
 * clock the compositor drives. The tradeoff is honest and worth stating: we
 * see WHEN a frame was late, not WHICH script caused it - attributing the
 * stall needs a tracing session (about:performance, profiler), not a
 * PerformanceObserver entry type this engine does not implement.
 *
 * Cost contract: nothing installs until debug is toggled on, and the rAF loop
 * is cancelled the moment it goes off, so a user without debug pays exactly
 * zero - no observer, no loop, no buffer. Slow frames accumulate and flush on
 * a fixed window, worst-first and capped, so a janky minute logs a handful of
 * lines instead of a flood.
 *
 * What the frame clock structurally CANNOT see: a slow event handler that
 * still finishes inside its frame. The gap measures paint, not work, so a
 * 300ms click handler on a page holding 60fps looks perfectly healthy here.
 * Event Timing is the orthogonal signal - it measures handler-to-paint latency
 * directly, and `interactionId` groups the keydown/pointerdown/keyup/pointerup
 * quartet of one interaction so we can report the interaction, not its parts.
 *
 * Honest limits on Gecko: this is a supplement, never a replacement. There is
 * no `PerformanceScriptTiming`, so entries carry no per-script attribution -
 * we learn THAT an interaction was slow, never WHICH handler made it slow.
 * `event` is present in `supportedEntryTypes` on 157 (verified), unlike
 * `longtask` and `long-animation-frame`, so this is the only interaction-latency
 * signal available on our one shipping engine.
 *
 * It also closes a hole the frame clock has by construction: `install` and
 * `teardown` drive the observer under their own guards rather than the rAF
 * ones, because a page that never drops a frame (or a context with no rAF at
 * all) must still be able to report a slow handler.
 */

/** Report only the worst few per flush so the console isn't flooded. */
const MAX_REPORT = 3;
/** Only frames this long are worth reporting. */
const JANK_THRESHOLD_MS = 150;
/** How often buffered slow frames are flushed to the console. */
const FLUSH_WINDOW_MS = 5000;

/**
 * Interaction latency floor. 200ms is the INP "good" boundary, so anything
 * under it is not worth a console line; the observer's own durationThreshold
 * is set lower (the spec's 16ms floor) purely to keep the entry queue small.
 */
const INTERACTION_THRESHOLD_MS = 200;
/** Spec minimum for PerformanceObserver durationThreshold. */
const OBSERVER_THRESHOLD_MS = 16;

let rafId = null;
let perfEnabled = false;
/** Timestamp of the previous frame; the gap to the current one is the measure. */
let lastFrameAt = 0;
/** Start of the current reporting window. */
let windowStart = 0;
/** Frame gaps seen in the current window, flushed worst-first. */
let slowFrames = [];

/* - Interaction latency (Event Timing) - */

let eventObserver = null;
/**
 * Worst duration per interactionId. Keying by id collapses the four events of
 * one interaction (keydown/pointerdown/keyup/pointerup) into a single
 * worst-of report, so a slow click logs one line, not four.
 */
let slowInteractions = new Map();

function flushSlowFrames() {
  if (slowFrames.length === 0) {
    return;
  }
  const worst = slowFrames.sort((a, b) => b - a).slice(0, MAX_REPORT);
  for (const gap of worst) {
    logger.warn("perf", `long frame: ${gap.toFixed(0)}ms between animation frames`);
  }
  slowFrames = [];
}

function onFrame(now) {
  rafId = requestAnimationFrame(onFrame);
  const gap = now - lastFrameAt;
  lastFrameAt = now;
  if (gap >= JANK_THRESHOLD_MS) {
    slowFrames.push(gap);
  }
  if (now - windowStart >= FLUSH_WINDOW_MS) {
    windowStart = now;
    flushSlowFrames();
    // Same window, different clock: a minute can be all long frames and no
    // slow interactions, so the rAF flush is not guaranteed to run.
    flushSlowInteractions();
  }
}

function flushSlowInteractions() {
  if (slowInteractions.size === 0) {
    return;
  }
  const worst = [...slowInteractions.values()].sort((a, b) => b.duration - a.duration).slice(0, MAX_REPORT);
  for (const entry of worst) {
    logger.warn("perf", `slow interaction: ${entry.duration.toFixed(0)}ms (${entry.name})`);
  }
  slowInteractions = new Map();
}

/**
 * Keep only the slowest entry per interactionId. Entries without an
 * interactionId are pointer/key *downs* that never completed a full
 * interaction quartet (e.g. a lone keyup), so they carry no latency verdict.
 */
function onEventEntries(list) {
  for (const entry of list) {
    if (!entry.interactionId || entry.duration < INTERACTION_THRESHOLD_MS) {
      continue;
    }
    const seen = slowInteractions.get(entry.interactionId);
    if (!seen || entry.duration > seen.duration) {
      slowInteractions.set(entry.interactionId, { duration: entry.duration, name: entry.name });
    }
  }
}

function installEventTiming() {
  if (eventObserver !== null || typeof PerformanceObserver !== "function") {
    return;
  }
  // Feature-detect via supportedEntryTypes rather than trusting observe() to
  // throw: an unknown type rejects asynchronously, which would escape the
  // try/catch and surface as an unhandled rejection instead of a clean skip.
  if (!PerformanceObserver.supportedEntryTypes?.includes("event")) {
    return;
  }
  try {
    eventObserver = new PerformanceObserver(onEventEntries);
    eventObserver.observe({ type: "event", durationThreshold: OBSERVER_THRESHOLD_MS, buffered: true });
  } catch {
    eventObserver = null;
  }
}

function teardownEventTiming() {
  if (eventObserver === null) {
    return;
  }
  eventObserver.disconnect();
  eventObserver = null;
  // Same rationale as the frame loop: buffered slow interactions are exactly
  // what the user was staring at when they switched debug off.
  flushSlowInteractions();
}

function install() {
  // Independent of the rAF guard below: Event Timing does not need a frame
  // clock, so a jank-free page still reports slow interactions.
  installEventTiming();
  if (rafId !== null || typeof requestAnimationFrame !== "function") {
    return;
  }
  slowFrames = [];
  // The first frame only seeds the clock. Reporting the gap from zero would
  // be an artifact of when debug was switched on, not a measurement of
  // anything the page did.
  rafId = requestAnimationFrame((now) => {
    lastFrameAt = now;
    windowStart = now;
    rafId = requestAnimationFrame(onFrame);
  });
}

function teardown() {
  // The observer is torn down on its own guard, NOT under the rAF one: a
  // context with no requestAnimationFrame still gets interaction timings, and
  // an early return here would strand the observer past the debug toggle.
  teardownEventTiming();
  if (rafId === null) {
    return;
  }
  cancelAnimationFrame(rafId);
  rafId = null;
  // Whatever was buffered when debug went off is exactly the jank the user
  // was watching - report it before dropping it.
  flushSlowFrames();
}

function setPerfDiag(on) {
  if (on === perfEnabled) {
    return;
  }
  perfEnabled = on;
  if (on) {
    install();
  } else {
    teardown();
  }
}

/**
 * Flip the debug runtime - console logs and the jank diagnostic - as one unit.
 * The kernel's boot probe and the GM menu toggle both route through here, so
 * the frame loop can never outlive (or miss) the log flag.
 */
export function setDebugRuntime(on) {
  if (on) {
    logger.enable();
  } else {
    logger.disable();
  }
  setPerfDiag(on);
}
