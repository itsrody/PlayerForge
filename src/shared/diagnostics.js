/**
 * Debug runtime: the console logger and the debug-only jank watchdog, kept
 * together because they share one toggle. `setDebugRuntime` flips both so the
 * frame loop can never outlive (or miss) the log flag.
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
 */

/** Report only the worst few per flush so the console isn't flooded. */
const MAX_REPORT = 3;
/** Only frames this long are worth reporting. */
const JANK_THRESHOLD_MS = 150;
/** How often buffered slow frames are flushed to the console. */
const FLUSH_WINDOW_MS = 5000;

let rafId = null;
let perfEnabled = false;
/** Timestamp of the previous frame; the gap to the current one is the measure. */
let lastFrameAt = 0;
/** Start of the current reporting window. */
let windowStart = 0;
/** Frame gaps seen in the current window, flushed worst-first. */
let slowFrames = [];

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
  }
}

function install() {
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
