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
 *   host    - optional selector overriding which element hosts the shell's
 *             DOM; resolved against the matched element's composed ancestry
 *             (overriding default of the matched element itself). Not yet set
 *             by any record - kept as the extensible placement hook.
 *
 * The shell-facing descriptor carries name + the resolved container, so the
 * kernel has one source of truth for SDK identity AND shell placement.
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
 * Repeat-query memo: discovery calls findSdkForVideo + findContainer on the
 * same element back to back, and SPA frameworks re-ask about surviving
 * videos. WeakMap keys die with their videos - session-only, never persisted.
 */
const matchCache = new WeakMap();

/**
 * Reusable composed-ancestry scratch: the match loop is fully synchronous and
 * never lets the array escape (callers keep only `el`/`record`/`hops`, never
 * the chain itself), so one array serves every full-scan instead of allocating
 * a fresh one per video. `len` is the filled length each pass.
 */
const chain = [];

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
  //
  // Flat indexed loops instead of forEach/generator closures: each full-scan
  // (cache-miss) call previously allocated an arrow closure per record and
  // per anchor. Indexed for-loops are the JIT's most reliably optimized shape
  // - no closure allocations on the discovery hot path.
  let len = 0;
  for (let node = video; node; ) {
    if (node.nodeType === 1) {
      chain[len++] = node;
    }
    node = node.parentNode ?? node.host ?? null;
  }
  let best = null;
  for (let r = 0; r < REGISTRY.length; r++) {
    const record = REGISTRY[r];
    const anchors = record.anchors;
    for (let a = 0; a < anchors.length; a++) {
      const anchor = anchors[a];
      for (let hop = 0; hop < len; hop++) {
        if (chain[hop].matches(anchor)) {
          if (!best || hop < best.hops) {
            best = { record, el: chain[hop], hops: hop };
          }
          break;
        }
      }
    }
  }
  if (best) {
    matchCache.set(video, best);
  }
  return best;
}

/** Identify the SDK owning a video, or null when unregistered. */
export function findSdkForVideo(video) {
  const match = matchSdk(video);
  if (!match) return null;
  return {
    name: match.record.name,
    host: match.record.host ?? null,
    container: resolveContainer(match)
  };
}

/**
 * Resolve the element that hosts the shell DOM: the matched record's `host`
 * override, else the matched element itself. Exported solely so the
 * host-resolution branch (unexercised by the current registry) can be driven
 * by a synthetic match in the sdk-engine test.
 */
export function resolveContainer({ record, el }) {
  if (!record.host) {
    return el;
  }
  // Composed-ancestry walk mirroring anchor matching: the host override may
  // target an element above the matched anchor and across shadow boundaries.
  for (let node = el; node; ) {
    if (node.nodeType === 1 && node.matches(record.host)) {
      return node;
    }
    node = node.parentNode ?? node.host ?? null;
  }
  return el;
}

/** @deprecated Use the descriptor's `container` field instead. */
export function findContainer(video) {
  return findSdkForVideo(video)?.container ?? null;
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
 * Capture-phase media-event tap with NO mutation observer - the cheap signal
 * used by the two-phase boot probe before it commits to a full-document
 * observer. Media events travel the composed path to document, so even
 * shadow-hosted SDK videos surface here without any subtree observer.
 */
export function watchMediaEvents(onVideo) {
  const onMediaEvent = (event) => {
    const video = videoFromEvent(event);
    if (video) {
      onVideo(video);
    }
  };
  document.addEventListener("loadeddata", onMediaEvent, true);
  document.addEventListener("play", onMediaEvent, true);
  return () => {
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
  };
}

/**
 * Full discovery tap used by the kernel's permanent rider: capture media
 * events plus the shared dom-watch dispatcher, multiplexed to a subscriber.
 * This is the heavier signal (it keeps a full-document childList+subtree
 * observer alive while subscribed); the boot probe prefers watchMediaEvents.
 * Returns the unsubscribe function.
 */
export function watchDocumentVideos(onVideo) {
  const offEvents = watchMediaEvents(onVideo);
  const offMutations = onDomMutations((mutations) => {
    for (const video of videosFromMutations(mutations)) {
      onVideo(video);
    }
  });
  return () => {
    offEvents();
    offMutations();
  };
}
