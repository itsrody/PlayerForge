/**
 * SDK identity engine.
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
 * Caching is single-tier: the descriptor cache (see findSdkForVideo) is the
 * one repeat-query memo - its stamp (video.parentNode + registry) is the
 * exact invalidation condition the scan itself would use, so no inner
 * match-level cache can ever answer a query the descriptor cache missed.
 *
 * Presence thresholds and the WHEN-is-it-ready machinery (size/on-screen
 * gates, media taps, the boot probe) live in discovery.js; this module only
 * answers WHICH SDK owns a video, and it imports nothing.
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
  { name: "Clappr", anchors: ["[data-player]"] },
  { name: "Vidstack", anchors: ["media-player"] },
  { name: "Mux Player", anchors: ["mux-player"] },
  { name: "Radiant Media Player", anchors: ["radiant-media-player"] },
  { name: "Laravel Video Embed", anchors: ["[data-page] > div:first-child", "#app[data-page]"] },
];

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

  #matchSdk(video, registry) {
    // Single composed walk (uBO's one-pass-over-tokens shape): the rich-path
    // ancestors re-walked once per anchor, then walked again per hit to count
    // hops. Chain index IS the hop count, so one pass serves every anchor.
    // Selection semantics: fewest hops wins, ties keep registry order then
    // anchor order (strict < keeps the first).
    const chain = this.#chain;
    const len = this.#fillComposedChain(video);
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
    return best;
  }

  /**
   * Resolve the element that hosts the shell DOM: the matched record's `host`
   * override, else the matched element itself. Private to the engine; the
   * host branch (unexercised by the current registry) is driven in tests by
   * passing a synthetic registry to findSdkForVideo.
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
   * `registry` defaults to the production REGISTRY and is injectable so records
   * it does not exercise (currently `host`) stay testable without exporting
   * resolveContainer. The cache stamp carries the registry reference, so a
   * custom registry can never serve a production hit.
   */
  find(video, registry = REGISTRY) {
    const cached = this.#descriptorCache.get(video);
    if (cached !== undefined && cached.parent === video.parentNode && cached.registry === registry) {
      return cached.descriptor;
    }
    const match = this.#matchSdk(video, registry);
    if (!match) {
      this.#descriptorCache.set(video, { descriptor: null, parent: video.parentNode, registry });
      return null;
    }
    const descriptor = {
      name: match.record.name,
      host: match.record.host ?? null,
      container: this.#resolveContainer(match),
      anchor: match.el,
      hops: match.hops
    };
    this.#descriptorCache.set(video, { descriptor, parent: video.parentNode, registry });
    return descriptor;
  }
}

const matcher = new SdkMatcher();

export function findSdkForVideo(video, registry) {
  return matcher.find(video, registry);
}
