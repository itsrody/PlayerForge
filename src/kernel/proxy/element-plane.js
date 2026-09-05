/**
 * element-plane.js — the element-level media surface (consolidated from
 * `element-route.js` + `take-over.js` + `frame-watch.js`).
 *
 * StreamTape-style players assign a media URL straight to `video.src`; the
 * browser's media stack performs those GETs in the network process, so no page
 * fetch/XHR is involved and the request-boundary seams never see them. This
 * module is the one controlled element-level surface: `routeProgressiveSource`
 * routes the element's src through the same Mp4Router the wire seams use and
 * hands the element an object URL over the proxied bytes (whole-file buffered,
 * size-ceilinged, dead-bytes watchdog via the unified §7.8 frame feed), and
 * `routeManifestStreams`/`attachTakeover` build the full MSE plane — MediaSink,
 * one SegmentManager per lane over the fragment plan, AES-128/ClearKey decrypt
 * — off a §7.4 claim from the bootstrap ring.
 *
 * Policy is cooperative and degrades to native: any refusal - off-switch, gate
 * decline, network error, non-2xx, redirect cap, blob:/data:/empty src - leaves
 * the element's src untouched and the native wire in charge. Never patch a
 * prototype: a routed element is tracked in a WeakMap so its object URL and
 * takeover are revoked on re-route, on dispose, and - via a FinalizationRegistry
 * held on the element - even when the page throws the element away without
 * disposing it. A page player that commits bytes or a MediaSource in the gap
 * wins over the claim (ablation re-check), and a `sourceclose` surrenders the
 * plane without touching the element's now-foreign src.
 *
 * `onFrame` is the unified requestVideoFrameCallback feed (§7.8): resume's
 * pause flush and this module's dead-bytes watchdog both consume the same
 * "a frame was actually composited" signal. Deterministic: object-URL
 * creation/revocation, MediaSource, provider bytes, decrypt, EME, the video
 * element, and the frame-watchdog deadline are all injectable seams, so the
 * whole plane runs headless.
 */
import { logger } from "../../shared/logger.js";
import { isMp4StreamUrl } from "./stream-transport.js";
import { SegmentError, SegmentManager, parseManifest } from "./segment-flow.js";
import { MSEFactory, Aes128Decrypter, ClearKeyEme } from "./decrypt-eme.js";

const FALLBACK_BASE = "https://nowhere.invalid/";

/** True for an http(s)-schemed src. Hoisted - a regex literal in `streamable`
 *  would re-allocate per whole-file route attempt. */
const STREAM_SCHEME_RE = /^https?:/i;

/** Ceiling for a whole-file element route. Bigger than this and the download
 *  would hog GBs in a single GM arraybuffer (a 4K movie silently balloons past
 *  every browser's comfort zone); the seam instead aborts the proxied GET and
 *  keeps the native media-stack wire - which streams + seeks by design. */
const ELEMENT_ROUTE_MAX_BYTES = 1024 * 1024 * 1024;

/** Deadline for a routed blob to present its first frame. The whole file is
 *  buffered before the swap, so a composed frame should arrive almost
 *  immediately; a blob that never presents one in this window is dead bytes
 *  even when no error fires. */
const FRAME_WATCHDOG_MS = 10_000;

/** Per-element routed object URLs, revoked on re-route or dispose. */
const routedUrls = new WeakMap();
/** Per-element in-flight guards so two routes never race. */
const pendingRoutes = new WeakSet();
/** Per-element cleanup registries, unregistered when their route is released. */
const routeCleanupRegistries = new WeakMap();
/** Active §Phase 6 MSE takeovers, detached on re-route, dispose, or disengage. */
const activeTakeovers = new WeakMap();
/** Per-element in-flight takeover guard (attach is async). */
const pendingTakeovers = new WeakSet();

function defaultMakeObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectUrl(objectUrl) {
  URL.revokeObjectURL(objectUrl);
}

/** FinalizationRegistry factory: revokes a routed element's object URL if the
 *  element is garbage-collected without a dispose or revert ever releasing it.
 *  The held value carries the route's own revoke seam, so an injected
 *  test double still exercises the release path. */
function defaultMakeCleanupRegistry(cleanup) {
  return new FinalizationRegistry(cleanup);
}

