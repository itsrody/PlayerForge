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
  return MEDIA_INITIATOR_RE.test(String(entry?.initiatorType ?? "")) || isMediaTimingName(entry?.name);
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