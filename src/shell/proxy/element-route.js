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
 * revoked on re-route, on dispose, and never leaks after the element dies.
 *
 * Deterministic: object-URL creation/revocation and the base URL are
 * injectable, so the whole flow runs headless.
 */
import { logger } from "../../shared/logger.js";
import { isMp4StreamUrl } from "./mp4.js";

const FALLBACK_BASE = "https://nowhere.invalid/";

/** Ceiling for a whole-file element route. Bigger than this and the download
 *  would hog GBs in a single GM arraybuffer (a 4K movie silently balloons past
 *  every browser's comfort zone); the seam instead aborts the proxied GET and
 *  keeps the native media-stack wire - which streams + seeks by design. */
const ELEMENT_ROUTE_MAX_BYTES = 1024 * 1024 * 1024;

/** Per-element routed object URLs, revoked on re-route or dispose. */
const routedUrls = new WeakMap();
/** Per-element in-flight guards so two routes never race. */
const pendingRoutes = new WeakSet();

function defaultMakeObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectUrl(objectUrl) {
  URL.revokeObjectURL(objectUrl);
}

/** MediaError.code for "the resource (object URL) could not be loaded". */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** Release the object URL the seam handed `video` (idempotent). */
export function disposeElementSource(video, { revokeObjectUrl = defaultRevokeObjectUrl } = {}) {
  const objectUrl = routedUrls.get(video);
  if (objectUrl) {
    routedUrls.delete(video);
    pendingRoutes.delete(video);
    revokeObjectUrl(objectUrl);
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
    const objectUrl = routedUrls.get(video);
    if (!objectUrl) {
      return;
    }
    if (video.currentSrc !== objectUrl && video.src !== objectUrl) {
      return;
    }
    routedUrls.delete(video);
    revokeObjectUrl(objectUrl);
    video.src = nativeUrl;
  }, { once: true });
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
  maxBytes = ELEMENT_ROUTE_MAX_BYTES
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
    revokeObjectUrl(previous);
  }
  video.src = objectUrl;
  routedUrls.set(video, objectUrl);
  armNativeFallback(video, url, revokeObjectUrl);
  logger.warn("proxy", "mp4", "element routed through proxy", url, { bytes: blob.size.toLocaleString() });
  onRoute({ url, objectUrl, bytes: blob.size });
  return { url, objectUrl, bytes: blob.size };
}