/** MediaError.code for "the resource (object URL) could not be loaded". */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** Release a routed element's object URL: drop the route maps, unregister the
 *  element from its cleanup registry, revoke the URL. Idempotent - releasing
 *  an already-reverted route is a no-op. */
function revokeRouted(video, revokeObjectUrl) {
  const objectUrl = routedUrls.get(video);
  if (!objectUrl) {
    return false;
  }
  routedUrls.delete(video);
  const cleanupRegistry = routeCleanupRegistries.get(video);
  if (cleanupRegistry) {
    routeCleanupRegistries.delete(video);
    cleanupRegistry.unregister(video);
  }
  revokeObjectUrl(objectUrl);
  return true;
}

/**
 * Hand the element back its original native src. The revert requires our
 * object URL to still be the active source, so the page's own src changes are
 * never clobbered. Idempotent and shared by the error fallback and the frame
 * watchdog: degrades toward native, never frozen playback.
 */
function revertToNative(video, nativeUrl, revokeObjectUrl) {
  const objectUrl = routedUrls.get(video);
  if (!objectUrl) {
    return;
  }
  if (video.currentSrc !== objectUrl && video.src !== objectUrl) {
    return;
  }
  revokeRouted(video, revokeObjectUrl);
  video.src = nativeUrl;
}

/** Release the object URL the seam handed `video` (idempotent). */
export function disposeElementSource(video, { revokeObjectUrl = defaultRevokeObjectUrl } = {}) {
  if (revokeRouted(video, revokeObjectUrl)) {
    pendingRoutes.delete(video);
  }
}

/**
 * If the routed object-URL playback fails the moment it should start (the
 * source it wraps is not supported), hand the element back its original
 * native src instead of leaving the wire frozen. Armed once per routed
 * element; unarmed elements (mock videos without an event surface) route
 * without it, and a later unrelated error cannot clobber the page's own
 * src changes because the revert requires our object URL to still be the
 * active source.
 */
function armNativeFallback(video, nativeUrl, revokeObjectUrl) {
  if (typeof video.addEventListener !== "function") {
    return;
  }
  video.addEventListener("error", () => {
    if (video?.error?.code !== MEDIA_ERR_SRC_NOT_SUPPORTED) {
      return;
    }
    revertToNative(video, nativeUrl, revokeObjectUrl);
  }, { once: true });
}

/**
 * First-frame watchdog: the routed blob's whole file is buffered before the
 * swap, so a composited frame should arrive almost immediately. A blob that
 * never presents one inside `watchdogMs` is dead bytes even when no error
 * fires (a 200-body that is not demuxable media, truncation that hangs
 * metadata); revert to the native src, which streams the same resource, so
 * the element is never left frozen. `onFrame` (§7.8) subscribes to the
 * unified requestVideoFrameCallback feed - it disarms on the first composited
 * frame (a paused element still presents its initial frame, so an unplayed
 * routed video disarms on load), and also on error/emptied/ended which are
 * already handled by the error fallback. A method-less mock (test host) means
 * "can't prove the blob is dead" - the deadline still arms, but the frame
 * signal is a request-worth it cannot give, so the watchdog stays armed and
 * reverts on expiry. Unarmed for mock videos without the method; a deadline
 * that fires after the error-revert already cleared the route is a no-op.
 */
function armFrameWatchdog(video, nativeUrl, revokeObjectUrl, watchdogMs) {
  const deadline = AbortSignal.timeout(watchdogMs);
  const onDeadline = () => {
    revertToNative(video, nativeUrl, revokeObjectUrl);
  };
  deadline.addEventListener("abort", onDeadline, { once: true });
  // The first composited frame proves the blob is live media - the watchdog's
  // whole duty. onFrame self-unsubscribes on that frame and on error/emptied/
  // ended (the error fallback owns those); the deadline is left running for a
  // no-method mock, where onFrame returns false and cannot disarm us.
  onFrame(video, () => {
    deadline.removeEventListener("abort", onDeadline);
  }, { signal: null });
}

/** The element's media URL. `currentSrc` wins once a source is selected;
 *  otherwise the attribute value. Resolved absolute so a scheme-relative src
 *  (`//streamtape.com/...`) routes with a real URL - the raw string is what a
 *  browser would hand a page XHR and has no business reaching a provider. */
