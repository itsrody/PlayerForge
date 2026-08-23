import { logger } from "../shared/logger.js";

/** Deferred sweeps catching videos that appear shortly after injection. */
const SWEEP_DELAYS_MS = [600, 1800];

/**
 * Cheap sentinel that defers the full kernel boot until a document actually
 * shows a video candidate: an initial sweep, two delayed sweeps, capture-phase
 * media events, and a mutation observer all feed one gate. The first
 * qualifying candidate fires `onCandidate` exactly once and tears the probe
 * down; documents without video never pay for a kernel.
 */
export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  const timers = [];

  function qualifies(video) {
    try {
      const rect = video.getBoundingClientRect();
      return rect.width >= minWidth && rect.height >= minHeight;
    } catch {
      return false;
    }
  }

  function sweep() {
    if (done) {
      return;
    }
    for (const video of document.querySelectorAll("video")) {
      if (qualifies(video)) {
        fire();
        return;
      }
    }
  }

  function onMediaEvent(event) {
    if (!done && event.target?.localName === "video" && qualifies(event.target)) {
      fire();
    }
  }

  function stop() {
    observer.disconnect();
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.length = 0;
  }

  function fire() {
    done = true;
    stop();
    logger.log("probe", "Video candidate found — booting kernel");
    onCandidate();
  }

  const observer = new MutationObserver(sweep);
  document.addEventListener("loadeddata", onMediaEvent, true);
  document.addEventListener("play", onMediaEvent, true);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  sweep();
  for (const delay of SWEEP_DELAYS_MS) {
    timers.push(setTimeout(sweep, delay));
  }
  return stop;
}
