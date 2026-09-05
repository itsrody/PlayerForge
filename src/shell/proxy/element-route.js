/**
 * Element-level progressive MP4 routing.
 *
 * StreamTape-style players assign a media URL straight to `video.src`; the
 * browser's media stack performs those GETs in the network process, so no page
 * fetch/XHR is involved and the request-boundary seams never see them - the
 * proxy can never be the Network initiator for that class. This module is the
 * one controlled element-level surface for it: it routes the element's current
 * src through the same Mp4Router the wire seams use (get_video redirects
 * peeled hop-by-hop, tokenized CDN URLs kept intact) and hands the element an
 * object URL over the proxied bytes, making the userscript's GET the initiator
 * exactly as HLS/DASH segment fetches already are.
 *
 * Whole-file model: the full file is buffered before the src swap. Firefox has
 * no element-level "proxy passthrough" for `video.src`, and MediaSource would
 * require a fragmented MP4 the CDN does not send - so this mirrors the
 * request-boundary MP4 route: buffer the whole stream, then play. Whole-file
 * downloads can silently balloon (a 4K movie exceeds a GiB), so a size ceiling
 * aborts the proxied GET and reverts to the native media-stack wire rather
 * than buffering it all - the streaming + seeking the browser already does.
 *
 * Policy is cooperative and degrades to native: any refusal - off-switch, gate
 * decline, network error, non-2xx, redirect cap, blob:/data:/empty src - leaves
 * the element's src untouched and the native wire in charge. Never patch a
 * prototype: a routed element is tracked in a WeakMap so its object URL is
 * revoked on re-route, on dispose, and - via a FinalizationRegistry held on
 * the element - even when the page throws the element away without disposing
 * it.
 *
 * Dead-bytes watchdog: the file is fully buffered before the swap, so the first
 * frame should be composited almost immediately. A routed blob that never
 * presents a frame inside `frameWatchdogMs` - a 200-body that is not demuxable
 * media but fires no error, truncation that hangs metadata - is dead bytes, and
 * the element is handed back its native src through the same `revertToNative`
 * path the error fallback uses. `requestVideoFrameCallback` is the "pixels
 * actually composited" signal (FF 132+, baseline 2024); a paused element still
 * presents its initial frame, so an unplayed routed blob disarms on load. Every
 * revert is toward the native wire, which streams the same resource, so the
 * element is never left frozen.
 *
 * Deterministic: object-URL creation/revocation, the base URL, the cleanup
 * registry factory, and the frame-watchdog deadline are injectable, so the
 * whole flow runs headless.
 */
import { logger } from "../../shared/logger.js";
import { onFrame } from "../../kernel/proxy/frame-watch.js";
import { isMp4StreamUrl } from "./mp4.js";
import { attachTakeover } from "./take-over.js";

const FALLBACK_BASE = "https://nowhere.invalid/";

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
  return /^https?:/i.test(String(url ?? ""));
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
  // ceiling: 10GiB in a Uint8Array is not a route, it is a tab killer. The
  // element keeps its untouched native src, so no progress is lost.
  const controller = new AbortController();
  let exceeded = false;
  const onProgress = (ev) => {
    const loaded = Number(ev?.loaded ?? 0);
    const total = Number(ev?.total ?? 0);
    if (loaded > maxBytes || (total > 0 && total > maxBytes)) {
      exceeded = true;
      controller.abort();
      const shown = total > 0 ? `${Math.round(total / (1024 * 1024))}MiB` : `${Math.round(loaded / (1024 * 1024))}MiB`;
      logger.warn("proxy", "mp4", "element route oversized, keeping native wire", url, `${shown} > ${Math.round(maxBytes / (1024 * 1024))}MiB`);
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
  if (blob.size > maxBytes) {
    // An abort race can still deliver the whole oversized file - never swap it.
    pendingRoutes.delete(video);
    logger.warn(
      "proxy",
      "mp4",
      "element route oversized, keeping native wire",
      url,
      `${Math.round(blob.size / (1024 * 1024))}MiB > ${Math.round(maxBytes / (1024 * 1024))}MiB`
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