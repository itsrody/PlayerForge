/**
 * SDK detection engine.
 *
 * Detection is registry-driven: every supported player SDK declares exactly one
 * record below, and a video is adopted only when its composed ancestry contains
 * one of that SDK's anchors. An anchor must be owned by its SDK (prefixed
 * class, dedicated data attribute, or custom element tag), so pages merely
 * styling a <div class="player"> stay unrecognized rather than misidentified.
 * Coverage grows by adding records.
 *
 * The registry answers first. Below it, `findGenericPlayer` offers a
 * default-on measured fallback (gated on a setting the kernel checks) for
 * videos no record claims - renamed-everything forks and bespoke players.
 * It trades the anchor for behavioral gates (playing, visible, user-driven)
 * plus measured placement under stricter admission, and it announces its
 * first adoption with a hint pointing at its toggle.
 *
 * Learned prints sit between anchor and measurement: a successful fallback
 * adoption records its player block per hostname, and the next visit matches
 * the print like an anchor instead of re-measuring. All three probes share
 * one ancestry walk inside resolvePlayer, in registry-learned-generic
 * priority.
 *
 * Framework roots are never anchors. An app-shell marker like Inertia's
 * [data-page] fires for every video on the page - articles, previews, ads -
 * and resolves the container to the app root, so the host spans the whole
 * app instead of the player. A record was once added for exactly such a
 * marker and removed for exactly this reason; a framework that ships its own
 * player gets a record for the player's namespaced anchor, not the shell.
 *
 * Forks restyle freely but keep behavior: prefer anchors the SDK's own JS
 * reads or writes (tech classes it sets, data-* config it parses, custom
 * tags it upgrades) over purely cosmetic ones. `.vjs-tech` survives a
 * re-skin that drops `.video-js`; `data-plyr-config` survives one that
 * drops `.plyr`.
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
 * re-query. `source` names the path that produced it (registry, generic or
 * learned): identical shapes, but a reader deciding whether to learn from an
 * adoption needs to know which one fired.
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
  { name: "Video.js", anchors: ["[data-vjs-player]", ".video-js", ".vjs-tech", "video-js"] },
  { name: "Plyr", anchors: ["[data-plyr]", "[data-plyr-config]", ".plyr__video-wrapper", ".plyr"] },
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
  // UI builds only: base-library players with no skin ship no DOM markers,
  // so there is nothing here to match. Shaka's UI adds .shaka-video-container
  // to the wrapping div (and the declarative setup marks video and container
  // with data-shaka-player*); THEOplayer fetches its own container through
  // .theoplayer-container, and its web-ui package upgrades theoplayer-ui tags.
  { name: "Shaka Player", anchors: [".shaka-video-container", "[data-shaka-player]", "[data-shaka-player-container]"] },
  { name: "THEOplayer", anchors: [".theoplayer-container", "theoplayer-ui", "theoplayer-default-ui"] },
];

export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

/**
 * Stricter admission for the anchorless fallback. The registry trusts its
 * anchors at thumbnail size; a measured guess pays for its uncertainty with
 * a bigger box - preview tiles, spacers and call-grid thumbnails stay out
 * while every real player clears it by multiples.
 */
export const GENERIC_MIN_VIDEO_WIDTH = 200;
export const GENERIC_MIN_VIDEO_HEIGHT = 120;

/**
 * Every anchor in the registry as one grouped selector. `:is()` is matched
 * once per chain node instead of once per anchor per node: measured 7.0x on
 * Gecko 158 for the mixed hit/miss discovery mix (see
 * platform/browser-bench/discovery-match.bench.mjs), because a single engine
 * call replaces up to forty `matches()` round trips per node. Anchors must
 * stay `:is()`-compatible - all current ones are simple compounds (classes,
 * attributes, custom-element tags), which group without changing meaning.
 */
const ANCHOR_GROUP = `:is(${REGISTRY.flatMap((record) => record.anchors).join(",")})`;

/**
 * Reusable composed-ancestry scratch: the match loop is fully synchronous and
 * never lets the array escape (callers keep only `el`/`record`/`hops`, never
 * the chain itself), so one array serves every full-scan instead of allocating
 * a fresh one per video. `len` is the filled length each pass.
 */
const chain = [];

/**
 * Shared empty prints list: resolvePlayer's `prints` default evaluates on
 * every call including memo hits, and the hot path must not allocate to
 * answer from cache. Read-only by convention - no probe writes to it.
 */