function resolveSrcUrl(video, baseUrl) {
  const raw = video?.currentSrc || video?.src;
  if (!raw) {
    return null;
  }
  return URL.canParse(raw, baseUrl) ? new URL(raw, baseUrl).href : null;
}

/** Only http(s) srcs are routable; blob:/data: the page already owns bytes
 *  for (a cleared native wire is a frozen wire). */
function streamable(url) {
  return STREAM_SCHEME_RE.test(String(url ?? ""));
}

/**
 * §Phase 6 MSE stream takeover at the element level. Where progressive MP4
 * routing hands the element an object URL over proxied bytes, a manifest
 * takeover builds a full `attachTakeover` plane (MediaSink + per-lane
 * SegmentManagers + AES-128/ClearKey) off a §7.4 claim from the bootstrap
 * ring. The claim was decided at the manifest fetch; the element seam is the
 * rendezvous: it picks the first engaged claim that survives `attachTakeover`'s
 * own ablation re-check and rides the same decline-to-native policy as
 * progressive routing — feature toggle off, a busy video, an already-armed
 * takeover, an unsupported (TS) lane, or an attach failure all leave the
 * element and the page player untouched. Detach happens on element cleanup
 * (`disposeManifestStream`), which also disarms a takeover the flow disengaged
 * out from under it (the claim no longer exists; `attachTakeover`'s
 * `sourceclose` path already handled a page that grabbed the element).
 */
export async function routeManifestStreams({
  video,
  claims,
  attach = attachTakeover,
  provider,
  mse = {},
  decrypter = null,
  eme = null,
  checkBusy = null,
  managerOptions = {},
  getSetting = () => false,
  onTakeover = () => {},
  onDecline = () => {}
}) {
  if (!video || !claims) {
    return null;
  }
  if (getSetting("features.mse") !== true) {
    return null;
  }
  if (pendingTakeovers.has(video) || activeTakeovers.has(video)) {
    return null;
  }
  pendingTakeovers.add(video);
  try {
    for (const claim of claims.values()) {
      const result = await attach({
        video,
        claim,
        provider,
        mse,
        decrypter,
        eme,
        checkBusy: checkBusy ?? undefined,
        managerOptions
      });
      if (result?.taken) {
        activeTakeovers.set(video, result);
        pendingTakeovers.delete(video);
        onTakeover(result);
        return result;
      }
      onDecline(result);
    }
    pendingTakeovers.delete(video);
    return null;
  } catch (err) {
    pendingTakeovers.delete(video);
    logger.warn("proxy", "mp4", "manifest takeover threw, keeping page player", err?.message ?? err);
    return null;
  }
}

/**
 * Detach a routed takeover from the element (shell teardown). Idempotent:
 * clearing an element with no active takeover is a no-op that also releases a
 * stale in-flight guard, so a shell that never saw a claim cannot wedge a
 * later one.
 */
export async function disposeManifestStream(video, { detach = null } = {}) {
  const takeover = activeTakeovers.get(video);
  activeTakeovers.delete(video);
  pendingTakeovers.delete(video);
  if (!takeover) {
    return false;
  }
  const release = detach ?? takeover.detach;
  await release();
  return true;
}

/**
 * Route a progressive MP4 assigned straight to `video.src`. Returns the routed
 * record `{ url, objectUrl, bytes }`, or null (native wire kept) for any
 * refusal or failure.
 */
