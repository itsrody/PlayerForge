/**
 * SDK detection engine.
 *
 * Detection is registry-driven: every supported player SDK declares exactly one
 * record below, and a video is adopted only when its composed ancestry contains
 * one of that SDK's anchors. There is deliberately NO generic fallback — an
 * anchor must be owned by its SDK (prefixed class, dedicated data attribute, or
 * custom element tag), so pages merely styling a <div class="player"> stay
 * unrecognized rather than misidentified. Coverage grows by adding records.
 *
 * Record schema:
 *   name    - label used for logging and shell metadata.
 *   anchors - selectors resolved against the video's composed ancestry
 *             (closest(), shadow-boundary aware). Each must be SDK-namespaced;
 *             ordered most specific first.
 *   host    - optional selector overriding which element hosts the shell;
 *             defaults to the matched element itself.
 *
 * Reserved for future needs (not implemented): corroborating selectors,
 * version gates. Adding an SDK = one record plus one fixture test.
 *
 * Selection: among all matching anchors across all records, the element with
 * the fewest composed ancestor hops from the video wins; ties break by
 * registry order, then anchor order.
 */
const REGISTRY = [
  { name: "JW Player", anchors: [".jwplayer", ".jw-wrapper"] },
  { name: "Video.js", anchors: ["[data-vjs-player]", ".video-js"] },
  { name: "Plyr", anchors: ["[data-plyr]", ".plyr__video-wrapper", ".plyr"] },
  { name: "ArtPlayer", anchors: [".art-video-player", ".artplayer"] },
  { name: "DPlayer", anchors: [".dplayer"] },
  { name: "MediaElement.js", anchors: [".mejs-container", ".mejs__container"] },
  { name: "XGPlayer", anchors: [".xgplayer"] },
  { name: "Aliplayer", anchors: [".prism-player"] },
  { name: "Flowplayer", anchors: ["[data-player-id]", ".flowplayer"] },
  { name: "Clappr", anchors: ["[data-player]"] },
  { name: "Vidstack", anchors: ["media-player"] },
  { name: "Mux Player", anchors: ["mux-player"] },
  { name: "Radiant Media Player", anchors: ["radiant-media-player"] },
];

export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

/**
 * Ancestry of a node toward its document, crossing open shadow boundaries:
 * light-DOM parents continue past a shadow root to its host. Yields element
 * nodes only.
 */
function* composedAncestry(start) {
  for (let node = start; node; ) {
    if (node.nodeType === 1) {
      yield node;
    }
    node = node.parentNode ?? node.host ?? null;
  }
}

function composedClosest(node, selector) {
  for (const candidate of composedAncestry(node)) {
    if (candidate.matches(selector)) {
      return candidate;
    }
  }
  return null;
}

function matchSdk(video) {
  let best = null;
  REGISTRY.forEach((record, order) => {
    record.anchors.forEach((anchor) => {
      const el = composedClosest(video, anchor);
      if (!el) return;
      let hops = 0;
      for (const node of composedAncestry(video)) {
        if (node === el) break;
        hops++;
      }
      if (!best || hops < best.hops) {
        best = { record, el, hops };
      }
    });
  });
  return best;
}

/** Identify the SDK owning a video, or null when unregistered. */
export function findSdkForVideo(video) {
  const match = matchSdk(video);
  return match ? { name: match.record.name } : null;
}

/**
 * Resolve the element that should host the shell DOM: the matched anchor, or
 * the record's host override. Null when the video belongs to no registered
 * SDK — callers gate this behind findSdkForVideo().
 */
export function findContainer(video) {
  const match = matchSdk(video);
  if (!match) return null;
  return match.record.host ? composedClosest(match.el, match.record.host) : match.el;
}

/**
 * Resolve the real <video> for a media event. Media events don't bubble, but
 * capture listeners on document still receive them through the composed path —
 * where shadow-DOM hosts retarget event.target away from the actual video
 * (open roots only; closed roots are unreachable by design).
 */
export function videoFromEvent(event) {
  const target = event.target;
  if (target?.localName === "video") {
    return target;
  }
  for (const node of event.composedPath?.() ?? []) {
    if (node?.localName === "video") {
      return node;
    }
  }
  return null;
}
