import { AdoptionHome, BARE_SDK_NAME, BARE_VIDEOS_KEY } from "./contract.js";
import { getConfigValue } from "../shared/store.js";

/**
 * SDK identity engine. Registry-driven, importing its contract plus the one
 * configs read the bare-video tier gates on.
 *
 * Detection is registry-driven: every supported player SDK declares exactly one
 * record below, and a video is adopted only when its composed ancestry contains
 * one of that SDK's anchors. There is deliberately NO generic fallback - an
 * anchor must be owned by its SDK (prefixed class, dedicated data attribute, or
 * custom element tag), so pages merely styling a <div class="player"> stay
 * unrecognized rather than misidentified. Coverage grows by adding records.
 *
 * The ONE deliberate exception is the opt-in bare-video tier below: a <video>
 * whose page constructed the media programmatically (blob: src - the MSE
 * shape) and that has actually started playing can be adopted through its
 * page container when the user enables `discovery.bareVideos`. The evidence
 * bar replaces the identity ask at least as strongly (a decoder texture and
 * a preload-never-plays embed both fail it), and the tier is off by default,
 * so the no-generic-fallback law still governs every default install.
 *
 * Record schema:
 *   name    - label used for logging and shell metadata.
 *   anchors - selectors resolved by the native closest() walk over the
 *             video's ancestry (primary arm), with the composed-ancestry
 *             walk kept as the shadow-boundary arm for matches closest()
 *             cannot reach. Each must be SDK-namespaced; ordered most
 *             specific first.
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
 * registry order. The primary arm hands the fewest-hops law to the engine:
 * closest(ANCHOR_PROBE) returns the nearest matching ancestor-or-self in one
 * C++ call, covering light DOM and shadow-internal trees; the composed walk
 * (parentNode/.host) stays for exactly the shapes closest() cannot answer -
 * an anchor above the video's shadow host, and detached videos.
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
  // Shaka Player stamps BOTH arms from vendor source (shaka-project main):
  // the Overlay constructor sets videoContainer.dataset.shakaPlayerContainer
  // on EVERY programmatic use (ui/ui.js), and the auto-setup div carries
  // .shaka-video-container (ui/less/containers.less - "the auto-setup div
  // which we populate"; the demo markup mounts both on one element). The
  // attribute leads as the API surface every integration route sets.
  { name: "Shaka Player", anchors: ["[data-shaka-player-container]", ".shaka-video-container"] },
  // OvenPlayer renders its player root INTO the caller's container
  // (OvenPlayer.create(container, options); dist v5.3.4-era bundle
  // ViewTemplate: '<div class="ovenplayer op-wrapper" tabindex="-1">' —
  // .ovenplayer is unambiguous vendor vocabulary, and OpenPlayerJS ships no
  // such class). The player root inside it is '<div class="op-player
  // op-clear">' — which ALSO matches OpenPlayerJS's .op-player anchor, so
  // identity at that element is decided by registry order: this record MUST
  // precede OpenPlayerJS. The second arm is the rescue: .op-clear is stamped
  // by OvenPlayer on the root and on every internal element, and
  // OpenPlayerJS's wrapper is className="op-player
  // op-player__keyboard--inactive" (2.14.12 dist) — op-clear never appears
  // in its dist, so the compound cannot misattribute an OpenPlayerJS page.
  { name: "OvenPlayer", anchors: [".ovenplayer", ".op-player.op-clear"] },
  // OpenPlayerJS wraps the media from vendor source (openplayerjs master,
  // packages/player/src/ui.ts createUI): the injected wrapper carries
  // .op-player on both the audio and the video path, and the media's own
  // .op-player__media class stays off the list - a 0-hop match would
  // resolve the video element as the shell home (the Radiant law).
  { name: "OpenPlayerJS", anchors: [".op-player"] },
  // Bitmovin's UI container is appended into player.getContainer() BESIDE
  // the video (bitmovin-player-ui develop UIManager.ts:
  // uiWrapperElement.append(dom) over uiContainerElement = new
  // DOM(player.getContainer())); the sibling relationship is the vendor's
  // own comment - display:none on the outermost UI container must not
  // "block any events (e.g. click events) on the video", so the video is
  // outside it (the class ships 95x in the built bitmovinplayer-ui.css;
  // the bmpui prefix is the documented _variables.scss default).
  { name: "Bitmovin Player", anchors: [".bmpui-ui-uicontainer"] },
  // Kaltura PlayKit: the core builds the container itself
  // (kaltura/playkit-js, _createPlayerContainer stamps .playkit-container)
  // and the README mount contract appends player.getView() - that same
  // div - into the page's target. The video is prepended into it carrying
  // .playkit-engine, which stays off the list: the class sits ON the video
  // element (0-hop law).
  { name: "Kaltura PlayKit", anchors: [".playkit-container"] },
  // NPlayer (oyuyue/nplayer, packages/nplayer/src/ts/player.ts): the
  // player el is $('.nplayer', ...) and the video is appended directly
  // into it (this.el.appendChild(this.video); CLASS_PLAYER = 'nplayer').
  // The video's own .video class is not vendor-namespaced and stays off
  // the list - the anchor resolves the container at hop 1.
  { name: "NPlayer", anchors: [".nplayer"] },
  // AblePlayer wraps the media in a three-layer chain at init
  // (ableplayer/ableplayer v5.0.0, injectPlayerCode — the vendor's own
  // inline comment names the layers): the video is wrapped in
  // .able-media-container (the player box that also carries captions and
  // controls), then .able, then .able-wrapper. The innermost layer leads
  // as the fewest-hops, tightest shell home; .able-wrapper stays as the
  // outer fallback arm. .able itself is deliberately NOT an anchor - a
  // single unprefixed English word is not SDK-namespaced vocabulary (a
  // page styling a div class="able" would misattribute).
  { name: "AblePlayer", anchors: [".able-media-container", ".able-wrapper"] },
  // Jellyfin web builds the dialog itself (jellyfin-web master,
  // src/plugins/htmlVideoPlayer/plugin.js createMediaElement): a
  // <div class="videoPlayerContainer"> inserted as document.body.firstChild
  // with the <video class="htmlvideoplayer"> as its direct child, styled
  // fixed full-viewport flex by the plugin's own style.scss. The video's
  // .htmlvideoplayer class stays off the list (0-hop law). The vocabulary
  // predates the fork: jellyfin-web descends from Emby's web client and the
  // class is verifiable on Emby's own theming surface (Emby community
  // custom-CSS threads style ".videoPlayerContainer > div", Emby themes
  // reference it), so one record covers both servers - the servers differ
  // in the app shell, not the player dialog this record adopts. Registry
  // batch 4 (Nov 2026): the ring's other candidates verified declines -
  // PeerTube/MediaCMS/Owncast are Video.js-based (client deps + player
  // components read from vendor source), Audiobookshelf has no video
  // player surface at all (client/players is audio-only), Plex/Wistia are
  // closed-source embeds with no verifiable in-document vocabulary.
  { name: "Jellyfin", anchors: [".videoPlayerContainer"] },
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
 * "does ANY anchor arm match" in one call; `closest(list)` rides the same
 * engine for the whole walk. Derivation is
 * from the registry table itself, so adding a record re-arms the probe with
 * no second spelling. Constraint the join carries: an anchor must not carry
 * a top-level comma (a separator spelled into an anchor would silently
 * become two arms under the record's name; a comma inside a quoted
 * attribute value is one selector to the engine and fine); every current
 * anchor is a class/attribute/tag/simple-combinator shape with no comma.
 */