export async function routeProgressiveSource({
  video,
  router,
  getSetting = () => true,
  enabledFor = () => true,
  baseUrl = (typeof location !== "undefined" && location?.href) || FALLBACK_BASE,
  makeObjectUrl = defaultMakeObjectUrl,
  revokeObjectUrl = defaultRevokeObjectUrl,
  onRoute = () => {},
  maxBytes = ELEMENT_ROUTE_MAX_BYTES,
  // Compiled-default fallback only: the decision-time ceiling is the settings
  // engine's proxy.mp4MaxBytes when it holds a finite number, so a panel-tuned
  // route applies per src without a reinstall. The seam stays test-overridable.
  frameWatchdogMs = FRAME_WATCHDOG_MS,
  makeCleanupRegistry = defaultMakeCleanupRegistry
}) {
  if (!video || !router) {
    return null;
  }
  if (getSetting("features.mp4Fallback") !== true) {
    return null;
  }
  if (pendingRoutes.has(video) || routedUrls.has(video)) {
    return null;
  }
  const url = resolveSrcUrl(video, baseUrl);
  if (!url || !streamable(url)) {
    return null;
  }
  if (!isMp4StreamUrl(url)) {
    return null;
  }
  if (!enabledFor(url)) {
    return null;
  }

  pendingRoutes.add(video);
  // Bail out of a whole-file proxy download the instant it crosses the
  // ceiling: several GiB in a Uint8Array is not a route, it is a tab killer.
  // The element keeps its untouched native src, so no progress is lost.
  // Decision-time ceiling: the settings engine's proxy.mp4MaxBytes (bytes)
  // overrides the compiled default - a user tuning the panel applies at the
  // next src route, no reinstall, and a poisoned (non-finite) stored value
  // fails toward the bounded default, the native wire being the safe lane.
  const ceiling =
    typeof getSetting === "function" && Number.isFinite(getSetting("proxy.mp4MaxBytes"))
      ? getSetting("proxy.mp4MaxBytes")
      : maxBytes;
  const controller = new AbortController();
  let exceeded = false;
  const onProgress = (ev) => {
    const loaded = Number(ev?.loaded ?? 0);
    const total = Number(ev?.total ?? 0);
    if (loaded > ceiling || (total > 0 && total > ceiling)) {
      exceeded = true;
      controller.abort();
      const shown = total > 0 ? `${Math.round(total / (1024 * 1024))}MiB` : `${Math.round(loaded / (1024 * 1024))}MiB`;
      logger.warn("proxy", "mp4", "element route oversized, keeping native wire", url, `${shown} > ${Math.round(ceiling / (1024 * 1024))}MiB`);
    }
  };
  let response;
  try {
    response = await router.routeRequest(url, { signal: controller.signal, onProgress });
  } catch (err) {
    logger.warn("proxy", "mp4", "element route threw, keeping native wire", url, err?.message ?? err);
    pendingRoutes.delete(video);
    return null;
  }
  if (!response) {
    pendingRoutes.delete(video);
    if (exceeded) {
      return null;
    }
    logger.warn("proxy", "mp4", "element route declined, keeping native wire", url);
    return null;
  }
  let blob;
  try {
    blob = await response.blob();
  } catch (err) {
    logger.warn("proxy", "mp4", "element route body failed, keeping native wire", url, err?.message ?? err);
    pendingRoutes.delete(video);
    return null;
  }
  if (blob.size > ceiling) {
    // An abort race can still deliver the whole oversized file - never swap it.
    pendingRoutes.delete(video);
    logger.warn(
      "proxy",
      "mp4",
      "element route oversized, keeping native wire",
      url,
      `${Math.round(blob.size / (1024 * 1024))}MiB > ${Math.round(ceiling / (1024 * 1024))}MiB`
    );
    return null;
  }
  const objectUrl = makeObjectUrl(blob);
  if (!objectUrl) {
    logger.warn("proxy", "mp4", "element route object URL unavailable, keeping native wire", url);
    pendingRoutes.delete(video);
    return null;
  }
  // Swap: aborts the in-flight native GET, the proxy GET stays the initiator.
  pendingRoutes.delete(video);
  const previous = routedUrls.get(video);
  if (previous) {
    revokeRouted(video, revokeObjectUrl);
  }
  const cleanupRegistry = makeCleanupRegistry((route) => route.revokeObjectUrl(route.objectUrl));
  cleanupRegistry.register(video, { objectUrl, revokeObjectUrl }, video);
  routeCleanupRegistries.set(video, cleanupRegistry);
  video.src = objectUrl;
  routedUrls.set(video, objectUrl);
  armNativeFallback(video, url, revokeObjectUrl);
  armFrameWatchdog(video, url, revokeObjectUrl, frameWatchdogMs);
  logger.warn("proxy", "mp4", "element routed through proxy", url, { bytes: blob.size.toLocaleString() });
  onRoute({ url, objectUrl, bytes: blob.size });
  return { url, objectUrl, bytes: blob.size };
}

