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
 * The shell-facing descriptor carries name + the resolved container (plus the
 * matched anchor element and its hop distance, both computed free during the
 * scan), so the kernel has one source of truth for SDK identity AND shell
 * placement. The descriptor is cached - same object per video on every
 * re-query.
 *
 * Reserved for future needs (not implemented): corroborating selectors,
 * version gates. Adding an SDK = one record plus one fixture test.
 *
 * Selection: among all matching anchors across all records, the element with
 * the fewest composed ancestor hops from the video wins; ties break by
 * registry order, then anchor order.
 */
import { onDomMutations } from "../shared/dom-manager.js";

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
  { name: "Laravel Video Embed", anchors: ["[data-page] > div:first-child", "#app[data-page]"] },
];

export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

/**
 * Reusable composed-ancestry scratch: the match loop is fully synchronous and
 * never lets the array escape (callers keep only `el`/`record`/`hops`, never
 * the chain itself), so one array serves every full-scan instead of allocating
 * a fresh one per video. `len` is the filled length each pass.
 */
const chain = [];

/**
 * The single composed-ancestry walk, shared by anchor matching and container
 * resolution. Fills the reusable `chain` with the element nodes from `start`
 * upwards (crossing shadow boundaries via `.host`), and returns the filled
 * length. Flat indexed loop, no closure per call - the JIT's most reliably
 * optimized shape for this one-pass discovery walk. Chain index doubles as the
 * hop count. Callers must keep only what they read from `chain[0..len)`; the
 * scratch buffer never escapes.
 */
function fillComposedChain(start) {
  let len = 0;
  for (let node = start; node; ) {
    if (node.nodeType === 1) {
      chain[len++] = node;
    }
    node = node.parentNode ?? node.host ?? null;
  }
  return len;
}

/**
 * True when `anchor` is still exactly `hops` composed element-hops above
 * `video`, mirroring fillComposedChain's element-only hop counting. Costs one
 * bounded re-walk of the depth the scan already paid for, and turns a positive
 * memo into a checkable fact instead of an assumption.
 */
function anchorStillMatches(video, anchor, hops) {
  let node = video;
  let seen = 0;
  while (node) {
    if (node.nodeType === 1) {
      if (seen === hops) {
        return node === anchor;
      }
      seen++;
    }
    node = node.parentNode ?? node.host ?? null;
  }
  return false;
}

/**
 * Is a memo entry still true of the video's current ancestry?
 *
 * A memo that is never re-validated is wrong the moment a page moves the
 * element: SPA route changes, player re-init, and ad-slot recycling all
 * re-parent the SAME <video>, which keeps the same WeakMap key, so the old
 * answer survived forever - a video adopted by an SDK that later replaced its
 * wrapper kept resolving to the dead one, and a video that an SDK inserted
 * itself around stayed permanently "unregistered".
 *
 * Positive entries are checked exactly (is the recorded anchor still at the
 * recorded hop). Negative entries are checked on the direct composed parent,
 * which is the case that actually moves; an SDK wrapper appearing strictly
 * BETWEEN an unchanged video and its parent is not detected here, and is not
 * claimed to be.
 */
function isMatchFresh(video, entry) {
  if (entry.parent !== (video.parentNode ?? null)) {
    return false;
  }
  if (!entry.best) {
    return true;
  }
  return anchorStillMatches(video, entry.best.el, entry.best.hops);
}

/**
 * Full ancestry scan for the owning SDK's record, or null when unregistered.
 *
 * Deliberately uncached. This used to keep a second WeakMap of its own, and it
 * was dead weight: `matchSdk` had exactly one caller, and that caller consults
 * its own descriptor memo first, so this function only ever ran on a
 * descriptor-miss - which is precisely the case where the second memo was
 * guaranteed stale by the identical parent check. Every read was a miss and
 * every write was unreachable, so the map cost an entry and an object per
 * adopted video and a second freshness check (potentially a bounded re-walk of
 * the ancestry) on every re-query after a re-parenting, and saved no scans.
 * The descriptor memo below is the only cache this path needs.
 */
function matchSdk(video) {
  // Single composed walk (uBO's one-pass-over-tokens shape): the old code
  // re-walked ancestry once per anchor via composedClosest, then walked
  // again per hit to count hops. Chain index IS the hop count, so one pass
  // serves every anchor. Selection semantics unchanged: fewest hops wins,
  // ties keep registry order then anchor order (strict < keeps the first).
  const len = fillComposedChain(video);
  let best = null;
  for (let r = 0; r < REGISTRY.length; r++) {
    const record = REGISTRY[r];
    const anchors = record.anchors;
    for (let a = 0; a < anchors.length; a++) {
      const anchor = anchors[a];
      // Bound the walk by the best hops so far: a match at or beyond that
      // index cannot win (strict < keeps the earlier record/anchor), so the
      // chain is only scanned as deep as a real improvement would need. A
      // 0-hop best collapses the bound to 0 and the rest of the registry is
      // walked with zero chain scans.
      const limit = best ? best.hops : len;
      for (let hop = 0; hop < limit; hop++) {
        if (chain[hop].matches(anchor)) {
          if (!best || hop < best.hops) {
            best = { record, el: chain[hop], hops: hop };
          }
          break;
        }
      }
    }
  }
  return best;
}