const ANCHOR_PROBE = REGISTRY.flatMap((record) => record.anchors).join(", ");

/**
 * The per-record probes: each record's anchors joined into ONE selector
 * list, so identity resolution at a matched element is one native matches()
 * call per record (registry order IS the tie law the loop walks) instead
 * of one call per anchor. The join is also where the no-top-level-comma
 * constraint lives: a comma anchor is still ONE selector to the CSS engine
 * only when its comma sits inside a quoted attribute value, so an anchor
 * spelled with a real separator would silently become two arms under the
 * record's name - table hygiene, and the drift guard below answers the
 * real failure mode if a probe ever stops agreeing with the table.
 */
const RECORD_PROBES = REGISTRY.map((record) => record.anchors.join(", "));

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
   * The composed-ancestry walk, shared by the shadow-boundary match arm and
   * container resolution. Fills the reusable `#chain` with the element nodes
   * from `start`
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
    // Primary arm: closest() IS the native fewest-hops walk - the nearest
    // matching ancestor-or-self in ONE C++ call, no JS chain build. It owns
    // every in-tree topology: light DOM (the overwhelming majority) AND
    // shadow-internal matches (closest searches the video's own tree up to
    // its root). The answer is the fewest-hops answer by construction - any
    // boundary-crossing match is strictly more hops than an in-tree one -
    // so a hit needs no further scan. The hop count re-derives by the native
    // parent walk (el is an in-tree ancestor-or-self, so the walk cannot
    // overrun), and identity at the matched element comes from the ordered
    // per-record tie loop (registry order): one matches() call per record,
    // the joined probes answering "any of this record's anchors match" in
    // the C++ engine.
    const el = video.closest(ANCHOR_PROBE);
    if (el) {
      let hops = 0;
      for (let node = video; node !== el; node = node.parentElement) {
        hops += 1;
      }
      for (let r = 0; r < RECORD_PROBES.length; r++) {
        if (el.matches(RECORD_PROBES[r])) {
          return { record: REGISTRY[r], el, hops };
        }
      }
      // A tick no record probe confirms means the derived tables have
      // drifted apart (structurally impossible - all read the same table):
      // answer the no-shape null rather than trust an unidentified element.
      return null;
    }
    // Composed arm: the shadow-boundary + detached shapes closest() cannot
    // answer - closest() stops at the ShadowRoot (and answers null on a
    // disconnected node), so a video whose owning anchor sits ABOVE its
    // shadow host, or a detached video carrying an anchor itself, is only
    // reachable by walking parentNode/.host. Same law, hand-walked: the hop-
    // ascending scan IS the fewest-hops law (the first probe hit is the
    // winning depth), and identity at that hop rides the same per-record
    // tie loop as the primary arm.
    const chain = this.#chain;
    const len = this.#fillComposedChain(video);
    for (let hop = 0; hop < len; hop++) {
      const node = chain[hop];
      if (!node.matches(ANCHOR_PROBE)) continue;
      for (let r = 0; r < RECORD_PROBES.length; r++) {
        if (node.matches(RECORD_PROBES[r])) {
          return { record: REGISTRY[r], el: node, hops: hop };
        }
      }
      // A tick the per-record tie loop cannot confirm means the registry and
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
    if (match) {
      const descriptor = {
        name: match.record.name,
        container: this.#resolveContainer(match),
        hops: match.hops
      };
      this.#descriptorCache.set(video, { descriptor, parent: video.parentNode });
      return descriptor;
    }
    // No SDK anchor anywhere in the composed ancestry. Two no-anchor
    // postures, decided by the bare tier's gate:
    if (!getConfigValue(BARE_VIDEOS_KEY, false)) {
      // Tier off: the negative cache stands - a page of many non-SDK videos
      // (ad grids, untracked embeds) never re-runs the full ancestry scan
      // per discovery pass.
      this.#descriptorCache.set(video, { descriptor: null, parent: video.parentNode });
      return null;
    }
    // Tier on: no anchor is not yet a no. The evidence bar is time-varying
    // (the src can be assigned late by an MSE pipeline, played accumulates
    // with playback), so a null must NEVER cache - every re-ask re-reads
    // the two facts. A qualified candidate adopts through its page
    // container (the parent element, taken as-is: the video is never
    // moved, the shell mounts beside it like in any SDK home), and the
    // positive descriptor caches parent-stamped like any other - once
    // blob+played qualify they stay qualified, and a re-parent invalidates.
    const parent = video.parentElement;
    if (parent !== null && this.#qualifiesBare(video)) {
      const descriptor = { name: BARE_SDK_NAME, container: parent, hops: 1 };
      this.#descriptorCache.set(video, { descriptor, parent: video.parentNode });
      return descriptor;
    }
    return null;
  }

  /**
   * The bare tier's evidence bar, all native reads, all required:
   *   - `blob:` scheme on currentSrc - the page constructed the media
   *     programmatically (MSE hands out exactly these URLs). A plain,
   *     data, or empty src never qualifies; that is the deliberate-player
   *     discriminator. mediastream: is deliberately excluded - the
   *     conferencing/capture class is a different topology, not a player.
   *   - `played.length > 0` - the video has actually started playing. The
   *     junk killer: decoder/canvas textures and preload-never-plays
   *     embeds never reach it.
   * Presence (the 100x60 painted box, on-screen at finish) is discovery's
   * unchanged job - this ask only replaces the registry's identity leg.
   */
  #qualifiesBare(video) {
    const url = URL.parse(video.currentSrc);
    return url !== null && url.protocol === "blob:" && video.played.length > 0;
  }

  /** The tier-flip invalidation: see clearDescriptorCache. */
  clear() {
    this.#descriptorCache = new WeakMap();
  }
}