/**
 * MSE data-plane orchestration (§Phase 6, fMP4-gated).
 *
 * This is the join the request-boundary seams cannot make: a §7.4 claim is
 * decided at the manifest fetch (no video in scope there), and a MediaSource
 * can only attach to the <video> element itself. `attachTakeover` is the
 * element-side rendezvous: given a claim (engage outcome + manifest text) and
 * the video it feeds, it builds the whole Plane — `MediaSink` on the element,
 * one `SegmentManager` per lane driven by the fragment plan from
 * `segment-flow.js`, an `Aes128Decrypter` for HLS AES-128 lanes, and a
 * `ClearKeyEme` for DASH-IF ClearKey streams — then detaches the same way,
 * handing the element back toward native.
 *
 * Hard platform boundary: Firefox's MSE has no MPEG-TS column, so a raw `.ts`
 * lane is NOT take-over-able here — the page player (hls.js/dash.js) keeps
 * those bytes via Mode-A routing, which is exactly why the request-boundary
 * pipe exists. A take-over therefore engages only streams composed of
 * fragmented-MP4 lanes (HLS `#EXT-X-MAP` inits / DASH `SegmentTemplate`/
 * `SegmentList`/`SegmentBase` inits), and only when EVERY lane qualifies —
 * a mixed audio+video plan where one lane is TS declines as a whole, since
 * feeding one lane while the page owns the other desyncs playback. No
 * transmuxing, no guesswork: the lane either proves fMP4 via an init segment
 * or the take-over refuses and the page stays in charge, untouched.
 *
 * Every refusal is { taken: false, reason } with nothing written to the
 * element — Mode-A byte routing keeps running under the page player. Engage
 * is gated by the caller (the element seam checks the `features.mse` toggle),
 * re-verified against the ablation guard at attach time (a page player that
 * committed bytes in the gap since t2 wins), and surrendered the instant the
 * page grabs the element (`sourceclose`), through the flow's downgrade from
 * `ManifestFlow`, or on explicit `detach()`.
 *
 * Deterministic: MediaSource/object-URL creation, provider bytes, decrypt,
 * EME, and the video element are all injectable seams, so the whole plane —
 * attach, init-before-media, in-order append, teardown — runs headless.
 */
/** Per-lane fetch concurrency for the take-over's SegmentManagers. */
const LANE_CONCURRENCY = 2;

/** A lane counts as fragmented MP4 when it carries an init segment (HLS
 *  `#EXT-X-MAP` → lane.maps, DASH `<Initialization>`/`initialization=` →
 *  lane.init). Raw TS lanes have neither and are left to the page player. */
function laneHasInit(lane) {
  return (
    (Array.isArray(lane.maps) && lane.maps.length > 0) ||
    (lane.init && lane.init.uri != null)
  );
}

/** HLS AES-128 proves through any encrypted segment on the lane (the parser
 *  tags each segment with the `#EXT-X-KEY` active at it). DASH CENC/ClearKey
 *  flows ride EME instead and never take the in-band decrypt path. */
function laneIsAes128(lane) {
  return Array.isArray(lane.segments) && lane.segments.some((s) => s.encrypted === true);
}

/** The mime type one lane appends under. DASH lanes carry their own
 *  `mimeType`/`codecs`; an HLS fMP4 lane (proofed by `#EXT-X-MAP`) defaults
 *  to `video/mp4`, codecs attached when the plan names them. */
export function laneMime(lane) {
  const base = lane.mimeType ?? "video/mp4";
  return lane.codecs && lane.codecs !== "" ? `${base}; codecs="${lane.codecs}"` : base;
}

/** Fetch one byte payload through the provider with the status honored:
 *  2xx → the drained body; anything else → a retryable SegmentError carrying
 *  the status (the manager's retry seam decides healing). */
async function providerBytes(provider, uri, byteRange, signal) {
  const { resp, via } = await provider.fetch(uri, { signal, byteRange });
  const status = Number(resp?.status ?? 0);
  if (status !== 0 && (status < 200 || status >= 300)) {
    throw new SegmentError(`takeover fetch ${status} for ${uri}`, { status });
  }
  const body = resp?.body;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body ?? 0);
  logger.log("proxy", "takeover", "fetched", uri, { via, status, bytes: bytes.byteLength });
  return bytes;
}

function decline(reason) {
  logger.log("proxy", "takeover", "declined", reason);
  return { taken: false, reason };
}

/** Return the element to a no-src state after we set its src to our own
 *  object URL (handed back on teardown / arm failure / surrender). Guarded:
 *  if the page already moved the element to a NEW src, it is never clobbered. */
