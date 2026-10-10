/**
 * Debug runtime: the console logger and the debug-only diagnostics, kept
 * together because they share one toggle. `setDebugRuntime` flips all of them
 * so no observer can ever outlive (or miss) the log flag. The diagnostics are
 * the frame-clock jank watchdog, the Event Timing supplement, and dropped-frame
 * reporting.
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
/**
 * True while the frame clock is being re-established after the document was
 * hidden, so gaps are not measured. Gecko suspends rAF in a hidden document and
 * does NOT resume with one big gap: it hands back a burst of catch-up frames
 * instead. Measured in 157, the burst GROWS with the time spent hidden and the
 * gaps DOUBLE - 1s hidden gave [1006], 3s gave [1005, 1003, 997], 10s gave
 * [1005, 1005, 2006, 4003, 1985] and 30s gave [1002, 1002, 2005, 4005, 8001,
 * 13991]. Every one is over JANK_THRESHOLD_MS, so an unguarded loop reports a
 * backgrounded tab as a burst of jank events - pure artifact, and the whole
 * point of this diagnostic is to attribute slowness to page work.
 *
 * Cleared on the first sub-threshold gap, which is the signal that the
 * compositor is running again.
 */
let resyncing = false;
/** Catch-up frames already swallowed in the current resync window. */
let resyncFrames = 0;
/**
 * Ceiling on the swallow, so a page that comes back from a background tab
 * genuinely janking is not silenced forever by the flag waiting for a healthy
 * frame that never comes. Sized far above the measured burst: the gap sizes
 * double while the frame COUNT grows logarithmically, so even an hours-long
 * background stays well inside this.
 */
const MAX_RESYNC_FRAMES = 32;
/** Document the visibility listener is bound to; null when there is none. */
let visDoc = null;

/**
 * Flips the resync flag when the document is backgrounded. Lives with the rAF
 * loop (armed in install, released in teardown) so it can never outlive it or
 * be missing when the loop starts.
 */
