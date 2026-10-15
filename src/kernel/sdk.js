/**
 * Player template engine: structural, never semantic.
 *
 * Detection is template-driven: every major player framework declares its
 * DOM shape below as an anonymous anchor list, and a video is adopted when
 * its composed ancestry contains one. An anchor must be framework-namespaced
 * (prefixed class, dedicated data attribute, or custom element tag), so pages
 * merely styling a <div class="player"> stay unrecognized rather than
 * misidentified. Coverage grows by adding templates.
 *
 * Templates carry no names and no sources: there is no SDK identity in this
 * file, only shapes and the containers they resolve. The shell-facing
 * descriptor carries the resolved container (plus the matched anchor element
 * and its hop distance, both computed free during the scan) and a label
 * derived from the matched element for logs - div.jwplayer, video-js -
 * so readable diagnostics need no registry of names behind them. Videos no
 * template claims stay unadopted: coverage grows by adding templates.
 *
 * Framework roots are never anchors. An app-shell marker like Inertia's
 * [data-page] fires for every video on the page - articles, previews, ads -
 * and resolves the container to the app root, so the host spans the whole
 * app instead of the player. A template was once added for exactly such a
 * marker and removed for exactly this reason; a framework that ships its own
 * player gets a template for the player's namespaced anchor, not the shell.
 *
 * Forks restyle freely but keep behavior: prefer anchors the framework's own
 * JS reads or writes (tech classes it sets, data-* config it parses, custom
 * tags it upgrades) over purely cosmetic ones. `.vjs-tech` survives a
 * re-skin that drops `.video-js`; `data-plyr-config` survives one that
 * drops `.plyr`.
 *
 * Template schema:
 *   anchors - selectors resolved against the video's composed ancestry
 *             (closest(), shadow-boundary aware). Each must be
 *             framework-namespaced; ordered most specific first.
 *
 * The shell-facing descriptor carries the resolved container (plus the
 * matched anchor element and its hop distance, both computed free during the
 * scan).
 *
 * Selection: among all matching anchors across all templates, the element
 * with the fewest composed ancestor hops from the video wins; ties break by
 * template order, then anchor order.
 */
import { onDomMutations } from "../shared/dom-manager.js";
import { isShadowRoot, rootNodeOf } from "../shared/shadow.js";

const TEMPLATES = [
  { anchors: [".jwplayer", ".jw-wrapper"] },
  { anchors: ["[data-vjs-player]", ".video-js", ".vjs-tech", "video-js"] },
  { anchors: ["[data-plyr]", "[data-plyr-config]", ".plyr__video-wrapper", ".plyr"] },
  { anchors: [".art-video-player", ".artplayer"] },
  { anchors: [".dplayer"] },
  // MediaElement 7 no longer writes containers from JS (only mejs-controls
  // survives in the bundle); .mejs__container lives on in the v7
  // stylesheet, and .mejs-container is the v4-era name. Both stay: one
  // covers current players, one the legacy ones still serving old markup.
  { anchors: [".mejs-container", ".mejs__container"] },
  { anchors: [".xgplayer"] },
  { anchors: [".prism-player"] },
  { anchors: [".fluid_video_wrapper"] },
  { anchors: [".fp-player", "flowplayer-ui", "[data-player-id]", ".flowplayer"] },
  // data-player-id is publisher markup, not a JS string: the async-embed
  // snippet stamps it per Flowplayer's docs, so a dist grep misses it by
  // construction. .fp-player is the legacy (v6/v7) root class the native
  // v3 bundle no longer ships - kept for the old players still on it.
  // Bare data-player is Brightcove's: in-page embeds stamp data-player
  // (the player id) on the <video-js> element itself, and on .vjs-playlist
  // containers for player association. The tag row above already covers
  // the element; this row covers videos nested under a stamped wrapper.
  // Generic name, attributed writer: a page-authored data-player div with
  // a video inside would also match, which is the accepted residual -
  // the same class of risk as any framework class, minus the prefix.
  { anchors: ["[data-player]"] },
  { anchors: ["media-player"] },
  { anchors: ["mux-player"] },
  { anchors: ["radiant-media-player"] },
  // UI builds only: base-library players with no skin ship no DOM markers,
  // so there is nothing here to match. Shaka's UI adds .shaka-video-container
  // to the wrapping div (and the declarative setup marks video and container
  // with data-shaka-player*); THEOplayer fetches its own container through
  // .theoplayer-container, and its web-ui package upgrades theoplayer-ui tags.
  { anchors: [".shaka-video-container", "[data-shaka-player]", "[data-shaka-player-container]"] },
  { anchors: [".theoplayer-container", "theoplayer-ui", "theoplayer-default-ui"] },
];