function handBack(video, objectURL) {
  if (!objectURL) {
    return;
  }
  if (video?.src === objectURL || video?.currentSrc === objectURL) {
    if (typeof video.removeAttribute === "function") {
      video.removeAttribute("src");
    } else {
      video.src = "";
    }
  }
}

/**
 * Build the MSE data plane for one engaged manifest. Returns
 * `{ taken: true, reason, video, claim, sink, managers, eme, detach() }` on
 * success, or `{ taken: false, reason }` on any refusal — nothing on the
 * element is touched in the refusal path.
 *
 * Ablation is re-checked HERE (the instant before attach) even though the
 * flow checked it at t2: the page player may have committed bytes or a
 * MediaSource in the gap, and the video wins over the claim.
 *
 * @param {object} env
 * @param {object}   env.video           the <video>/fake the stream feeds.
 * @param {object}   env.claim           { manifestUrl, kind, text, klass,
 *                                        laurl? } — the engaged claim.
 * @param {object}   env.provider        ProxyProvider transport for init +
 *                                       segments ({ fetch(uri, opts) }).
 * @param {object}   [env.mse]           MSEFactory seams ({ mediaSource }).
 * @param {object}   [env.decrypter]     Aes128Decrypter (or subtle/keyLoader
 *                                       seams to build one lazily).
 * @param {object}   [env.eme]           ClearKeyEme (built lazily).
 * @param {Function} [env.checkBusy]     (video) => boolean ablation re-check;
 *                                       default: any readyState past
 *                                       HAVE_NOTHING or any src set → busy.
 * @param {object}   [env.managerOptions] SegmentManager overrides per lane
 *                                       ({ signal } for headless teardown).
 */
