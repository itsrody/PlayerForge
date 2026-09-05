/**
 * Kernel-owned media network-timeline extractor and collector (§7.5).
 *
 * The framework owns the page's media network timeline. The observer
 * substrate ships in net-watch.js (§7.7) - one realm-wide feed this module
 * consumes as a filtered subscriber: `isMediaElementEntry` keeps only the
 * media-shaped loads - URLs that look like progressive/HLS/DASH streams, or
 * entries whose initiatorType is `video`/`audio`, the shape the media
 * element's OWN native GETs have (the network-process loads the element-level
 * proxy seam can never see) - and the per-realm collector keeps them,
 * url-keyed. The wire layer never touches performance directly; it consults
 * or schedules into the collector (`has` is the "already on the wire" test
 * the element seam's existence check needs). Event-driven by construction:
 * the browser calls the observer, nothing here ever re-reads the timeline.
 *
 * Firefox-native: PerformanceResourceTiming is FF 57+ (baseline 2024). The
 * initiatorType `video`/`audio` marks the media element's own requests, and
 * `entry.name` (the URL) survives cross-origin - Timing-Allow-Origin only
 * zeros granular timestamps, never the name.
 *
*  Deterministic: pure predicates and a plain store - the whole module runs
 *  headless with no DOM, network, or observer dependency.
 */
import { isMediaUrlName } from "../../shared/media-shapes.js";

const MEDIA_INITIATOR_RE = /^(?:video|audio)$/;

/** True for a resource-timing `name` shaped like a media stream URL (the
 *  observation superset from media-shapes.js). */
export function isMediaTimingName(name) {
  return isMediaUrlName(name);
}

/** True for a resource entry that came from the media element itself (the
 *  native GETs at the network-process boundary) or names a media URL. */
export function isMediaElementEntry(entry) {
  return MEDIA_INITIATOR_RE.test(entry?.initiatorType ?? "") || isMediaTimingName(entry?.name);
}

/**
 * The media network-timeline collector: a per-realm store of the routed and
 * native-fallback media URLs the framework has observed or been told about.
 * `add`/`has` are the whole API - wire-layer code never touches performance
 * directly. Bounded FIFO: a segment-per-second stream would otherwise grow
 * `byName` without limit; the newest `MAX` sightings are kept and stale ones
 * evicted in insertion order (live feed - old segment URLs have no look-back
 * value, matching the observer's out-of-the-box window).
 */
/**
 * The pure measurement half of the bandwidth-acceleration layer: a headless
 * EWMA + sliding-window network-throughput estimator. Every successful media
 * fetch samples `bytes` over `elapsedMs` and the smoothed estimate feeds the
 * segment flow's look-ahead window (segment-flow.js). No browser API touches
 * this model - an injectable clock keeps it deterministic, and a poisoned
 * (zero/negative) sample is ignored so a degenerate transport can never NaN
 * the estimate or the scheduler that reads it.
 */
export class NetworkThroughput {
  #windowMs;
  #ewma;
  #clock;
  #onEstimate;
  #bps = 0;
  #hasEstimate = false;
  #samples = [];

  constructor({ windowMs = 30_000, ewma = 0.25, clock = () => Date.now(), onEstimate = () => {} } = {}) {
    this.#windowMs = Math.max(1, Number(windowMs) || 30_000);
    this.#ewma = Math.min(1, Math.max(0, Number(ewma) || 0.25));
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#onEstimate = typeof onEstimate === "function" ? onEstimate : () => {};
  }

  /** Record one transfer sample: `bytes` moved over `elapsedMs`. Returns the
   *  updated EWMA estimate. Samples with no elapsed time or no bytes are
   *  ignored (they carry no rate signal). */
  sample(bytes, elapsedMs) {
    const size = Number(bytes) || 0;
    const elapsed = Number(elapsedMs) || 0;
    if (elapsed <= 0 || size <= 0) {
      return this.#bps;
    }
    const instant = (size * 1000) / elapsed;
    this.#samples.push({ bps: instant, at: this.#clock() });
    const cutoff = this.#clock() - this.#windowMs;
    while (this.#samples.length > 0 && this.#samples[0].at < cutoff) {
      this.#samples.shift();
    }
    const previous = this.#bps;
    if (!this.#hasEstimate) {
      this.#bps = instant;
      this.#hasEstimate = true;
    } else {
      this.#bps = this.#bps + this.#ewma * (instant - this.#bps);
    }
    if (this.#bps !== previous) {
      this.#onEstimate(this.#bps);
    }
    return this.#bps;
  }

  /** The smoothed EWMA estimate (bps) - the scheduler's fast signal. */
  estimateBps() {
    return this.#bps;
  }

  /** The mean of the in-window sample rates (bps) - the stable signal. */
  windowAverageBps() {
    if (this.#samples.length === 0) {
      return 0;
    }
    let sum = 0;
    for (const sample of this.#samples) {
      sum += sample.bps;
    }
    return sum / this.#samples.length;
  }

  /** Forget every sample and the estimate (new arm / stream reset). */
  reset() {
    this.#bps = 0;
    this.#hasEstimate = false;
    this.#samples.length = 0;
    this.#onEstimate(0);
  }
}

const MAX_TIMELINE = 500;
export const mediaTimeline = (() => {
  const byName = new Map();
  return {
    add(entry) {
      const name = String(entry?.name ?? "");
      if (!name) {
        return;
      }
      byName.delete(name);
      if (byName.size >= MAX_TIMELINE) {
        byName.delete(byName.keys().next().value);
      }
      byName.set(name, entry);
    },
    has(url) {
      return byName.has(String(url ?? ""));
    },
    get(url) {
      return byName.get(String(url ?? "")) ?? null;
    },
    all() {
      return Array.from(byName.values());
    }
  };
})();