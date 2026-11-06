import { AdoptionHome } from "./contract.js";

/**
 * SDK identity engine. Registry-driven, importing only its contract.
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
 *
 * Caching is single-tier: the descriptor cache (see resolveAdoptionHome) is the
 * one repeat-query memo - its stamp (video.parentNode) is the exact
 * invalidation condition the scan itself would use, so no inner match-level
 * cache can ever answer a query the descriptor cache missed.
 *
 * Presence thresholds and the WHEN-is-it-ready machinery (size/on-screen
 * gates, media taps, the boot probe) live in discovery.js; this module only
 * answers WHICH SDK owns a video, importing only its contract.
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
  { name: "Fluid Player", anchors: [".fluid_video_wrapper"] },
  { name: "Flowplayer", anchors: [".fp-player", "flowplayer-ui", "[data-player-id]", ".flowplayer"] },
  // Clappr emits two SDK-owned markers (verified in clappr/clappr main,
  // packages/clappr-core): the Container element renders
  // { class: "container", "data-container": "" } and the Core element renders
  // { "data-player": "" }. The compound leads: both attributes are vendor-set
  // on one element that sits closest to the video (the container directly
  // wraps the playback el, while the core wraps containers), so the shell
  // home resolves to the tight box; the bare [data-player] stays as the
  // fallback arm for layouts the compound misses.
  { name: "Clappr", anchors: [".container[data-container]", "[data-player]"] },
  { name: "Vidstack", anchors: ["media-player"] },
  { name: "Mux Player", anchors: ["mux-player"] },
  // Radiant ships TWO install routes (docs 10.7.9 quick-start): the primary
  // script build appends the player into a site-chosen div via
  // `new RadiantMP(elementID)` - the appended wrapper carries the
  // SDK-namespaced class .rmp-container (verified in the served
  // wc.rmp.min.css class set, rmp 10.7.9), so the standard install matches;
  // the secondary custom-element build renders <radiant-media-player> and
  // needs its vendor tag. .rmp-video exists on the media element itself and
  // is deliberately NOT an anchor: a 0-hop match would resolve the video
  // element as the shell home, a box the shell cannot host its DOM in.
  { name: "Radiant Media Player", anchors: [".rmp-container", "radiant-media-player"] },
  { name: "Laravel Video Embed", anchors: ["[data-page] > div:first-child", "#app[data-page]"] },
];

/** The registry as a check-tool surface: the registry-coverage case derives
 *  its per-record stub rows from these records, so a new record added without
 *  an anchor-satisfying stub shape turns the gate red. Frozen - the matcher
 *  holds the same array by reference, and the per-hop probe below is derived
 *  from this same table. */
export const SDK_REGISTRY = REGISTRY;

/**
 * The per-hop probe: every registry anchor joined into one selector list,
 * evaluated natively. `el.matches(list)` is the C++ selector engine answering
 * "does ANY anchor arm match" in one call - per-anchor JS looping between
 * matches() calls is what that call replaces (the `:is(list)` spelling is
 * equivalent; the bare joined list skips the wrapper tokens). Derivation is
 * from the registry table itself, so adding a record re-arms the probe with
 * no second spelling. Constraint the join carries: an anchor must not carry a
 * top-level comma (an attribute value like [data-x="a,b"] would split into two
 * arms - the same hazard the `:is()` form would carry); every current anchor
 * is a class/attribute/tag/simple-combinator shape with no comma.
 */
const ANCHOR_PROBE = REGISTRY.flatMap((record) => record.anchors).join(", ");

/**
 * The whole identity engine as one class: the composed-ancestry scratch, the
 * matcher, and the single-tier descriptor cache are all private fields on the
 * one instance. The module singleton wires the exported call surface below.
 */
class SdkMatcher {
  /**
   * Reusable composed-ancestry scratch: the match loop is fully synchronous and
   * never lets the array escape (callers keep only `el`/`record`/`hops`, never
   * the chain itself), so one array serves every full-scan instead of allocating
   * a fresh one per video. `len` is the filled length each pass.
   */
  #chain = [];

  /**
   * Fully-resolved descriptor per video. Cached alongside the raw match so the
   * hot re-query path (probe/kernel re-asking about surviving videos) returns
   * the SAME object instead of re-wrapping + re-allocating every call.
   * "Fewer APIs, same facts": the scan already computes `el` and `hops`, so they
   * are surfaced at zero extra cost rather than recomputed downstream.
   *
   * Parent-stamped: a descriptor names a specific container, so
   * it is only valid for the ancestry it resolved against. A re-parent (SDK
   * wrap, a host re-nest reusing the video node) invalidates it; the next query
   * re-scans and the container/anchor follow the new tree instead of pointing at
   * a detached node.
   */
  #descriptorCache = new WeakMap();