export async function attachTakeover({
  video,
  claim,
  provider,
  mse = {},
  decrypter = null,
  eme = null,
  checkBusy = (v) =>
    (typeof v?.readyState === "number" && v.readyState > 0) ||
    (typeof v?.currentSrc === "string" && v.currentSrc !== "") ||
    (typeof v?.src === "string" && v.src !== "") ||
    typeof v?.mediaSource !== "undefined",
  managerOptions = {}
} = {}) {
  if (!video || !claim || !provider) {
    return decline("missing-seam");
  }
  const manifestUrl = claim.manifestUrl;
  const text = typeof claim.text === "string" ? claim.text : "";
  if (!manifestUrl || !text) {
    return decline("no-manifest");
  }
  if (checkBusy(video)) {
    return decline("busy");
  }

  // The fragment plan decides everything downstream. Unparseable input — or a
  // plan with no concrete segments (live, unbounded template) — declines; the
  // page player already rides Mode-A for those.
  let plan;
  try {
    plan = parseManifest(text, { kind: claim.kind ?? null, baseUrl: manifestUrl });
  } catch (err) {
    logger.warn("proxy", "takeover", "manifest unparseable", manifestUrl, err?.message ?? err);
    return decline("parse");
  }
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
  if (lanes.length === 0 || !lanes.every(laneHasInit)) {
    // Every-lane rule: a mixed fMP4+TS plan declines wholesale so one lane
    // never desyncs against the page player.
    return decline("media-lane-unsupported");
  }
  if (!lanes.some((l) => Array.isArray(l.segments) && l.segments.length > 0)) {
    // Concrete fragments only: an init with no segment list (live unbounded
    // template) would arm an empty plane — Mode-A byte routing already serves
    // the page player those streams.
    return decline("no-concrete-segments");
  }

  // AES-128 lanes cannot reach cleartext without the decrypt pipeline; a plan
  // that needs it and cannot get it declines up front (never half-served).
  const needsAes128 = lanes.some(laneIsAes128);
  const aes =
    decrypter ??
    // A keyLoader is the credential seam the decrypter needs to fetch keys;
    // without one (or an injected decrypter) an AES-128 lane would arm a pipe
    // that can never reach cleartext — decline instead of half-serving.
    (needsAes128 && mse.keyLoader != null
      ? new Aes128Decrypter({ subtle: mse.subtle ?? null, keyLoader: mse.keyLoader })
      : null);
  if (needsAes128 && !aes) {
    return decline("no-decrypt");
  }

  const factory = mse instanceof MSEFactory ? mse : new MSEFactory(mse);
  let sink;
  try {
    sink = await factory.create({ video, mimeType: laneMime(lanes[0]) });
  } catch (err) {
    logger.warn("proxy", "takeover", "MediaSource attach failed", manifestUrl, err?.message ?? err);
    return decline("mse");
  }

  const signal = managerOptions.signal ?? null;
  const managers = [];
  let encryptedListener = null;
  let clearKey = null;
  try {
    for (const lane of lanes) {
      const mime = laneMime(lane);
      // Init first: the lane must prove its codecs before a single media
      // fragment lands on its SourceBuffer. HLS carries it as lane.maps[0]
      // (possibly a byte range of the media resource), DASH as lane.init.
      const initInfo = lane.init ?? (Array.isArray(lane.maps) && lane.maps.length > 0 ? lane.maps[0] : null);
      const initBytes = await providerBytes(provider, initInfo.uri, initInfo.byteRange ?? null, signal);
      sink.setInit(initBytes, { mimeType: mime });

      const segments = Array.isArray(lane.segments) ? lane.segments : [];
      // Positional windows alt to the manager's strict per-lane sequence.
      const byId = new Map();
      {
        let cursor = 0;
        for (const seg of segments) {
          const duration = Number(seg.duration ?? 0);
          byId.set(seg.id, { startTime: cursor, endTime: cursor + duration });
          cursor += duration;
        }
      }
      const isAes = laneIsAes128(lane);
      const manager = new SegmentManager({
        fetch: (seg, sig) => providerBytes(provider, seg.uri, seg.byteRange ?? null, sig),
        append: (seg, bytes) => {
          const win = byId.get(seg.id) ?? null;
          return sink.enqueue(seg.id, bytes, {
            mimeType: mime,
            startTime: win?.startTime ?? null,
            endTime: win?.endTime ?? null
          });
        },
        decrypt:
          isAes && aes
            ? (seg, bytes) =>
                aes.decrypt({
                  data: bytes,
                  keyUri: seg.key?.uri,
                  ivHex: seg.key?.iv ?? null,
                  sequence: seg.id
                })
            : null,
        concurrency: LANE_CONCURRENCY,
        allowGaps: false,
        maxRefreshes: 0,
        startSeq: segments.length > 0 ? segments.reduce((lo, s) => Math.min(lo, s.id), segments[0].id) : 0,
        ...managerOptions
      });
      managers.push(manager);
      for (const seg of segments) {
        manager.enqueue({
          id: seg.id,
          uri: seg.uri,
          byteRange: seg.byteRange ?? null,
          encrypted: isAes && seg.encrypted === true,
          key: seg.key ?? null
        });
      }
    }

    if (claim.klass === "clearkey") {
      clearKey = eme ?? new ClearKeyEme();
      await clearKey.attach(video, { laurl: claim.laurl ?? "" });
      if (typeof video.addEventListener === "function") {
        encryptedListener = (event) => {
          clearKey.handleEncrypted({ initData: event?.initData, initDataType: event?.initDataType });
        };
        video.addEventListener("encrypted", encryptedListener);
      }
      logger.log("proxy", "takeover", "ClearKey armed", manifestUrl);
    }
  } catch (err) {
    // Anything that fails before the plane is fully up hands the element back
    // — never leave a half-attached MediaSource or a dangling CDM behind.
    logger.warn("proxy", "takeover", "arm failed, tearing down", manifestUrl, err?.message ?? err);
    for (const m of managers) m.destroy();
    try {
      sink.destroy();
    } catch {}
    handBack(video, sink.objectURL);
    if (clearKey) {
      try {
        await clearKey.detach();
      } catch {}
    }
    return decline("arm");
  }

  // The page player beat us to the element the moment its MSE closed ours
  // (a blob/hls.js src swap overwrites ours). Release the plane without
  // touching the element's now-foreign src.
  const surrendered = { value: false };
  let closeListener = null;
  if (typeof sink.mediaSource?.addEventListener === "function") {
    closeListener = () => {
      if (surrendered.value) return;
      surrendered.value = true;
      logger.log("proxy", "takeover", "page took the element, releasing plane", manifestUrl);
      for (const m of managers) m.destroy();
      try {
        sink.destroy();
      } catch {}
      if (clearKey) {
        clearKey.detach();
      }
    };
    sink.mediaSource.addEventListener("sourceclose", closeListener);
  }

  logger.warn("proxy", "takeover", "takeover armed", manifestUrl, {
    lanes: lanes.length,
    mime: lanes.map(laneMime)
  });

  const release = async () => {
    if (surrendered.value) {
      for (const m of managers) m.destroy();
      return;
    }
    surrendered.value = true;
    for (const m of managers) m.destroy();
    try {
      sink.destroy();
    } catch {}
    handBack(video, sink.objectURL);
    if (clearKey) {
      try {
        await clearKey.detach();
      } catch {}
    }
    if (closeListener && typeof sink.mediaSource?.removeEventListener === "function") {
      sink.mediaSource.removeEventListener("sourceclose", closeListener);
    }
    if (encryptedListener && typeof video.removeEventListener === "function") {
      video.removeEventListener("encrypted", encryptedListener);
    }
  };

  return {
    taken: true,
    reason: "armed",
    video,
    claim,
    sink,
    managers,
    eme: clearKey,
    detach: release
  };
}/**
 * Unified playback-progress incident feed via `requestVideoFrameCallback`
 * (§7.8). The framework has two independent consumers that both reach down to
 * the media element's "a frame was actually composited" signal:
 *  - the element MP4 route's dead-bytes watchdog (arm a deadline, disarm when
 *    the first rendered frame proves the blob is live media);
 *  - resume's pause flush (save the exact mediaTime of the last rendered
 *    frame, which is what the user saw, not the decoder's leading/trailing
 *    currentTime).
 * Each inlined its own `requestVideoFrameCallback` callback. This module is
 * the single seam: `onFrame(video, cb, { signal })` arms one rVFC request and
 * fires `cb(frame)` (the VideoFrameCallbackMetadata) exactly once on the next
 * composited frame, then unsubscribes itself; it also disarms on `error` /
 * `emptied` / `ended`, surfaces via an optional `onPast` so a watchdog can keep
 * its deadline ticking.
 *
 * Firefox-native: requestVideoFrameCallback is FF 132+ (baseline 2024) and is
 * invoked unguarded on the element - the same no-feature-detect contract as
 * every FF-155-native API. The only guard is for a bare mock video in a test
 * host that lacks the method: instead of arming a dead observer, `onFrame`
 * returns false and the caller's own fallback runs (resume already falls back
 * to `currentTime`; the watchdog treats a method-less mock as "can't prove
 * dead, keep the route").
 *
 * Deterministic: every consumer passes the same seam is not enough - the
 * observer class is not global here, the *method* is element-owned, so
 * headless tests inject a stub `requestVideoFrameCallback`. The module is a
 * pure funnel: no DOM, no network, nothing beyond the element method.
 */

