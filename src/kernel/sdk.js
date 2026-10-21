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
 * placement. The descriptor is cached per video (same object across re-queries
 * while its ancestry holds; invalidated when the video is re-parented).
 *
 * Reserved for future needs (not implemented): corroborating selectors,
 * version gates. Adding an SDK = one record plus one fixture test.
 *
 * Selection: among all matching anchors across all records, the element with
 * the fewest composed ancestor hops from the video wins; ties break by
 * registry order, then anchor order.
 */
import { onDomMutations } from "../shared/dom.js";

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
 * Lookahead, in CSS pixels, for the on-screen deferral gates: a player is
 * considered on-screen once it is within this distance of the viewport, so a
 * shell is ready just before it is actually scrolled into view.
 */
const ON_SCREEN_MARGIN_PX = 256;

/**
 * Repeat-query memo: findSdkForVideo resolves both SDK identity and container
 * in one scan, is often asked about the same element back to back, and SPA
 * frameworks re-ask about surviving videos. WeakMap keys die with their videos
 * - session-only, never persisted.
 *
 * Each entry is stamped with the parent the scan saw, because the cache is
 * only valid while that ancestry holds: SDKs routinely take a bare <video>
 * already in the DOM and later wrap it in their own container (Video.js,
 * MediaElement, Plyr). Without a stamp, a video first seen before its wrap
 * would stay cached (including a negative null) forever. A re-parent is the
 * common, cheaply observable moment the ancestry changed, so it invalidates.
 */
const matchCache = new WeakMap();

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
  // Truncate to the filled length: the buffer is module-level and reused, so
  // without this a prior deep walk leaves the tail pointing at nodes that may
  // since have been detached - a strong reference held until the next scan.
  chain.length = len;
  return len;
}

