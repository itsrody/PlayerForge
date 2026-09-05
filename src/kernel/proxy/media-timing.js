/**
 * Kernel-owned media network-timeline surface (§7.5).
 *
 * The framework owns the page's network timeline. One live, passive
 * PerformanceObserver over `resource` entries relays only media-shaped loads
 * - URLs that look like progressive/HLS/DASH streams, or entries whose
 * initiatorType is `video`/`audio`, the shape the media element's OWN native
 * GETs have (the network-process loads the element-level proxy seam can never
 * see) - into a per-realm collector. The kernel arms the relay; the network
 * layer consults or schedules into the collector without ever owning a DOM
 * handle or polling performance. It is event-driven by construction: the
 * browser calls the observer, the observer never actively re-reads the
 * timeline.
 *
 * Firefox-native: PerformanceObserver / PerformanceResourceTiming are FF 57+
 * (baseline 2024). Media elements surface their loads with initiatorType
 * `video`/`audio`, and `entry.name` (the URL) survives cross-origin -
 * Timing-Allow-Origin only zeros granular timestamps, never the name.
 * `buffered: false` is the efficient mode by design: a buffered replay would
 * O(n) the whole 250-entry default window on first callback and drop the
 * live entry pressure this surface exists to catch.
 *
 * Deterministic: the observer class is a constructor-injectable seam, so the
 * whole relay runs headless against a stubbed observer.
 */
const MEDIA_TIMING_NAME_RE = /\.(?:mp4|webm|ogv|ogg|m4v|mov)(?:[?#]|$)|\.(?:m3u8|mpd)(?:[?#&]|$)|get_video|[?&]stream=1\b|(?:tapecontent|radosgw)[^#?]*\.mp4/i;

const MEDIA_INITIATOR_RE = /^(?:video|audio)$/;

/** True for a resource-timing `name` shaped like a media stream URL. */
export function isMediaTimingName(name) {
  return MEDIA_TIMING_NAME_RE.test(String(name ?? ""));
}

/** True for a resource entry that came from the media element itself (the
 *  native GETs at the network-process boundary) or names a media URL. */
export function isMediaElementEntry(entry) {
  return MEDIA_INITIATOR_RE.test(String(entry?.initiatorType ?? "")) || isMediaTimingName(entry?.name);
}

/**
 * The media network-timeline collector: a per-realm store of the routed and
 * native-fallback media URLs the framework has observed or been told about.
 * `add`/`has` are the whole API - wire-layer code never touches performance
 * directly.
 */
export const mediaTimeline = (() => {
  const byName = new Map();
  return {
    add(entry) {
      const name = String(entry?.name ?? "");
      if (!name) {
        return;
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

/**
 * Live media-timing observer. Constructs the native PerformanceObserver once
 * and relays only media-shaped resource entries to the callback. The observer
 * class is injectable for headless tests; the default is the FF-native bare
 * global resolved at call time.
 */
export class MediaTimingObserver {
  #observer = null;

  constructor(callback, { PerformanceObserverClass = globalThis.PerformanceObserver } = {}) {
    if (typeof callback !== "function") {
      throw new TypeError("MediaTimingObserver requires a callback");
    }
    if (typeof PerformanceObserverClass !== "function") {
      throw new TypeError("MediaTimingObserver requires PerformanceObserverClass");
    }
    this.#observer = new PerformanceObserverClass((list) => {
      for (const entry of list.getEntries()) {
        if (isMediaElementEntry(entry)) {
          callback(entry);
        }
      }
    });
  }

  observe(options = {}) {
    this.#observer?.observe({ type: "resource", buffered: false, ...options });
    return this;
  }

  disconnect() {
    this.#observer?.disconnect();
  }
}