/** Fire `cb(now, frame)` on the next composited frame, mirroring the browser's
 *  requestVideoFrameCallback callback shape, or `onPast(now)` when the video
 *  will never present one (error/emptied/ended). Self-unsubscribing. Returns
 *  true when the method existed and a request was armed, false on a
 *  method-less element (caller runs its own fallback). `signal` (optional)
 *  aborts the pending request and detaches any listener.
 */
export function onFrame(video, cb, { onPast = () => {}, signal = null } = {}) {
  if (!video || typeof video.requestVideoFrameCallback !== "function") {
    return false;
  }
  let done = false;
  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    video.cancelVideoFrameCallback?.(handle);
    removeEventListeners();
    signal?.removeEventListener("abort", abort);
    fn(...args);
  };
  const abort = () => {
    finish(onPast);
  };
  const onError = () => finish(onPast);
  const onEnded = () => finish(onPast);
  const removeEventListeners = () => {
    video.removeEventListener?.("error", onError);
    video.removeEventListener?.("emptied", onError);
    video.removeEventListener?.("ended", onEnded);
  };
  if (signal?.aborted) {
    onPast();
    return true;
  }
  const frameCb = (now, metadata) => finish(cb, now, metadata);
  const handle = video.requestVideoFrameCallback(frameCb);
  video.addEventListener?.("error", onError);
  video.addEventListener?.("emptied", onError);
  video.addEventListener?.("ended", onEnded);
  signal?.addEventListener("abort", abort, { once: true });
  return true;
}