export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

/**
 * Every anchor in the templates as a flat list. Single source behind
 * ANCHOR_GROUP below and the suite's `:is()`-compatibility pin: grouping
 * preserves meaning only for simple compounds (classes, attributes,
 * custom-element tags), so a combinator or pseudo here would silently
 * change what the grouped pre-check matches.
 */
export function templateAnchors() {
  return TEMPLATES.flatMap((template) => template.anchors);
}

/**
 * Every anchor in the registry as one grouped selector. `:is()` is matched
 * once per chain node instead of once per anchor per node: measured 7.0x on
 * Gecko 158 for the mixed hit/miss discovery mix (see
 * platform/browser-bench/discovery-match.bench.mjs), because a single engine
 * call replaces up to forty `matches()` round trips per node. Anchors must
 * stay `:is()`-compatible - all current ones are simple compounds (classes,
 * attributes, custom-element tags), which group without changing meaning.
 */
const ANCHOR_GROUP = `:is(${templateAnchors().join(",")})`;

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
  // Drop the tail: a previous deeper scan's nodes past `len` would otherwise
  // stay referenced here, pinning that subtree until some later scan happens
  // to run as deep - the one retention the reusable scratch would otherwise
  // buy. Indices below len are untouched, so no caller re-reads anything.
  chain.length = len;
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
 * Is a positive memo entry still true of the video's current ancestry?
 *
 * A memo that is never re-validated is wrong the moment a page moves the
 * element: SPA route changes, player re-init, and ad-slot recycling all
 * re-parent the SAME <video>, which keeps the same WeakMap key, so the old
 * answer survived forever - a video adopted by an SDK that later replaced its
 * wrapper kept resolving to the dead one. The recorded anchor is re-verified
 * at its recorded hop, which is exact: wrapper replacement and re-parenting
 * both move the anchor or change its distance.
 */
function isMatchFresh(video, entry) {
  if (entry.parent !== (video.parentNode ?? null)) {
    return false;
  }
  return anchorStillMatches(video, entry.best.el, entry.best.hops);
}

/**
 * The scan against an already-filled chain: one pass serves every anchor
 * (uBO's one-pass-over-tokens shape - chain index IS the hop count, so
 * fewest hops wins with ties keeping template then anchor order). Pure
 * reads - no layout writes anywhere in the resolve path, so sharing the
 * fill cannot flush.
 */
function matchTemplatesOnChain(len) {
  let best = null;
  for (let hop = 0; hop < (best ? best.hops : len); hop++) {
    // Grouped pre-check: one engine call per node instead of one per anchor.
    // A miss skips every anchor below; a hit resolves through the same
    // template-then-anchor order as the loop this replaced, so the winner is
    // identical - only the number of `matches()` calls changed.
    if (!chain[hop].matches(ANCHOR_GROUP)) {
      continue;
    }
    for (let r = 0; r < TEMPLATES.length; r++) {
      const anchors = TEMPLATES[r].anchors;
      for (let a = 0; a < anchors.length; a++) {
        if (chain[hop].matches(anchors[a])) {
          best = { template: TEMPLATES[r], el: chain[hop], hops: hop };
          break;
        }
      }
      if (best && best.hops === hop) {
        break;
      }
    }
  }
  return best;
}

/** Positive template descriptors by video. The memo policy (freshness check,
 *  why the null stays out) is documented on resolvePlayer, its only writer. */
const descriptorCache = new WeakMap();

/**
 * Identify the player template owning a video, or null when unrecognized.
 * Unmatched videos adopt nothing: there is no measured fallback, so the
 * null is the honest answer for bespoke players without a template.
 */
export function findPlayerForVideo(video) {
  return resolvePlayer(video);
}

/**
 * Data attributes the templates anchor on, for the upgrade watch's
 * attributeFilter (which takes exact names, not selectors). Derived from
 * the templates so a new data-anchored shape is watched without a second
 * list to drift. Sorted, deduplicated.
 */