const NO_PRINTS = [];

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
 * fewest hops wins with ties keeping registry then anchor order),
 * and the same fill serves the print and generic probes below, so one offer
 * climbs each ancestry once instead of three times. Pure reads - no layout
 * writes anywhere in the resolve path, so sharing the fill cannot flush.
 */
function matchSdkOnChain(len) {
  let best = null;
  for (let hop = 0; hop < (best ? best.hops : len); hop++) {
    // Grouped pre-check: one engine call per node instead of one per anchor.
    // A miss skips every anchor below; a hit resolves through the same
    // registry-then-anchor order as the loop this replaced, so the winner is
    // identical - only the number of `matches()` calls changed.
    if (!chain[hop].matches(ANCHOR_GROUP)) {
      continue;
    }
    for (let r = 0; r < REGISTRY.length; r++) {
      const anchors = REGISTRY[r].anchors;
      for (let a = 0; a < anchors.length; a++) {
        if (chain[hop].matches(anchors[a])) {
          best = { record: REGISTRY[r], el: chain[hop], hops: hop };
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

/** Positive registry descriptors by video. The memo policy (freshness check,
 *  why the null stays out) is documented on resolvePlayer, its only writer. */
const descriptorCache = new WeakMap();

/**
 * Identify the SDK owning a video, or null when unregistered.
 *
 * One leg of resolvePlayer below (registry only, no prints, no fallback):
 * the memo policy and the scan live there, so this stays a thin delegate
 * with the same signature, same memo identity and same null semantics the
 * suite pins.
 */
export function findSdkForVideo(video) {
  return resolvePlayer(video);
}

/**
 * Sticky user activation: the page has seen a real user gesture since load.
 * Transient `isActive` is too narrow - it lapses the moment the press ends,
 * while the question here is whether playback on this page is user-driven at
 * all. Autoplay ads on a fresh page answer no; anything after the first click
 * answers yes. Firefox 120+, inside the floor; absent on a host without it,
 * which reads as "not activated" and keeps the slow path off - the safe
 * direction, since the registry path never asks.
 */
function hasStickyActivation() {
  if (typeof navigator === "undefined") {
    return false;
  }
  const activation = navigator.userActivation;
  return !!activation && activation.hasBeenActive === true;
}

/**
 * SDK-independent adoption candidate: a playing, sized, visible video on an
 * activated page, with no registry record. Each gate kills a false-positive
 * class: playback state (paused embeds, poster frames), sticky activation
 * (autoplay ads on fresh pages), size (thumbnails, spacers), viewport and
 * placement (below-fold carousels, ambient full-bleed backgrounds).
 *
 * Deliberately no audio/duration heuristics: muted users and short clips are
 * legitimate viewing, and each extra heuristic is a false negative for
 * someone. Emits through describe(), like every path.
 */
export function findGenericPlayer(video) {
  if (!genericGates(video)) {
    return null;
  }
  const placed = resolveGenericContainer(video);
  if (!placed) {
    return null;
  }
  return describe({
    name: "Custom player",
    host: null,
    container: placed.container,
    anchor: placed.container,
    hops: placed.hops,
    source: "generic"
  });
}

/**
 * The anchorless admission, shared by the exported probe and the unified
 * resolve below: playback state, sticky activation, and the stricter
 * fallback box. Layout-free by construction - the rect reads live in the
 * placement climb, so a gate failure pays no flush.
 */
function genericGates(video) {
  if (video.paused || video.ended || !(video.readyState >= 1)) {
    return false;
  }
  if (!hasStickyActivation()) {
    return false;
  }
  return meetsMinSize(video, GENERIC_MIN_VIDEO_WIDTH, GENERIC_MIN_VIDEO_HEIGHT);
}

/** Placement probe with its own walk; the climb itself is climbGenericContainer. */
export function resolveGenericContainer(video) {
  return placeGeneric(video, fillComposedChain(video));
}

/** The video's own box plus its document, or null when unreadable/empty. */
function videoFrame(video) {
  let rect;
  try {
    rect = video.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return null;
  }
  return { rect, doc: video.ownerDocument };
}

/**
 * Viewport refusal: full-bleed video (ambient background, not a player) and
 * fully off-viewport video. The element's own document, not the ambient one:
 * an iframe's viewport is its own, and a bare `window` read would answer for
 * the wrong frame.
 */
function viewportRefuses(rect, doc) {
  const viewportWidth = doc?.documentElement?.clientWidth ?? 0;
  const viewportHeight = doc?.documentElement?.clientHeight ?? 0;
  if (viewportWidth > 0 && viewportHeight > 0) {
    if (rect.width >= viewportWidth * 0.9 && rect.height >= viewportHeight * 0.9) {
      return true;
    }
    if (rect.bottom <= 0 || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= viewportWidth) {
      return true;
    }
  }
  return false;
}
/**
 * Frame + viewport + climb against an already-filled chain: the exported
 * probe fills first, the unified resolve reuses the offer's fill. Pure
 * reads - the fill it shares cannot flush, because nothing here writes.
 */
function placeGeneric(video, len) {
  const frame = videoFrame(video);
  if (!frame || viewportRefuses(frame.rect, frame.doc)) {
    return null;
  }
  return climbGenericContainer(len, frame.rect, frame.doc);
}

/**
 * The ancestor climb over chain indices (chain[0] is the video itself):
 * climb while the ancestor box tracks the video's own box, stopping at the
 * first ancestor that diverges (layout context, not player chrome) and
 * never at body/document. Hop counting mirrors the old parentNode walk
 * exactly, including counting the zero-size ancestors it skips through.
 * Reads rects, so it forces layout - the only probe allowed to: it runs
 * behind the layout-free gates, evaluated per offer rather than per frame,
 * where one flush is inaudible next to a seek.
 */
function climbGenericContainer(len, rect, doc) {
  let container = null;
  let hops = 0;
  for (let hop = 1; hop < len; hop++) {
    const node = chain[hop];
    if (node === doc?.body || node === doc?.documentElement) {
      break;
    }
    hops += 1;
    let box;
    try {
      box = node.getBoundingClientRect();
    } catch {
      break;
    }
    // A zero-size ancestor contributes no box (display:contents wrappers
    // report zeros while the video inside them renders): skip through it
    // rather than adopting a host nobody can see - or stopping a climb
    // that has a real player box above. Hops still count the step so the
    // removal watch's depth cap covers the true chain.
    if (!(box.width > 0) || !(box.height > 0)) {
      continue;
    }
    if (box.width > rect.width * 3 || box.height > rect.height * 3) {
      break;
    }
    container = node;
  }
  if (!container) {
    return null;
  }
  return { container, hops };
}

/**
 * Data attributes the registry anchors on, for the upgrade watch's
 * attributeFilter (which takes exact names, not selectors). Derived from
 * the records so a new data-anchored SDK is watched without a second list
 * to drift. Sorted, deduplicated.
 */
export function registryDataAttributes() {
  const names = new Set();
  for (const record of REGISTRY) {
    for (const anchor of record.anchors) {
      const match = /^\[([A-Za-z0-9-]+)/.exec(anchor);
      if (match && match[1].startsWith("data-")) {
        names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

/**
 * Learned fingerprints: domain-scoped dynamic records. When the generic slow
 * path adopts a video, the kernel records what the player block looked like;
 * on the next visit the print matches like a registry anchor, skipping the
 * behavioral gates' placement measurement (size, playback and activation
 * still gate every adoption - the print only answers identity and placement).
 *
 * A print names the container element the generic climb resolved: its tag,
 * its sorted class list (or null when it has none), its id (or null), and
 * its composed hop distance from the video. Matching is tag + depth +
 * id-equality plus class SUBSET (every recorded class present, extras
 * allowed): state classes come and go every session (`playing`, `open`,
 * `muted`), so exact-set matching would go stale within a visit, while a
 * subset still refuses a re-skin that drops the recorded markers. A stale
 * print costs one failed match and falls through to the slow path, which
 * re-learns - staleness degrades to today's behavior, never to a wrong shell.
 */
export function fingerprintFor(video, container, hops) {
  return {
    tag: container.localName ?? "",
    cls: [...(container.classList ?? [])].sort(),
    id: container.id || null,
    depth: hops
  };
}

/** Probe with its own walk; the matching lives in matchPrintsOnChain. */
export function matchPrints(video, print) {
  return matchPrintsOnChain(fillComposedChain(video), print);
}

/**
 * The print probe against an already-filled chain: chain[0] is the video,
 * so the node at the print's recorded depth is chain[depth] - the same node
 * the climbing walk lands on, without re-walking (same traversal, same hop
 * counting, so shadow-hosted videos resolve the way registry matches do).
 * A malformed print answers null without touching layout - validation reads
 * tag and classes only, never a box.
 */
function matchPrintsOnChain(len, print) {
  if (!print || typeof print.tag !== "string" || !Array.isArray(print.cls) ||
      !Number.isInteger(print.depth) || print.depth < 1 || print.depth >= len) {
    return null;
  }
  const node = chain[print.depth];
  if (node.localName !== print.tag) {
    return null;
  }
  if (print.id != null && node.id !== print.id) {
    return null;
  }
  // Indexed subset walk, not cls.every: the probe runs per print per offer,
  // and the closure form allocates on every one of them.
  const needed = print.cls;
  for (let i = 0; i < needed.length; i++) {
    if (!node.classList?.contains(needed[i])) {
      return null;
    }
  }
  return { el: node, hops: print.depth };
}

/**
 * Resolve the element that hosts the shell DOM: the matched record's `host`
 * override, else the matched element itself. A record earns an override only
 * with fixture proof that its chrome lives outside the anchor - an override
 * without proof is a placement guess wearing a record's clothes. Exported
 * solely so the host-resolution branch (unexercised by the current registry)
 * can be driven by a synthetic match in the sdk-engine test.
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

/**
 * The host-override probe against an already-filled chain. `match` came off
 * this same fill, so its anchor sits at chain[hops] and the override scans
 * upward from there - the same elements the exported walk scans from `el`,
 * without refilling.
 */
function resolveContainerOnChain(len, match) {
  if (!match.record.host) {
    return match.el;
  }
  for (let hop = match.hops; hop < len; hop++) {
    if (chain[hop].matches(match.record.host)) {
      return chain[hop];
    }
  }
  return match.el;
}

/** The one descriptor constructor: every path emits the same shape, so the
 *  kernel cannot tell which probe produced it - except by `source`, which the
 *  learner and the tests read. */
function describe({ name, host, container, anchor, hops, source }) {
  return { name, host, container, anchor, hops, source };
}

/** Gates + placement against an already-filled chain (see genericGates for
 *  why the gates stay layout-free and first). */
function measureGenericOnChain(video, len) {
  if (!genericGates(video)) {
    return null;
  }
  const placed = placeGeneric(video, len);
  if (!placed) {
    return null;
  }
  return describe({
    name: "Custom player",
    host: null,
    container: placed.container,
    anchor: placed.container,
    hops: placed.hops,
    source: "generic"
  });
}

/**
 * The unified resolve: one composed walk per offer, three probes in priority
 * order - registry anchor, learned print, measured fallback. The fill is
 * shared because every probe reads the same ancestry; only the generic climb
 * reads boxes, and only after its layout-free gates pass, so an offer for a
 * paused ad costs the walk and nothing else.
 *
 * Only the positive registry descriptor is memoized (same entry, same
 * freshness check findSdkForVideo always had): the null stays unmemoized,
 * because no cheap fingerprint distinguishes "same answer" from "the video's
 * subtree was grafted under a new SDK" - parent, depth and top can all
 * survive such a graft unchanged, and the one exact check (re-running the
 * scan) is the scan itself. A cached null would keep a grafted player
 * permanently unregistered with no path re-offering it (the mutation tap
 * offers the moved video, the memo calls it fresh, adoption never runs).
 * The WeakMap key dies with the video, so positive entries are session-only.
 */
export function resolvePlayer(video, { prints = NO_PRINTS, enabled = false } = {}) {
  const cached = descriptorCache.get(video);
  if (cached && isMatchFresh(video, cached)) {
    return cached.descriptor;
  }
  const len = fillComposedChain(video);
  const match = matchSdkOnChain(len);
  if (match) {
    const entry = { best: match, parent: video.parentNode ?? null, descriptor: null };
    entry.descriptor = describe({
      name: match.record.name,
      host: match.record.host ?? null,
      container: resolveContainerOnChain(len, match),
      anchor: match.el,
      hops: match.hops,
      source: "registry"
    });
    descriptorCache.set(video, entry);
    return entry.descriptor;
  }
  if (!enabled) {
    return null;
  }
  for (const print of prints) {
    const hit = matchPrintsOnChain(len, print);
    if (hit) {
      return describe({
        name: "Custom player",
        host: null,
        container: hit.el,
        anchor: hit.el,
        hops: hit.hops,
        source: "learned"
      });
    }
  }
  return measureGenericOnChain(video, len);
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
  // Initialized, not assigned-in-try-only: the try body below is one atomic
  // assignment, so a throw leaves this at false - the honest answer for a
  // null or hostile object, with nothing to restore in the catch.
  let shadow = false;
  try {
    shadow = video.getRootNode?.().nodeType === 11;
  } catch {
    // Fallthrough value stands - see above.
  }
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
 * kernel boot replay both run document.querySelectorAll("video")), nor when
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