function onVisibilityChange() {
  if (visDoc?.visibilityState === "hidden") {
    resyncing = true;
    resyncFrames = 0;
  }
}

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
  if (resyncing) {
    // Catch-up frames after a hidden->visible transition measure Gecko's
    // compositor re-establishment, not the page. Keep the clock current and
    // resume measuring once the cadence is healthy again - or once the burst
    // outruns its ceiling, so a page that comes back janky is still reported.
    resyncFrames += 1;
    if (gap < JANK_THRESHOLD_MS || resyncFrames >= MAX_RESYNC_FRAMES) {
      resyncing = false;
    }
    return;
  }
  if (gap >= JANK_THRESHOLD_MS) {
    slowFrames.push(gap);
  }
  if (now - windowStart >= FLUSH_WINDOW_MS) {
    windowStart = now;
    flushSlowFrames();
    // Same window, different clock: a minute can be all long frames and no
    // slow interactions, so the rAF flush is not guaranteed to run.
    flushSlowInteractions();
    // And neither diagnostic is guaranteed to have anything to say: a window
    // of dropped frames reports here even when no frame was long.
    flushFrameQuality();
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
 *
 * The observer hands us a PerformanceObserverEntryList, which has getEntries
 * but no @@iterator - iterating it directly throws "not iterable" on the
 * first slow interaction of every debug session. Read through getEntries();
 * a bare array is still accepted so a host that hands one over keeps working.
 */
function onEventEntries(list) {
  const entries = typeof list?.getEntries === "function" ? list.getEntries() : list;
  for (const entry of entries) {
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

/* - Frame quality (dropped-frame reporting) - */

/**
 * The other half of "is this playing well", and the half the frame clock
 * structurally cannot see: a long frame is page jank, a dropped video frame is
 * the pipeline letting one go while the page itself may be perfectly idle.
 *
 * Every number comes from the quality APIs (§2.5, §7), never from rVFC's
 * metadata:
 *
 * - `getVideoPlaybackQuality().droppedVideoFrames` is the decoder's own count.
 * - `corruptedVideoFrames` rides the same report: frames the decoder marks
 *   unwatchable, accumulated and rebased exactly like dropped ones.
 * - Gecko's `mozPresentedFrames` minus `mozPaintedFrames` is how many frames
 *   were submitted and never reached the screen - the pair §4 reaches for by
 *   name. The standard `presentedFrames` cannot stand in for it: Gecko reports
 *   that one as null.
 *
 * rVFC contributes only its OCCURRENCE - one callback means "a frame was
 * presented", which is the edge a sample is taken on. Its `presentedFrames`
 * metadata is never read, because §2.5's cadence question (bug 1935256) is
 * exactly what makes it untrustworthy for anything frame-accurate. Without rVFC
 * the sample falls back to the flush instead; either way the counters are
 * cumulative, so the delta between any two samples is the true count for the
 * interval between them.
 *
 * Lifecycle is §4 L1's Frame row: armed only while unpaused, cancelled on
 * pause/seek/end, so a stopped player costs one outstanding handle and nothing
 * else. The cost contract matches the rest of this module - nothing is armed
 * until debug is on, and teardown reports whatever was buffered before dropping
 * it.
 *
 * Without `EngineHost.canMozQuality` there is nothing to read and registration
 * is a no-op, which is the degradation `platform/capabilities.json` records.
 */

/** Videos registered for reporting. Entries arm only while debug is on. */
const qualityVideos = new Set();
/** Counter deltas accumulated since the last flush. */
let qDropped = 0;
let qPresented = 0;
let qPainted = 0;
let qCorrupted = 0;

/** Media edges that arm and cancel the presentation edge. */
const EDGE_ARM = ["play", "playing"];
const EDGE_CANCEL = ["pause", "seeking", "ended", "emptied"];

/**
 * Cumulative counters: a value below the last one means the element reset (a
 * new resource, `emptied`), so everything it currently holds is what landed
 * since. The reset is rebased rather than clamped to zero so the frames the
 * new resource has already presented are still counted.
 */
function countedSince(now, before) {
  if (before == null || !Number.isFinite(now)) {
    return 0;
  }
  return now >= before ? now - before : now;
}

/** Read the three counters and fold the delta since the previous sample in. */
function sampleQuality(entry) {
  const quality = entry.video.getVideoPlaybackQuality();
  const presented = entry.video.mozPresentedFrames;
  const painted = entry.video.mozPaintedFrames;
  if (entry.prev !== null) {
    qDropped += countedSince(quality.droppedVideoFrames, entry.prev.dropped);
    qPresented += countedSince(presented, entry.prev.presented);
    qPainted += countedSince(painted, entry.prev.painted);
    // Corrupted frames are the decoder's own "unwatchable" count, beside the
    // dropped one: same cumulative shape, same rebase rule, one more line.
    qCorrupted += countedSince(quality.corruptedVideoFrames, entry.prev.corrupted);
  }
  entry.prev = {
    dropped: quality.droppedVideoFrames,
    presented,
    painted,
    corrupted: quality.corruptedVideoFrames
  };
}

function armEdge(entry) {
  const { video } = entry;
  if (!entry.usesEdge || entry.rvfc !== null) {
    return;
  }
  entry.rvfc = video.requestVideoFrameCallback(() => {
    entry.rvfc = null;
    sampleQuality(entry);
    // Re-armed only while unpaused: the cancel edges above already ran by the
    // time a pause lands, so this is what stops a stopped player re-arming.
    if (!video.paused && !video.ended && !video.seeking) {
      armEdge(entry);
    }
  });
}

function cancelEdge(entry) {
  if (entry.rvfc === null) {
    return;
  }
  entry.video.cancelVideoFrameCallback?.(entry.rvfc);
  entry.rvfc = null;
}

/**
 * Whether the element carries the whole quality set: the standard
 * `getVideoPlaybackQuality()` plus Gecko's `mozPresentedFrames` /
 * `mozPaintedFrames` pair. All three or none - Gecko reports the standard
 * `presentedFrames` as null, so the standard half alone cannot produce the
 * submitted-versus-painted number the report is built on. Read on the
 * element, not the prototype: data members are probed with `in` either way,
 * and a built-in element is never un-upgraded.
 */
function hasQualitySet(video) {
  return typeof video.getVideoPlaybackQuality === "function" &&
    "mozPresentedFrames" in video &&
    "mozPaintedFrames" in video;
}

function armQuality(entry) {
  if (entry.detach !== null) {
    return;
  }
  const { video, signal } = entry;
  // Per-element, like resume.js: a built-in element is never un-upgraded,
  // so asking the element answers what a prototype probe would, without one.
  entry.usesEdge = typeof video.requestVideoFrameCallback === "function";
  const arm = () => armEdge(entry);
  const cancel = () => cancelEdge(entry);
  for (const type of EDGE_ARM) {
    video.addEventListener(type, arm, { signal, passive: true });
  }
  for (const type of EDGE_CANCEL) {
    video.addEventListener(type, cancel, { signal, passive: true });
  }
  // Baseline. Without a first reading, the opening delta would be the
  // element's entire lifetime reported as though all of it happened here.
  sampleQuality(entry);
  if (!video.paused && !video.ended && !video.seeking) {
    armEdge(entry);
  }
  entry.detach = () => {
    cancelEdge(entry);
    for (const type of EDGE_ARM) {
      video.removeEventListener(type, arm);
    }
    for (const type of EDGE_CANCEL) {
      video.removeEventListener(type, cancel);
    }
    entry.detach = null;
  };
}

function flushFrameQuality() {
  // Every armed entry, edge or not. An entry riding the presentation edge will
  // already have sampled on its own callbacks, so for that one this is usually
  // a zero-delta read - it is the guarantee that the interval since the last
  // sample is never lost, whatever cancelled the callbacks first.
  for (const entry of qualityVideos) {
    if (entry.detach !== null) {
      sampleQuality(entry);
    }
  }
  const neverPainted = Math.max(0, qPresented - qPainted);
  if (qDropped > 0 || neverPainted > 0 || qCorrupted > 0) {
    logger.warn(
      "perf",
      `dropped frames: ${qDropped} dropped, ${qPresented} presented, ${neverPainted} never painted` +
        (qCorrupted > 0 ? `, ${qCorrupted} corrupted` : "")
    );
  }
  qDropped = 0;
  qPresented = 0;
  qPainted = 0;
  qCorrupted = 0;
}

/**
 * Register a video for dropped-frame reporting, and return its disposer.
 *
 * Registration is deliberately independent of the debug toggle: a shell that
 * boots while debug is off is still reported on the moment it is switched on,
 * and the caller never has to know whether the toggle is currently set. It
 * costs one Set entry, and arms nothing.
 */
export function watchFrameQuality(video, signal) {
  if (!video || !hasQualitySet(video)) {
    return () => {};
  }
  const entry = { video, signal, prev: null, rvfc: null, usesEdge: false, detach: null };
  qualityVideos.add(entry);
  if (perfEnabled) {
    armQuality(entry);
  }
  return () => {
    if (!qualityVideos.has(entry)) {
      return;
    }
    // Sampled while it is still registered: flushFrameQuality only walks the
    // entries it can still see, and this one is about to stop being one.
    if (entry.detach !== null) {
      sampleQuality(entry);
    }
    qualityVideos.delete(entry);
    entry.detach?.();
    // Whatever was buffered is exactly what the user was watching - the same
    // reasoning as the frame-loop teardown flush.
    flushFrameQuality();
  };
}

function install() {
  // Independent of the rAF guard below: Event Timing does not need a frame
  // clock, so a jank-free page still reports slow interactions.
  installEventTiming();
  // Likewise: the presentation edge does not need a frame clock either. Only
  // the flush window does, so a host with no rAF still samples on pause/seek/end
  // and reports when the runtime is switched off.
  for (const entry of qualityVideos) {
    armQuality(entry);
  }
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
  // Resolved through globalThis and guarded, never as a bare `document`: this
  // module has no document dependency of its own (its tests drive it with no
  // DOM at all), and a bare reference would turn a debug-only diagnostic into a
  // ReferenceError in any realm without one.
  visDoc = globalThis.document ?? null;
  visDoc?.addEventListener("visibilitychange", onVisibilityChange);
}

function teardown() {
  // The observer is torn down on its own guard, NOT under the rAF one: a
  // context with no requestAnimationFrame still gets interaction timings, and
  // an early return here would strand the observer past the debug toggle.
  teardownEventTiming();
  // Sampled and reported before its own listeners go, and on the same
  // independent guard as Event Timing: a host with no frame clock still owns
  // buffered drops, and releasing the listeners first is what would strand them.
  flushFrameQuality();
  for (const entry of qualityVideos) {
    entry.detach?.();
  }
  // Released before the rAF early return, so the listener can never outlive
  // the loop it exists to protect.
  visDoc?.removeEventListener("visibilitychange", onVisibilityChange);
  visDoc = null;
  resyncing = false;
  resyncFrames = 0;
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
