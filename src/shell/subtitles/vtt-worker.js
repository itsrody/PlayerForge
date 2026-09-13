/**
 * Dedicated Worker that owns large subtitle parses (Chromium 153+).
 *
 * The parse engine is this package's source of truth - forgevtt.js is bundled
 * straight in, so the worker can never drift from the main-thread parser. The
 * worker is spawned per huge track load by vtt-worker-loader.js and terminated
 * when it answers, so the page's renderer thread never pays for the
 * normalize/split/regex storm of a multi-megabyte .srt/.vtt.
 *
 * Chromium 153 extends Long Animation Frames to workers: a parse that would
 * have blocked the worker's own event loop is reported per-script, which the
 * loader surfaces through the existing debug perf-diag channel instead of a
 * silent stall. No GM_* grants exist in a Worker - this file stays pure.
 */
import { parseSubtitles } from "./forgevtt.js";

const JANK_THRESHOLD_MS = 150;

let worstJankMs = 0;
let worstForcedMs = 0;

/**
 * Report the single worst long-animation-frame this worker produced. LoAF in
 * workers landed in Chromium 153; the observer costs nothing when the support
 * is absent (pre-153 Chromium, jsdom test hosts).
 */
if (
  typeof PerformanceObserver !== "undefined" &&
  PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")
) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < JANK_THRESHOLD_MS) {
        continue;
      }
      const scripts = entry.scripts ?? [];
      const forced = scripts.reduce(
        (sum, s) => sum + (s.forcedStyleAndLayoutDuration ?? 0),
        0
      );
      if (entry.duration > worstJankMs) {
        worstJankMs = entry.duration;
        worstForcedMs = forced;
      }
    }
  }).observe({ type: "long-animation-frame", buffered: false });
}

self.onmessage = (event) => {
  const { id, text } = event.data ?? {};
  if (typeof id !== "number" || typeof text !== "string") {
    return;
  }
  try {
    const cues = parseSubtitles(text, 0);
    self.postMessage({ pfWorker: 1, id, cues });
  } catch (err) {
    // The caller falls back to an in-band cooperative parse on any worker
    // error, so a hostile cue payload never takes subtitles down.
    self.postMessage({
      pfWorker: 1,
      id,
      error: String((err && err.message) || err)
    });
  }
  if (worstJankMs > 0) {
    self.postMessage({
      pfWorker: 1,
      id,
      type: "perf",
      durationMs: Math.round(worstJankMs),
      forcedMs: Math.round(worstForcedMs * 10) / 10
    });
  }
};