export function templateDataAttributes() {
  const names = new Set();
  for (const template of TEMPLATES) {
    for (const anchor of template.anchors) {
      const match = /^\[([A-Za-z0-9-]+)/.exec(anchor);
      if (match && match[1].startsWith("data-")) {
        names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

/**
 * Custom-element tags the templates anchor on, for the upgrade re-offer.
 * A bare tag with a hyphen is a custom element by construction; classes,
 * ids and attribute selectors cannot be one. Derived like the data
 * attributes above, for the same no-second-list reason.
 */
export function templateCustomTags() {
  const names = new Set();
  for (const template of TEMPLATES) {
    for (const anchor of template.anchors) {
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(anchor)) {
        names.add(anchor);
      }
    }
  }
  return [...names].sort();
}

/** The one descriptor constructor: container, anchor, hops, label. */
function describe({ container, anchor, hops, label }) {
  return { container, anchor, hops, label };
}

/**
 * A readable label for a resolved element, derived from the element itself:
 * tag plus id and classes when present (div.jwplayer, video-js). Logs stay
 * informative with no registry of names behind them.
 */
function describeElement(el) {
  if (!el || typeof el.localName !== "string") {
    return "video";
  }
  let label = el.localName;
  if (typeof el.id === "string" && el.id) {
    label += `#${el.id}`;
  }
  const classes = typeof el.getAttribute === "function" ? el.getAttribute("class") : null;
  if (typeof classes === "string" && classes.trim()) {
    label += `.${classes.trim().split(/\s+/).join(".")}`;
  }
  return label;
}

/**
 * The resolve: one composed walk per offer against the template table.
 * A renamed-everything fork costs one shared scan while every known shape
 * keeps its single lookup; unmatched videos adopt nothing.
 *
 * Only the positive descriptor is memoized: the null stays unmemoized,
 * because no cheap fingerprint distinguishes "same answer" from "the video's
 * subtree was grafted under a new shape" - parent, depth and top can all
 * survive such a graft unchanged, and the one exact check (re-running the
 * scan) is the scan itself. A cached null would keep a grafted player
 * permanently unmatched with no path re-offering it (the mutation tap
 * offers the moved video, the memo calls it fresh, adoption never runs).
 * The WeakMap key dies with the video, so positive entries are session-only.
 */
export function resolvePlayer(video) {
  const cached = descriptorCache.get(video);
  if (cached && isMatchFresh(video, cached)) {
    return cached.descriptor;
  }
  const len = fillComposedChain(video);
  const match = matchTemplatesOnChain(len);
  if (match) {
    const entry = { best: match, parent: video.parentNode ?? null, descriptor: null };
    entry.descriptor = describe({
      container: match.el,
      anchor: match.el,
      hops: match.hops,
      label: describeElement(match.el)
    });
    descriptorCache.set(video, entry);
    return entry.descriptor;
  }
  return null;
}

/**
 * One survey pass over a root's videos, light and shadow alike, returning an
 * informative record per video - identity, placement context and cheap media
 * state, but never a box. This is the only sanctioned "find the videos"
 * walk: the probe's static sweep, the kernel's boot replay and the shell's
 * shadow watch all enumerate through here instead of hand-rolling their own
 * querySelectorAll, so there is one implementation to keep optimal and one
 * place the no-layout rule is pinned. Surveys are rare (boot, probe, small
 * adopted roots); offers stay allocation-lean. Reads are property-only -
 * getRootNode for the shadow bit, media state for the rest - so a survey
 * forces no layout and disturbs nothing it measures.
 */
export function describeVideo(video) {
  // Initialized, not assigned-in-try-only: rootNodeOf answers null for a
  // null or hostile object, which reads as light-DOM - the honest answer
  // is "not provably shadow", and callers only ever treat shadow as true.
  const shadow = isShadowRoot(rootNodeOf(video));
  return {
    video,
    shadow,
    hasSrc: !!(video.currentSrc || (typeof video.getAttribute === "function" && video.getAttribute("src"))),
    playing: !video.paused && !video.ended
  };
}

export function surveyVideos(root = document) {
  const found = [];
  const videos = root.querySelectorAll("video");
  for (let i = 0; i < videos.length; i++) {
    found.push(describeVideo(videos[i]));
  }
  forEachShadowVideos(root, (video) => found.push(describeVideo(video)));
  return found;
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
 * Invoke `visit` for every <video> inside an open shadow root under
 * `treeRoot`.
 *
 * querySelectorAll never crosses a shadow boundary, and the document-level
 * mutation feed cannot observe shadow trees at all (an observer on `document`
 * only sees the document tree), so the light walks are structurally blind to
 * shadow content: a video built inside a custom element's shadow root was
 * reachable only through the media-event tap's composed path
 * (videoFromEvent), i.e. only once it loaded or played. Verified on the live
 * bundle: a Plyr player whose <video> lives in an open shadow root is never
 * adopted when it sits in the parsed DOM (the static probe check and the
 * kernel boot replay both enumerate light DOM only, reaching shadow through
 * this pass inside surveyVideos), nor when
 * its wrapper is appended after boot (the added-node walk) - a permanent miss
 * for the life of the document for any shadow video that fires no media
 * event.
 *
 * Split shape (keep the light qSA("video") walk, add this shadow pass)
 * instead of one unified qSA("*") walk: measured on Gecko 158, split costs
 * +31us per 120-node added subtree and +0.83ms for a 6300-element document
 * sweep, against +37us / +1.11ms unified - the per-element work here is one
 * .shadowRoot read, not a localName compare plus the read. Two rejected
 * shapes, recorded so they are not re-tried: TreeWalker was slower than both
 * everywhere (per-node nextNode() crossings beat qSA's single C++ walk +
 * NodeList alloc), and the tempting localName allowlist filter is both wrong
 * and slower - Gecko 158 empirically allows attachShadow on div and span,
 * which a spec-memory list misses (measured F-find counts 7 vs 8), and
 * Set.has(string) over 6300 names measured 3.5ms, 5x the 0.72ms of just
 * reading .shadowRoot everywhere.
 *
  * Residual boundary (deliberate): a video appended into a shadow root that
  * already existed still produces no document-level record, and stays covered
  * only by the media-event tap. Closing it needs one MutationObserver per
  * discovered shadow root - unbounded observers on any custom-element-heavy
  * page - not worth the case. Closed roots remain invisible by design, as
  * with videoFromEvent.
  *
  * Second boundary, same verdict: a video assigned to a <slot> keeps its
  * light-DOM parents, so the composed walk never climbs through the slot
  * into the shadow tree above it - anchors strictly inside shadow past a
  * slot are missed. No observed instance (hosts carrying anchors are light
  * ancestors in every surveyed shape); a slot-aware chain walk would cost
  * every offer for a case with no witness. Recorded so it is not
  * re-derived as a discovery.
  */
function walkShadowRoot(root, visit) {
  const videos = root.querySelectorAll("video");
  for (let i = 0; i < videos.length; i++) {
    visit(videos[i]);
  }
  const els = root.querySelectorAll("*");
  for (let i = 0; i < els.length; i++) {
    const shadow = els[i].shadowRoot;
    if (shadow) {
      walkShadowRoot(shadow, visit);
    }
  }
}

export function forEachShadowVideos(treeRoot, visit) {
  // Inline .shadowRoot check here; walkShadowRoot is only entered for real
  // hosts - calling a per-element helper instead measured 3.9ms on the doc
  // sweep, all of it call overhead. The root's own shadow first: a mutation
  // record can carry the host itself, and querySelectorAll on that host only
  // returns its light descendants.
  const own = treeRoot.shadowRoot;
  if (own) {
    walkShadowRoot(own, visit);
  }
  const els = treeRoot.querySelectorAll("*");
  for (let i = 0; i < els.length; i++) {
    const shadow = els[i].shadowRoot;
    if (shadow) {
      walkShadowRoot(shadow, visit);
    }
  }
}

/**
 * Invoke `visit` for every <video> entering the DOM in a MutationObserver
 * batch's added nodes.
 *
 * Callback instead of a generator: the old `function*` + `yield* NodeList`
 * form allocated a generator object (and a NodeList iterator) per batch per
 * subscriber, and the added-node walk is on the kernel's hot discovery path.
 * The NodeList is walked by index here, which is also the cheapest way to
 * drain it: a live list's iterator does not scalar-replace the way a plain
 * array's does (priced 2.9× on Gecko 158 in jit-shape.bench.mjs), so for..of
 * would reintroduce exactly the allocation the generator removal took out.
 * Shadow content under the added subtree is picked up by
 * forEachShadowVideos (see its comment for the gap this closes).
 */
export function forEachVideoInMutations(mutations, visit) {
  for (let m = 0; m < mutations.length; m++) {
    const addedNodes = mutations[m].addedNodes;
    for (let i = 0; i < addedNodes.length; i++) {
      const node = addedNodes[i];
      // Cheap element guard: text/comment nodes have no subtree and cannot
      // host a shadow root, so skip both scans (which would otherwise run
      // per added node on every mutation batch of an SPA page).
      if (node.nodeType !== 1) {
        continue;
      }
      if (node.localName === "video") {
        visit(node);
      } else if (node.querySelectorAll) {
        const videos = node.querySelectorAll("video");
        for (let j = 0; j < videos.length; j++) {
          visit(videos[j]);
        }
        forEachShadowVideos(node, visit);
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