  /**
   * The single composed-ancestry walk, shared by anchor matching and container
   * resolution. Fills the reusable `#chain` with the element nodes from `start`
   * upwards (crossing shadow boundaries via `.host`), and returns the filled
   * length. Flat indexed loop, no closure per call - the JIT's most reliably
   * optimized shape for this one-pass discovery walk. Chain index doubles as the
   * hop count. Callers must keep only what they read from `#chain[0..len)`; the
   * scratch buffer never escapes.
   */
  #fillComposedChain(start) {
    const chain = this.#chain;
    let len = 0;
    for (let node = start; node; ) {
      if (node.nodeType === 1) {
        chain[len++] = node;
      }
      node = node.parentNode ?? node.host ?? null;
    }
    // Truncate to the filled length: the buffer is instance-level and reused,
    // so without this a prior deep walk leaves the tail pointing at nodes that
    // may since have been detached - a strong reference held until the next
    // scan.
    chain.length = len;
    return len;
  }

  #matchSdk(video) {
    // Single composed walk + one native probe call per hop (the `:is()`-grade
    // selector-list evaluation the C++ engine owns): each ancestor answers
    // "any registry anchor match?" in ONE matches() call, so the miss path is
    // hops x 1 native call instead of anchors x hops JS-looped calls. The
    // hop-ascending scan IS the fewest-hops law - the first probe hit is the
    // winning depth, no later hop can beat it, so record/anchor identity at
    // that hop comes from one ordered tie loop (registry order, then anchor
    // order) instead of the per-anchor walk's best-tracking with strict <.
    const chain = this.#chain;
    const len = this.#fillComposedChain(video);
    for (let hop = 0; hop < len; hop++) {
      const node = chain[hop];
      if (!node.matches(ANCHOR_PROBE)) continue;
      for (let r = 0; r < REGISTRY.length; r++) {
        const record = REGISTRY[r];
        const anchors = record.anchors;
        for (let a = 0; a < anchors.length; a++) {
          if (node.matches(anchors[a])) {
            return { record, el: node, hops: hop };
          }
        }
      }
      // A tick the per-anchor tie loop cannot confirm means the registry and
      // the derived probe have drifted apart (structurally impossible - both
      // read the same table): answer the no-shape null rather than keep
      // scanning, where a deeper hop would win under the fewest-hops law.
      return null;
    }
    return null;
  }

  /**
   * Resolve the element that hosts the shell DOM: the matched record's `host`
   * override, else the matched element itself. Private to the engine; the
   * host branch is a record-schema surface (a future SDK record may declare
   * `host`), unexercised while every current record resolves its container
   * to the matched anchor.
   */
  #resolveContainer({ record, el }) {
    if (!record.host) {
      return el;
    }
    // Composed-ancestry walk mirroring anchor matching: the host override may
    // target an element above the matched anchor and across shadow boundaries.
    const chain = this.#chain;
    const len = this.#fillComposedChain(el);
    for (let hop = 0; hop < len; hop++) {
      if (chain[hop].matches(record.host)) {
        return chain[hop];
      }
    }
    return el;
  }

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
   * The emitted descriptor carries exactly what the adoption protocol reads:
   * name (log/error prose), container (the shell-host home), hops (the
   * removal watch's depth input). The host/anchor emissions retired with the
   * findSdkForVideo export face - no consumer outside this module ever read
   * them, and the host branch stays reachable through the record schema (see
   * #resolveContainer). The injectable-registry arm retired with it: the
   * registry is a module constant, and the registry-stamp half of the cache
   * key existed only to fence injected registries apart.
   */
  find(video) {
    const cached = this.#descriptorCache.get(video);
    if (cached !== undefined && cached.parent === video.parentNode) {
      return cached.descriptor;
    }
    const match = this.#matchSdk(video);
    if (!match) {
      this.#descriptorCache.set(video, { descriptor: null, parent: video.parentNode });
      return null;
    }
    const descriptor = {
      name: match.record.name,
      container: this.#resolveContainer(match),
      hops: match.hops
    };
    this.#descriptorCache.set(video, { descriptor, parent: video.parentNode });
    return descriptor;
  }
}

const matcher = new SdkMatcher();

/**
 * The adoption screen: resolve the SDK identity once and wrap it in the
 * AdoptionHome record the watcher protocol carries. Null (no registered SDK
 * anchor) stays the engine's no-shape answer, unmodified. Called only at
 * adoption and at the re-wrap seam - the descriptor cache makes both free
 * when the composed ancestry is unchanged. Module's sole export face: the
 * findSdkForVideo export retired with its injectable-registry arm (no
 * external consumer since the kernel's adoption and re-wrap seams moved to
 * the record).
 */
export function resolveAdoptionHome(video) {
  const sdk = matcher.find(video);
  if (!sdk) {
    return null;
  }
  return new AdoptionHome({ video, sdk });
}