/**
 * Fully-resolved descriptor per video. Cached alongside the raw match so the
 * hot re-query path (probe/kernel re-asking about surviving videos) returns
 * the SAME object instead of re-wrapping + re-allocating every call.
 * "Fewer APIs, same facts": the scan already computes `el` and `hops`, so they
 * are surfaced at zero extra cost rather than recomputed downstream.
 *
 * The negative null is memoized too, which is what makes the entry wrapper
 * necessary: a cached `null` and an absent entry are now different things, so
 * freshness has to live on the wrapper rather than on the payload.
 */
const descriptorCache = new WeakMap();

/**
 * Identify the SDK owning a video, or null when unregistered.
 *
 * Both the positive descriptor and the negative null are memoized, so a page of
 * many non-SDK videos (ad grids, untracked embeds) does not re-run the full
 * ancestry scan per discovery pass. The WeakMap key dies with the video, so
 * entries are session-only - but the key surviving is exactly why each entry
 * is re-validated against the video's current ancestry on read (see
 * isMatchFresh): a memo that outlives the fact it recorded would make
 * detection permanently wrong after any re-parenting.
 */
export function findSdkForVideo(video) {
  const cached = descriptorCache.get(video);
  if (cached && isMatchFresh(video, cached)) {
    return cached.best ? cached.descriptor : null;
  }
  const match = matchSdk(video);
  const entry = { best: match, parent: video.parentNode ?? null, descriptor: null };
  if (!match) {
    descriptorCache.set(video, entry);
    return null;
  }
  entry.descriptor = {
    name: match.record.name,
    host: match.record.host ?? null,
    container: resolveContainer(match),
    anchor: match.el,
    hops: match.hops
  };
  descriptorCache.set(video, entry);
  return entry.descriptor;
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
  const len = fillComposedChain(el);
  for (let hop = 0; hop < len; hop++) {
    if (chain[hop].matches(record.host)) {
      return chain[hop];
    }
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

/**
 * Invoke `visit` for every <video> entering the DOM in a MutationObserver
 * batch's added nodes.
 *
 * Callback instead of a generator: the old `function*` + `yield* NodeList`
 * form allocated a generator object (and a NodeList iterator) per batch per
 * subscriber, and the added-node walk is on the kernel's hot discovery path.
 * The NodeList is walked by index here, which is also the cheapest way to
 * drain it.
 */
export function forEachVideoInMutations(mutations, visit) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      // Cheap element guard: text/comment nodes and the subtree we already
      // know is empty of videos can't yield a <video>, so skip the
      // querySelectorAll scan (which would otherwise run per added node on
      // every mutation batch of an SPA page).
      if (node.nodeType !== 1) {
        continue;
      }
      if (node.localName === "video") {
        visit(node);
      } else if (node.querySelectorAll) {
        const videos = node.querySelectorAll("video");
        for (let i = 0; i < videos.length; i++) {
          visit(videos[i]);
        }
      }
    }
  }
}

/** Shared adoption gate: the rendered box must reach minimum player size. */
export function meetsMinSize(video, minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT) {
  // Layout-free visibility pre-gate: hidden-but-sized players (carousels,
  // display:none / visibility:hidden / opacity:0 trees) are rejected without
  // forcing a layout flush via getBoundingClientRect. Feature-detect keeps
  // jsdom (no checkVisibility) and any stragglers on the rect-only path - and
  // the gate is admission-negative only, so discovery can never regress.
  //
  // contentVisibilityAuto is deliberately NOT passed, even though Gecko 157
  // supports it and it would reject videos parked in a skipped
  // `content-visibility: auto` subtree (measured: such a video reports
  // checkVisibility true, and a 400x300 rect from contain-intrinsic-size, but
  // flips to false with the option set). Rejecting them would trade a
  // cosmetic win for a lost player: that subtree renders on scroll, and a
  // video that is only ever revealed that way still needs a shell ready. The
  // static probe and the media-event tap already re-run this gate, so a late
  // reveal is adopted when the video first loads or plays.
  if (typeof video.checkVisibility === "function" &&
      !video.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
    return false;
  }
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
 *
 * Accepts an optional AbortSignal: on abort the browser drops both capture
 * listeners itself - no manual unsubscribe needed for pagehide teardown. The
 * returned function stays available for early / signal-free teardown.
 */
export function watchMediaEvents(onVideo, { signal } = {}) {
  const onMediaEvent = (event) => {
    const video = videoFromEvent(event);
    if (video) {
      onVideo(video);
    }
  };
  document.addEventListener("loadeddata", onMediaEvent, { capture: true, signal });
  document.addEventListener("play", onMediaEvent, { capture: true, signal });
  return () => {
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
  };
}

/**
 * Full discovery tap used by the kernel's permanent rider: capture media
 * events plus the shared mutation dispatcher, multiplexed to a subscriber.
 * This is the heavier signal (it keeps a full-document childList+subtree
 * observer alive while subscribed); the boot probe prefers watchMediaEvents.
 * Returns the unsubscribe function.
 */
export function watchDocumentVideos(onVideo) {
  const offEvents = watchMediaEvents(onVideo);
  const offMutations = onDomMutations((mutations) => {
    forEachVideoInMutations(mutations, onVideo);
  });
  return () => {
    offEvents();
    offMutations();
  };
}