const matcher = new SdkMatcher();

/**
 * The adoption screen: resolve the SDK identity once and wrap it in the
 * AdoptionHome record the watcher protocol carries. Null (no registered SDK
 * anchor, or an unqualified bare candidate) stays the engine's no-shape
 * answer, unmodified. Called only at adoption and at the re-wrap seam - the
 * descriptor cache makes both free when the composed ancestry is unchanged.
 * Module's sole export face: the findSdkForVideo export retired with its
 * injectable-registry arm (no external consumer since the kernel's adoption
 * and re-wrap seams moved to the record).
 */
export function resolveAdoptionHome(video) {
  const sdk = matcher.find(video);
  if (!sdk) {
    return null;
  }
  return new AdoptionHome({ video, sdk });
}

/**
 * The descriptor-level identity ask: the cached matcher answer, no record
 * wrap. The boot probe's face - its #consider runs per surfacing event (the
 * media tap and the escalated mutation feed) for every video on the page, so
 * the repeat path must stay allocation-free, which is the descriptor cache's
 * own contract; the AdoptionHome record is built exactly once, at the probe's
 * finish where the adoption decision lands. The kernel keeps
 * resolveAdoptionHome: its ask rate is the adoption attempt (one per
 * candidate lifetime against the seen-pin), not the discovery event.
 */
export function findSdk(video) {
  return matcher.find(video);
}

/**
 * Drop every cached descriptor, positive and negative alike. The bare-tier
 * flip is exactly the invalidation condition the parent stamp cannot express:
 * a null cached while the tier was off (or a bare positive cached while it
 * was on) would otherwise answer forever, because the tier gate reads live
 * config, not DOM state. The flip applier calls this before re-running
 * discovery, so the next ask re-scans under the new posture.
 */
export function clearDescriptorCache() {
  matcher.clear();
}
