import { logger } from "../shared/logger.js";

/**
 * High-frequency channels are aggregated once per second rather than
 * logged per-fire. Pending samples are silently dropped when debug
 * toggles off — no stale aggregate line in the next session.
 */
const SAMPLED_TYPES = new Set(["pf:shell-timeupdate"]);
const SAMPLE_WINDOW_MS = 1000;

/**
 * Event bus over the platform EventTarget: payloads ride CustomEvent detail,
 * listeners subscribe with addEventListener ({ once, signal } supported),
 * and emits trace when debug mode is on. Sampled types aggregate per window.
 */
export class EventBus extends EventTarget {
  #debug = false;
  #sampledCounts = new Map();
  #sampleTimer = 0;

  set debug(value) {
    if (this.#debug && !value) {
      this.#clearSamples();
    }
    this.#debug = value;
  }

  emit(type, detail) {
    if (this.#debug) {
      if (SAMPLED_TYPES.has(type)) {
        this.#sampledCounts.set(type, (this.#sampledCounts.get(type) ?? 0) + 1);
        if (!this.#sampleTimer) {
          this.#sampleTimer = setTimeout(() => {
            this.#sampleTimer = 0;
            this.#flushSamples();
          }, SAMPLE_WINDOW_MS);
        }
      } else {
        logger.log("bus", `emit: ${type}`, detail);
      }
    }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #flushSamples() {
    if (this.#sampleTimer) {
      clearTimeout(this.#sampleTimer);
      this.#sampleTimer = 0;
    }
    for (const [type, count] of this.#sampledCounts) {
      logger.log("bus", `emit: ${type} ×${count} (sampled ${SAMPLE_WINDOW_MS}ms)`);
    }
    this.#sampledCounts.clear();
  }

  #clearSamples() {
    if (this.#sampleTimer) {
      clearTimeout(this.#sampleTimer);
      this.#sampleTimer = 0;
    }
    this.#sampledCounts.clear();
  }
}
