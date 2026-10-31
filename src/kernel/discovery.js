/**
 * Video discovery: when a player surfaces, and when it is ready.
 *
 * Two timing questions with one shared answer machinery:
 *   1. Presence checks  - synchronous, no observer: videoFromEvent, detection
 *                         of a painted box, min size, on-screen lookahead
 *   2. Presence gates   - observer-driven, exactly-once, self-pruning:
 *                         PresenceGate + createLayoutGate/createOnScreenGate
 *   3. Discovery taps   - watchMediaEvents + DiscoveryTap (createDiscoveryTap):
 *                         one definition of how videos surface, escalated from
 *                         the cheap media-event floor to the shared document
 *                         feed once evidence of a player exists
 *   4. Boot probe       - installVideoProbe, the pre-kernel sentinel that
 *                         defers the full kernel boot until a document
 *                         actually shows a player candidate
 *
 * The boot probe and the kernel arm the same machinery with different
 * escalation discipline (the probe's contract: a video-less or hidden-only
 * page never opens a document-wide observer); the kernel keeps discovery
 * alive via the media-event floor between player generations. Which SDK owns
 * a video is NOT this module's question - that lives in detection.js.
 */
import { onDomMutations, layoutViewport } from "../shared/dom.js";
import { logger } from "../shared/runtime.js";

/** Player thresholds: the measured box must reach this to count as a player. */
export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

/**
 * Lookahead, in CSS pixels, for the on-screen deferral gates: a player is
 * considered on-screen once it is within this distance of the viewport, so a
 * shell is ready just before it is actually scrolled into view.
 */
const ON_SCREEN_MARGIN_PX = 256;

/**
 * Resolve the real <video> for a media event. Media events don't bubble, but
 * capture listeners on document still receive them through the composed path -
 * where shadow-DOM hosts retarget event.target away from the actual video
 * (open roots only; closed roots are unreachable by design).
 */