function matchSdk(video, registry) {
  const cached = matchCache.get(video);
  if (cached && cached.parent === video.parentNode && cached.registry === registry) {
    return cached.value;
  }
  // Single composed walk (uBO's one-pass-over-tokens shape): the old code
  // re-walked ancestry once per anchor via composedClosest, then walked
  // again per hit to count hops. Chain index IS the hop count, so one pass
  // serves every anchor. Selection semantics unchanged: fewest hops wins,
  // ties keep registry order then anchor order (strict < keeps the first).
  const len = fillComposedChain(video);
  let best = null;
  for (let r = 0; r < registry.length; r++) {
    const record = registry[r];
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
  matchCache.set(video, { value: best, parent: video.parentNode, registry });
  return best;
}

/**
 * Fully-resolved descriptor per video. Cached alongside the raw match so the
 * hot re-query path (probe/kernel re-asking about surviving videos) returns
 * the SAME object instead of re-wrapping + re-allocating every call.
 * "Fewer APIs, same facts": the scan already computes `el` and `hops`, so they
 * are surfaced at zero extra cost rather than recomputed downstream.
 *
 * Parent-stamped like matchCache: a descriptor names a specific container, so
 * it is only valid for the ancestry it resolved against. A re-parent (SDK
 * wrap, SPA re-render reusing the video node) invalidates it; the next query
 * re-scans and the container/anchor follow the new tree instead of pointing at
 * a detached node.
 */
const descriptorCache = new WeakMap();

/**
 * Identify the SDK owning a video, or null when unregistered.
 *
 * Caches BOTH the positive descriptor and the negative null, so a page of
 * many non-SDK videos (ad grids, untracked embeds) never re-runs the full
 * ancestry scan per discovery pass. The WeakMap key dies with the video, so
 * entries are session-only. Detection is deterministic for a given composed
 * ancestry, but not across a re-parent: the entry is parent-stamped and
 * re-scanned the moment the video moves, so a bare <video> that a player SDK
 * later wraps is re-evaluated instead of staying cached as unrecognised.
 *
 * `registry` defaults to the production REGISTRY and is injectable so records
 * it does not exercise (currently `host`) stay testable without exporting
 * resolveContainer. The cache stamp carries the registry reference, so a
 * custom registry can never serve a production hit.
 */
export function findSdkForVideo(video, registry = REGISTRY) {
  const cached = descriptorCache.get(video);
  if (cached !== undefined && cached.parent === video.parentNode && cached.registry === registry) {
    return cached.descriptor;
  }
  const match = matchSdk(video, registry);
  if (!match) {
    descriptorCache.set(video, { descriptor: null, parent: video.parentNode, registry });
    return null;
  }
  const descriptor = {
    name: match.record.name,
    host: match.record.host ?? null,
    container: resolveContainer(match),
    anchor: match.el,
    hops: match.hops
  };
  descriptorCache.set(video, { descriptor, parent: video.parentNode, registry });
  return descriptor;
}

/**
 * Resolve the element that hosts the shell DOM: the matched record's `host`
 * override, else the matched element itself. Private to the engine; the
 * host branch (unexercised by the current registry) is driven in tests by
 * passing a synthetic registry to findSdkForVideo.
 */
function resolveContainer({ record, el }) {
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
function forEachVideoInMutations(mutations, visit) {
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

/**
 * CSS-presence pre-gate shared by the synchronous size gate, the
 * observer-driven layout gate, and the probe's escalation decision: false when
 * the element (or a content-visibility:auto subtree it sits in) is not
 * currently generating a painted box. `contentVisibilityAuto`
 * covers the case the old two-option call missed - a `content-visibility:
 * auto` player scrolled out of view keeps a layout placeholder (non-zero box)
 * but is skipped from rendering, so a stale size would wrongly admit it.
 * Feature-detected: hosts without checkVisibility (jsdom, older engines) report
 * present, so removal of the API can only make us more permissive, never less -
 * it gates both size admission and the probe's escalation decision, and a false
 * "present" costs at most the work we did before the check existed.
 */
export function hasPresentBox(el) {
  return typeof el.checkVisibility !== "function"
    || el.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true
    });
}

/** Shared synchronous adoption gate: the measured box must reach min size. */
export function meetsMinSize(video, minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT) {
  if (!hasPresentBox(video)) {
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
 * Size reported by a ResizeObserver entry, read straight from the delivered
 * observation instead of calling getBoundingClientRect() - the browser already
 * computed and handed us the box, so reading it here never forces a style +
 * layout flush. Prefers the border box (the same quantity the synchronous gate
 * reads) and falls back through contentBoxSize to the legacy contentRect for
 * hosts that omit it. `inlineSize`/`blockSize` are logical axes; in the
 * horizontal writing mode every video player uses they are width/height.
 */
function entryBoxSize(entry) {
  const border = entry.borderBoxSize?.[0];
  if (border) {
    return { width: border.inlineSize, height: border.blockSize };
  }
  const content = entry.contentBoxSize?.[0];
  if (content) {
    return { width: content.inlineSize, height: content.blockSize };
  }
  const rect = entry.contentRect;
  return { width: rect.width, height: rect.height };
}

/**
 * Shared engine behind createLayoutGate / createOnScreenGate. Both gates are
 * the same step shape: register an element + callback in a WeakMap, let ONE
 * observer fire the callback exactly once when the element qualifies, dedupe
 * repeat watches, and tear everything down in one stop(). They differ only in
 * which observer is used, what "qualifies" means, what an API-less host falls
 * back to, and an optional side-channel listener with its own teardown.
 *
 * `createObserver(cb)` returns a fresh observer, or null when the host lacks
 * the API (then `fallbackWatch` stands in). `qualifies(entry)` decides an
 * observer entry is a pass. `extras(qualify)` may register a side-channel
 * listener and returns its teardown.
 */
function createPresenceGate({ createObserver, qualifies, fallbackWatch, extras, prune = true }) {
  if (!createObserver) {
    return { watch: fallbackWatch, stop() {} };
  }
  // WeakMap, not Map: neither observer notifies when an observed target is
  // removed from the DOM, so a detached candidate that never qualified would
  // otherwise be pinned (and so would the callback) until stop() - a leak
  // that matters for the long-lived kernel gate on an SPA that recycles
  // players. stop() swaps in a fresh one instead of clear().
  let waiting = new WeakMap();

  // Native target-list hygiene. Browsers keep observed elements in the
  // observer's own (C++) target list until an explicit unobserve, so a
  // candidate that leaves the document while still player-unknown pins the
  // gate even after the JS-side WeakMap entry is unreachable. The prune
  // piggybacks on the shared dom-watch feed (one WeakMap.has per removal,
  // zero steady-state cost) and arms lazily on the first watch, so a
  // video-less document never opens the document observer. A candidate
  // pruned this way loses its pending RO/IO callback, but a re-adoptable
  // player re-enters adoption through the discovery/media taps, so
  // re-armed watching happens on the same event that makes it qualifiable.
  const pruneSupported = typeof MutationObserver === "function";
  const pruneDetached = (records) => {
    for (const record of records) {
      const removed = record.removedNodes;
      if (!removed) {
        continue;
      }
      for (const node of removed) {
        if (waiting.has(node)) {
          observer.unobserve(node);
          waiting.delete(node);
        }
      }
    }
  };
  // Armed on first watch (see the comment above); also rearms after stop().
  let offPrune = null;

  function qualify(target) {
    if (!waiting.has(target)) {
      return;
    }
    const onQualify = waiting.get(target);
    observer.unobserve(target);
    waiting.delete(target);
    onQualify?.();
  }
  const observer = createObserver((entries) => {
    for (const entry of entries) {
      if (waiting.has(entry.target) && qualifies(entry)) {
        qualify(entry.target);
      }
    }
  });
  const removeExtras = extras?.(qualify);
  return {
    watch(target, onQualify) {
      if (waiting.has(target)) {
        return;
      }
      if (!offPrune && pruneSupported && prune) {
        offPrune = onDomMutations(pruneDetached);
      }
      waiting.set(target, onQualify);
      observer.observe(target);
    },
    stop() {
      observer.disconnect();
      offPrune?.();
      offPrune = null;
      removeExtras?.();
      waiting = new WeakMap();
    }
  };
}

/**
 * Observer-driven layout-presence gate. Watches candidates that are not yet
 * player-sized and calls back the first time their delivered ResizeObserver
 * box both reaches minimum size AND passes the CSS-presence check. Because
 * the measurement comes from the queued observation - taken after layout, off
 * the mutation/media task - the callback path never forces a synchronous
 * reflow, unlike a one-shot getBoundingClientRect() at insert time. It also
 * keeps re-checking a video that was inserted small and only later sized by
 * CSS (the case a rect read at insert time can never adopt) and one whose
 * `content-visibility: auto` subtree only becomes rendered when scrolled in.
 *
 * One gate instance per watcher (probe/kernel): `watch` dedupes repeated
 * signals for the same element, `stop` tears everything down with the owner.
 * jsdom has no real ResizeObserver, so the fallback reuses the synchronous
 * gate and still qualifies immediately.
 */
export function createLayoutGate({ minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT, prune = true } = {}) {
  // content-visibility: auto subtrees report an unchanged placeholder box to
  // ResizeObserver when they flip back into rendering, so the delivered size
  // alone can never re-qualify one. The native autostatechange event is the
  // exact reveal signal; a document-level capture listener catches its
  // non-bubbling dispatch without a per-target listener that would otherwise
  // pin a detached, never-sized video. Guarded so a host without a global
  // document (the unit harness before it installs one) still constructs.
  const doc = typeof document !== "undefined" ? document : null;
  return createPresenceGate({
    prune,
    createObserver: typeof ResizeObserver === "function"
      ? (cb) => new ResizeObserver(cb)
      : null,
    qualifies: (entry) => {
      const { width, height } = entryBoxSize(entry);
      return width >= minWidth && height >= minHeight && hasPresentBox(entry.target);
    },
    fallbackWatch: (video, onQualify) => {
      if (meetsMinSize(video, minWidth, minHeight)) {
        onQualify();
      }
    },
    extras: (qualify) => {
      const onReveal = (event) => {
        const target = event.target;
        if (target && meetsMinSize(target, minWidth, minHeight)) {
          qualify(target);
        }
      };
      doc?.addEventListener("contentvisibilityautostatechange", onReveal, true);
      return () => doc?.removeEventListener("contentvisibilityautostatechange", onReveal, true);
    }
  });
}

/**
 * Synchronous viewport-presence check. Uses the element's client rect - the
 * caller has usually just measured it, so a second read with no intervening
 * write is served from the same layout - against the layout viewport with a
 * lookahead margin. When viewport size is unknown (no window, or a harness
 * reporting zero inner sizes) it reports present, so missing viewport
 * information can only make adoption more permissive, never strand a player.
 */
export function isOnScreen(el, margin = ON_SCREEN_MARGIN_PX) {
  if (!el || typeof el.getBoundingClientRect !== "function") {
    return true;
  }
  const win = typeof window !== "undefined" ? window : null;
  const vw = win?.innerWidth || win?.document?.documentElement?.clientWidth || 0;
  const vh = win?.innerHeight || win?.document?.documentElement?.clientHeight || 0;
  if (!vw || !vh) {
    return true;
  }
  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return true;
  }
  return rect.bottom + margin >= 0
    && rect.right + margin >= 0
    && rect.top - margin <= vh
    && rect.left - margin <= vw;
}

/**
 * IntersectionObserver-backed on-screen gate for deferring adoption/render of
 * off-screen players. One observer per owner; `watch` dedupes per element,
 * fires `onEnter` once when the element first intersects (lookahead margin, so
 * the shell is ready just before it scrolls into view), then unobserves.
 * Without an IntersectionObserver the gate is a pass-through that fires
 * immediately, so a host lacking the API keeps the previous eager behavior.
 */
export function createOnScreenGate({ rootMargin = `${ON_SCREEN_MARGIN_PX}px`, prune = true } = {}) {
  return createPresenceGate({
    prune,
    createObserver: typeof IntersectionObserver === "function"
      ? (cb) => new IntersectionObserver(cb, { rootMargin })
      : null,
    qualifies: (entry) => entry.isIntersecting,
    fallbackWatch: (_el, onEnter) => onEnter()
  });
}

/**
 * Capture-phase media-event tap with NO mutation observer - the cheap floor of
 * every discovery tap (createDiscoveryTap). The boot probe starts here and only
 * commits to a full-document observer once there is evidence of a player.
 * Media events travel the composed path to document, so even shadow-hosted SDK
 * videos surface here without any subtree observer.
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
  // loadedmetadata is the earliest reliable "a real media resource loaded"
  // signal: a preload="none" or autoplay-blocked player fires it well before
  // loadeddata (which needs frame data) and can otherwise stay invisible to
  // discovery until the user presses play. loadeddata still matters for
  // players that surface metadata only on data; play catches late starts.
  document.addEventListener("loadedmetadata", onMediaEvent, { capture: true, signal });
  document.addEventListener("loadeddata", onMediaEvent, { capture: true, signal });
  document.addEventListener("play", onMediaEvent, { capture: true, signal });
  return () => {
    document.removeEventListener("loadedmetadata", onMediaEvent, true);
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
  };
}

/**
 * One discovery tap: the capture-phase media-event feed plus, optionally, the
 * shared full-document mutation feed, multiplexed into a single `onVideo`.
 * `escalate()` upgrades a media-only tap to the full tap in place, so the boot
 * probe can start cheap and commit to the document observer only once there is
 * evidence of a player. `stop()` detaches whichever feeds are live. This is the
 * single definition of how videos are discovered; the kernel and the boot
 * probe differ only in when they escalate.
 */
export function createDiscoveryTap(onVideo, { mutations = true } = {}) {
  const offEvents = watchMediaEvents(onVideo);
  let offMutations = null;
  const escalate = () => {
    if (!offMutations) {
      offMutations = onDomMutations((records) => forEachVideoInMutations(records, onVideo));
    }
  };
  if (mutations) {
    escalate();
  }
  return {
    escalate,
    stop() {
      offEvents();
      offMutations?.();
      offMutations = null;
    }
  };
}
