/**
 * SDK detection engine.
 *
 * Detection is registry-driven: every supported player SDK declares exactly one
 * record below, and a video is adopted only when its composed ancestry contains
 * one of that SDK's anchors. There is deliberately NO generic fallback - an
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
import { onDomMutations } from "./dom-watch.js";

const REGISTRY = [
  { name: "JW Player", anchors: [".jwplayer", ".jw-wrapper"] },
  { name: "Video.js", anchors: ["[data-vjs-player]", ".video-js"] },
  { name: "Plyr", anchors: ["[data-plyr]", ".plyr__video-wrapper", ".plyr"] },
  { name: "ArtPlayer", anchors: [".art-video-player", ".artplayer"] },
  { name: "DPlayer", anchors: [".dplayer"] },
  { name: "MediaElement.js", anchors: [".mejs-container", ".mejs__container"] },
  { name: "XGPlayer", anchors: [".xgplayer"] },
  { name: "Aliplayer", anchors: [".prism-player"] },
  { name: "Fluid Player", anchors: [".fluid_video_wrapper"] },
  { name: "Flowplayer", anchors: [".fp-player", "flowplayer-ui", "[data-player-id]", ".flowplayer"] },
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

/**
 * Repeat-query memo: discovery calls findSdkForVideo + findContainer on the
 * same element back to back, and SPA frameworks re-ask about surviving
 * videos. WeakMap keys die with their videos - session-only, never persisted.
 */
const matchCache = new WeakMap();

function matchSdk(video) {
  const cached = matchCache.get(video);
  if (cached) {
    return cached;
  }
  // Single composed walk (uBO's one-pass-over-tokens shape): the old code
  // re-walked ancestry once per anchor via composedClosest, then walked
  // again per hit to count hops. Chain index IS the hop count, so one pass
  // serves every anchor. Selection semantics unchanged: fewest hops wins,
  // ties keep registry order then anchor order (strict < keeps the first).
  const chain = [];
  for (const node of composedAncestry(video)) {
    chain.push(node);
  }
  let best = null;
  REGISTRY.forEach((record) => {
    record.anchors.forEach((anchor) => {
      for (let hop = 0; hop < chain.length; hop++) {
        if (chain[hop].matches(anchor)) {
          if (!best || hop < best.hops) {
            best = { record, el: chain[hop], hops: hop };
          }
          break;
        }
      }
    });
  });
  if (best) {
    matchCache.set(video, best);
  }
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
 * SDK - callers gate this behind findSdkForVideo().
 */
export function findContainer(video) {
  const match = matchSdk(video);
  if (!match) return null;
  // No registry record defines a `host` override today - the old
  // record.host ternary always took the plain-anchor branch.
  return match.el;
}

/**
 * Resolve the real <video> for a media event. Media events don't bubble, but
 * capture listeners on document still receive them through the composed path -
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

/** Every <video> entering the DOM in a MutationObserver batch's added nodes. */
export function* videosFromMutations(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.localName === "video") {
        yield node;
      } else if (node.querySelectorAll) {
        yield* node.querySelectorAll("video");
      }
    }
  }
}

/** Shared adoption gate: the rendered box must reach minimum player size. */
export function meetsMinSize(video, minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT) {
  try {
    const rect = video.getBoundingClientRect();
    return rect.width >= minWidth && rect.height >= minHeight;
  } catch {
    return false;
  }
}

/**
 * The one document-level discovery tap: capture-phase media events plus the
 * shared dom-watch dispatcher, multiplexed to every subscriber. Both riders -
 * the boot probe and the kernel's permanent watch - get identical signal
 * from this single wiring instead of installing their own.
 * Returns the unsubscribe function.
 */
export function watchDocumentVideos(onVideo) {
  const onMediaEvent = (event) => {
    const video = videoFromEvent(event);
    if (video) {
      onVideo(video);
    }
  };
  const offMutations = onDomMutations((mutations) => {
    for (const video of videosFromMutations(mutations)) {
      onVideo(video);
    }
  });
  document.addEventListener("loadeddata", onMediaEvent, true);
  document.addEventListener("play", onMediaEvent, true);
  return () => {
    offMutations();
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
  };
}