function videoFromEvent(event) {
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
      // every mutation batch on a busy page).
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
 * Static seeding walk: invoke `visit` for every <video> already in the
 * parsed document, with no observer behind it. The same input shape as
 * forEachVideoInMutations (videos surface without any event or batch) -
 * probe.checkStatic and the kernel's tap arm share it.
 */
export function forEachVideoInDocument(visit) {
  const present = document.querySelectorAll("video");
  for (const video of present) {
    visit(video);
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
 * checkVisibility is floor-guaranteed (Chromium 105; present on the Firefox
 * 159 page surface, verified live): the
 * old "hosts without the API report present" arm answered the retired jsdom
 * host and pre-floor engines, so the call is unconditional now.
 */
function hasPresentBox(el) {
  return el.checkVisibility({
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

/* - 2. Presence gates - */

/**
 * Shared engine behind createLayoutGate / createOnScreenGate. Both gates are
 * the same step shape: register an element + callback in a WeakMap, let ONE
 * observer fire the callback exactly once when the element qualifies, dedupe
 * repeat watches, and tear everything down in one stop(). They differ only in
 * which observer is used, what "qualifies" means, and an optional
 * side-channel listener with its own teardown.
 *
 * `createObserver(cb)` returns a fresh observer. `qualifies(entry)` decides an
 * observer entry is a pass. `extras(qualify)` may register a side-channel
 * listener and returns its teardown. Both ResizeObserver (79) and
 * IntersectionObserver (51) are floor-guaranteed, so there is no API-less
 * stand-in arm: the JS fallbacks and the field that gated them (per-instance
 * `typeof` reads against a harness that swapped MutationObserver) died with
 * their premises - the retired jsdom host and the ship floor.
 *
 * `#waiting` is a WeakMap, not a Map: neither observer notifies when an
 * observed target is removed from the DOM, so a detached candidate that never
 * qualified would otherwise be pinned (and so would the callback) until
 * stop() - a leak that matters for the long-lived kernel gate on a page that
 * recycles players. stop() swaps in a fresh one instead of clear().
 *
 * Native target-list hygiene. Browsers keep observed elements in the
 * observer's own (C++) target list until an explicit unobserve, so a
 * candidate that leaves the document while still player-unknown pins the
 * gate even after the JS-side WeakMap entry is unreachable. The prune
 * piggybacks on the shared document feed (one WeakMap.has per removal,
 * zero steady-state cost) and arms lazily on the first watch, so a
 * video-less document never opens the document observer. A candidate
 * pruned this way loses its pending RO/IO callback, but a re-adoptable
 * player re-enters adoption through the discovery/media taps, so
 * re-armed watching happens on the same event that makes it qualifiable.
 */
class PresenceGate {
  #waiting = new WeakMap();
  #observer;
  #offPrune = null;
  #removeExtras = null;
  #qualifies;
  #prune;

  constructor({ createObserver, qualifies, extras, prune = true }) {
    this.#qualifies = qualifies;
    this.#prune = prune;
    this.#observer = createObserver((entries) => this.#onEntries(entries));
    this.#removeExtras = extras ? extras((target) => this.#qualify(target)) : null;
  }

  #onEntries(entries) {
    for (const entry of entries) {
      if (this.#waiting.has(entry.target) && this.#qualifies(entry)) {
        this.#qualify(entry.target);
      }
    }
  }

  #qualify(target) {
    if (!this.#waiting.has(target)) {
      return;
    }
    const onQualify = this.#waiting.get(target);
    this.#observer.unobserve(target);
    this.#waiting.delete(target);
    onQualify?.();
  }

  /** Notifies `onQualify` exactly once when the target qualifies. */
  watch(target, onQualify) {
    if (this.#waiting.has(target)) {
      return;
    }
    // Armed on first watch (see the class comment); also rearms after stop().
    if (!this.#offPrune && this.#prune) {
      this.#offPrune = onDomMutations((records) => this.#pruneDetached(records));
    }
    this.#waiting.set(target, onQualify);
    this.#observer.observe(target);
  }

  #pruneDetached(records) {
    for (const record of records) {
      const removed = record.removedNodes;
      if (!removed) {
        continue;
      }
      for (const node of removed) {
        if (this.#waiting.has(node)) {
          this.#observer.unobserve(node);
          this.#waiting.delete(node);
        }
      }
    }
  }

  stop() {
    this.#observer?.disconnect();
    this.#offPrune?.();
    this.#offPrune = null;
    this.#removeExtras?.();
    this.#waiting = new WeakMap();
  }
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
 */
export function createLayoutGate({ minWidth = MIN_VIDEO_WIDTH, minHeight = MIN_VIDEO_HEIGHT, prune = true } = {}) {
  // content-visibility: auto subtrees report an unchanged placeholder box to
  // ResizeObserver when they flip back into rendering, so the delivered size
  // alone can never re-qualify one. The native autostatechange event is the
  // exact reveal signal; a document-level capture listener catches its
  // non-bubbling dispatch without a per-target listener that would otherwise
  // pin a detached, never-sized video. The document itself needs no guard:
  // every consumer constructs against a real browser frame, and the
  // unit-harness host the old `typeof document` arm answered died with the
  // tool-era retirement.
  return new PresenceGate({
    prune,
    // ResizeObserver is floor-guaranteed (Chromium 79, Firefox 69+ - both
    // branch floor engines carry it); the null
    // stand-in arm that fed fallbackWatch died with its jsdom premise.
    createObserver: (cb) => new ResizeObserver(cb),
    qualifies: (entry) => {
      const { width, height } = entryBoxSize(entry);
      return width >= minWidth && height >= minHeight && hasPresentBox(entry.target);
    },
    extras: (qualify) => {
      const onReveal = (event) => {
        const target = event.target;
        if (target && meetsMinSize(target, minWidth, minHeight)) {
          qualify(target);
        }
      };
      // The reveal listener rides its own abort signal: teardown is the
      // controller's abort, the same native drop every other listener in the
      // tree gets - no manual capture removeEventListener pairing.
      const ac = new AbortController();
      document.addEventListener("contentvisibilityautostatechange", onReveal, { capture: true, signal: ac.signal });
      return () => ac.abort();
    }
  });
}

/**
 * Synchronous viewport-presence check. Uses the element's client rect - the
 * caller has usually just measured it, so a second read with no intervening
 * write is served from the same layout - against the layout viewport
 * (layoutViewport(), the shared read in shared/dom.js) with a lookahead
 * margin; a zero viewport reports present. Kernel cannot ride the shared
 * ReferenceBox here: that owner's lifetime starts with the shell and its
 * inline answer is the container's own box, while this gate asks presence
 * against the full viewport for pre-shell candidates - two different
 * datums by construction, joined only at the viewport read. The old
 * `typeof window` arm died with the retired unit-harness host that was
 * its only other premise.
 */
export function isOnScreen(el, margin = ON_SCREEN_MARGIN_PX) {
  if (!el || typeof el.getBoundingClientRect !== "function") {
    return true;
  }
  const { width: vw, height: vh } = layoutViewport();
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
 * IntersectionObserver is floor-guaranteed (Chromium 51, Firefox 55+ - both
 * branch floor engines carry it): the
 * pass-through stand-in arm died with its pre-floor-engine premise.
 */
export function createOnScreenGate({ rootMargin = `${ON_SCREEN_MARGIN_PX}px`, prune = true } = {}) {
  return new PresenceGate({
    prune,
    createObserver: (cb) => new IntersectionObserver(cb, { rootMargin }),
    qualifies: (entry) => entry.isIntersecting
  });
}

/* - 3. Discovery taps - */

/**
 * Capture-phase media-event tap with NO mutation observer - the cheap floor of
 * every discovery tap (DiscoveryTap). The boot probe starts here and only
 * commits to a full-document observer once there is evidence of a player.
 * Media events travel the composed path to document, so even shadow-hosted SDK
 * videos surface here without any subtree observer.
 *
 * The returned function tears the tap down; the capture listeners ride one
 * controller, so teardown is a single abort - no manual removal list.
 */
function watchMediaEvents(onVideo) {
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
  // One native teardown: every listener rides the controller's signal, so
  // stop() is a single abort() - the turn has no manual removal list.
  const scope = new AbortController();
  document.addEventListener("loadedmetadata", onMediaEvent, { capture: true, signal: scope.signal });
  document.addEventListener("loadeddata", onMediaEvent, { capture: true, signal: scope.signal });
  document.addEventListener("play", onMediaEvent, { capture: true, signal: scope.signal });
  return () => scope.abort();
}

/**
 * One discovery tap: the capture-phase media-event feed plus, optionally, the
 * shared full-document mutation feed, multiplexed into a single `onVideo`.
 * `escalate()` upgrades a media-only tap to the full tap in place, so the boot
 * probe can start cheap and commit to the document observer only once there is
 * evidence of a player. `stop()` detaches whichever feeds are live.
 */
class DiscoveryTap {
  #onVideo;
  #offEvents;
  #offMutations = null;

  constructor(onVideo, { mutations = true } = {}) {
    this.#onVideo = onVideo;
    this.#offEvents = watchMediaEvents(onVideo);
    if (mutations) {
      this.escalate();
    }
  }

  escalate() {
    if (!this.#offMutations) {
      this.#offMutations = onDomMutations((records) => forEachVideoInMutations(records, this.#onVideo));
    }
  }

  stop() {
    this.#offEvents();
    this.#offMutations?.();
    this.#offMutations = null;
  }
}

/** Factory form kept as the public face; the state lives in DiscoveryTap. */
export function createDiscoveryTap(onVideo, { mutations = true } = {}) {
  return new DiscoveryTap(onVideo, { mutations });
}

/* - 4. Boot probe - */

/**
 * Presence probe - framework video detection.
 *
 * Two-phase sentinel that defers the full kernel boot until a document
 * actually shows a video candidate - without paying for a full-document
 * MutationObserver on pages that never host a player.
 *
 * Phase 1 (cheap, no observer): capture-phase loadedmetadata/loadeddata/play
 * listeners plus a one-time DOM-ready <video> presence check. SDK players fire
 * media events through the composed path, so a real player surfaces here with
 * zero subtree observer cost.
 *
 * Escalation (commits to the full-document observer) happens only once there
 * is evidence of a player: a rendered static <video> in the parsed DOM, or a
 * media event for a rendered <video> that has not yet reached player size. A
 * hidden <video> (no painted box) is not evidence and stays on the cheap tap,
 * so documents that only carry non-player videos never open the subtree
 * observer either.
 *
 * The first size-qualified candidate fires the candidate callback exactly
 * once; documents without a usable player never boot a kernel.
 */
class VideoProbe {
  #minWidth;
  #minHeight;
  #onCandidate;
  /** Once true, every entry point (media event, later mutation, gate) is dead. */
  #done = false;
  // Re-checks candidates that failed the size gate when their box grows: the
  // observer-driven layout-presence gate re-reads the delivered box (no forced
  // reflow) and lands off the mutation batch, so a candidate that only reaches
  // player size later would otherwise never fire. The detached-
  // target prune stays off: the probe's contract is that a video-less or
  // hidden-only page never opens the document-wide mutation feed, and the
  // probe's own gate stops at kernel boot (or pagehide), bounding any
  // unqualified target to that window.
  #layoutGate;
  // Defers a player-sized-but-off-screen candidate (a carousel of embeds) so a
  // full kernel boot is not paid for a video the user cannot see. The lookahead
  // margin readies the shell just before it scrolls in. Same prune reasoning.
  #onScreenGate;
  // Starts as the cheap media-event tap; consider() escalates it to the full
  // document observer once a rendered candidate appears (see below).
  #tap;

  constructor({ minWidth, minHeight, onCandidate }) {
    this.#minWidth = minWidth;
    this.#minHeight = minHeight;
    this.#onCandidate = onCandidate;
    this.#layoutGate = createLayoutGate({ minWidth, minHeight, prune: false });
    this.#onScreenGate = createOnScreenGate({ prune: false });
    this.#tap = createDiscoveryTap((video) => this.#consider(video), { mutations: false });

    // Cheap deferred check (atomic, no observer): videos already in the parsed
    // DOM surface without any media event or mutation subscription.
    const checkStatic = () => {
      if (this.#done) {
        return;
      }
      // #consider() owns the escalation decision per video (present-and-small
      // escalates; hidden does not), so there is no blanket escalate() here -
      // that would arm the observer for a page whose only videos are hidden.
      forEachVideoInDocument((video) => this.#consider(video));
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", checkStatic, { once: true });
    } else {
      checkStatic();
    }
  }

  #detach() {
    this.#tap.stop();
    this.#layoutGate.stop();
    this.#onScreenGate.stop();
  }

  #finish() {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#detach();
    logger.log("probe", "Video candidate found - booting kernel");
    this.#onCandidate();
  }

  // A player-sized candidate that is not yet on screen (a carousel slide, a
  // below-the-fold embed) is deferred rather than booted: the lookahead margin
  // readies the shell just before it scrolls in. isOnScreen reports true when
  // the viewport is unknown, so this can only delay, never strand.
  #tryFinish(video) {
    if (this.#done) {
      return;
    }
    if (isOnScreen(video)) {
      this.#finish();
      return;
    }
    this.#onScreenGate.watch(video, () => this.#tryFinish(video));
  }

  #consider(video) {
    if (this.#done) {
      return;
    }
    if (meetsMinSize(video, this.#minWidth, this.#minHeight)) {
      this.#tryFinish(video);
      return;
    }
    // Commit to the full-document observer only when the video is actually
    // rendered. A hidden <video> is common and not a player: a decoder/canvas
    // texture source (display:none), a pre-rendered off-screen embed, or a
    // content-visibility:auto subtree that is skipped. Escalating for one of
    // those keeps a document-wide observer (and its per-batch JS scan) alive
    // for the whole page on a site that will never boot a kernel. A hidden
    // candidate still goes under the layout gate, so a later reveal that
    // changes its box can qualify it, and a hidden-but-real player is caught
    // when it starts loading/playing (media events route back here).
    if (hasPresentBox(video)) {
      this.#tap.escalate();
    }
    this.#layoutGate.watch(video, () => this.#tryFinish(video));
  }

  /**
   * Idempotent teardown - cancels discovery when the kernel never boots. A
   * no-op after a candidate fired (#finish already detached), so the caller
   * owns the pagehide decision: keep discovery across a bfcache hide and
   * release it on a real unload.
   */
  stop() {
    if (!this.#done) {
      this.#done = true;
      this.#detach();
    }
  }
}

export function installVideoProbe(options) {
  const probe = new VideoProbe(options);
  return () => probe.stop();
}
