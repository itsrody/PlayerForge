/**
 * MP4 stream routing at the request boundary (§7.6).
 *
 * The proxy is the network layer: it never touches the DOM. When a page issues
 * an MP4-shaped fetch (StreamTape-style `get_video`, `.mp4`, `stream=1` — or any
 * response that comes back `video/mp4`), the request is routed through the
 * ProxyProvider before it reaches the wire. The userscript's GET is therefore
 * the Network initiator, the same shape HLS/DASH segments have, and the page
 * receives a fabricated Response over the proxied bytes. Nothing on the page —
 * no video element, no blob URL, no prototype — is patched or observed beyond
 * the fetch/XHR interpose surfaces themselves.
 *
 * Any routing failure (out of policy, network error, non-2xx) returns null and
 * the interposer keeps the native wire: degrade toward native, never frozen.
 * Detection is content-aware: URL shape marks a request routable, and the
 * response content-type confirms when one is seen.
 *
 * Deterministic: the provider (GM→fetch seam), policy gate, and Response
 * creator are constructor parameters, so the whole chain runs headless.
 */
import { logger } from "../../shared/logger.js";

/** Stream-shaped URLs:
 *  - `.mp4` paths (query/fragment/trailing-segment included) - direct MP4s;
 *  - `get_video` handlers and `stream=1` markers - StreamTape-style endpoints
 *    that answer with a redirect to the real file;
 *  - presigned media CDNs (`radosgw` S3 paths, `tapecontent.net` shards) whose
 *    tokenized URLs carry the `.mp4` deep inside an opaque `/radosgw/{id}/{huge
 *    token}/{file}.mp4` path - the shape the StreamTape get_video redirects
 *    into. Tokens are opaque to us: routing keeps the full URL, token intact.
 *    The presigned branch only matches when a `.mp4` also appears, so plain
 *    shard assets are not misrouted. */
const MP4_STREAM_URL_RE = /\.mp4(?:[?#]|$)|get_video|[?&]stream=1\b|(?:tapecontent|radosgw)[^#?]*\.mp4/i;

const MP4_CONTENT_TYPE_RE = /^video\/mp4\b/i;

/** True for a URL that could be a progressive MP4 stream. `get_video` and
 *  `stream=1` carry no content-type hint, so URLs alone mark them routable -
 *  the response content-type (when a capture sees one) confirms. */
export function isMp4StreamUrl(url) {
  return MP4_STREAM_URL_RE.test(String(url ?? ""));
}

/** True for a `video/mp4` content-type header value. */
export function isMp4ContentType(contentType) {
  return MP4_CONTENT_TYPE_RE.test(String(contentType ?? ""));
}

/** A content-type a media fetch will accept. Servers often tag progressive MP4s
 *  `application/octet-stream` or `binary/octet-stream`; handing that through to
 *  the page would make `Response#blob()` return a blob the player refuses to
 *  load. Map anything that is not a video/audio media type to `video/mp4`. */
export function mediaSafeType(contentType) {
  return /^(?:video|audio)\//i.test(String(contentType ?? "")) ? String(contentType) : "video/mp4";
}

/** Redirect hops a routed stream may follow before we give up and keep the
 *  native wire. `get_video`-style endpoints answer with a 3xx to the real file. */
const MAX_ROUTE_REDIRECTS = 5;

function headerValue(headers, name) {
  const target = String(name ?? "").toLowerCase();
  if (headers && typeof headers.get === "function") {
    return headers.get(name) ?? null;
  }
  if (headers && typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target) {
        return headers[key];
      }
    }
  }
  return null;
}

function resolveLocation(baseUrl, location) {
  const loc = String(location ?? "").trim();
  if (!loc) {
    return null;
  }
  try {
    return new URL(loc, baseUrl).href;
  } catch {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(loc) ? loc : null;
  }
}

/**
 * Request-level MP4 takeover. `routeRequest(url)` fetches the stream through
 * the ProxyProvider and fabricates the page's Response from the proxied bytes -
 * the proxy is the Network initiator for the media GET. Returns the fabricated
 * Response, or null for out-of-policy / unroutable / failed requests, in which
 * case the caller keeps the native wire untouched.
 *
 * URL-shape routing (`routeRequest`) engages a request before the wire. A URL
 * with no MP4 shape can still *be* an MP4 stream (the response says so); the
 * caller that already saw `video/mp4` content-type routes it with
 * `routeContent(appurl)`, which skips the shape gate but keeps every other.
 */
export class Mp4Router {
  #provider;
  #enabledFor;
  #makeResponse;
  #onRoute;

  constructor({
    provider,
    enabledFor = () => true,
    makeResponse = (body, init) => new Response(body, init),
    onRoute = () => {}
  } = {}) {
    if (!provider) {
      throw new TypeError("Mp4Router requires a provider");
    }
    this.#provider = provider;
    this.#enabledFor = enabledFor;
    this.#makeResponse = makeResponse;
    this.#onRoute = onRoute;
  }

  async routeRequest(url, { byContent = false } = {}) {
    if ((!byContent && !isMp4StreamUrl(url)) || !this.#enabledFor(url)) {
      return null;
    }
    return this.#route(url);
  }

  /** Content-type-armed route: URL shape is not required, the caller already
   *  confirmed the response is `video/mp4`. */
  routeContent(url) {
    return this.routeRequest(url, { byContent: true });
  }

  async #route(url, hops = 0) {
    let resp;
    try {
      ({ resp } = await this.#provider.fetch(url));
    } catch (err) {
      logger.warn("proxy", "mp4", "route request failed, keeping native wire", url, err?.message ?? err);
      return null;
    }
    if (!resp) {
      logger.warn("proxy", "mp4", "route request empty, keeping native wire", url);
      return null;
    }
    if (resp.status >= 300 && resp.status < 400) {
      // StreamTape-style get_video answers with a redirect to the real file.
      // Peel it hop-by-hop ourselves so routing never depends on the transport
      // manager choosing to follow - a raw 3xx is treated as "native wire",
      // which would silently skip the actual mp4.
      const location = headerValue(resp.headers, "location");
      const next = resolveLocation(url, location);
      if (!next) {
        logger.warn("proxy", "mp4", "route redirect without a Location, keeping native wire", url, resp.status);
        return null;
      }
      if (hops >= MAX_ROUTE_REDIRECTS) {
        logger.warn("proxy", "mp4", "route redirect chain too long, keeping native wire", url, next);
        return null;
      }
      logger.warn("proxy", "mp4", "route redirect", url, resp.status, "->", next);
      return this.#route(next, hops + 1);
    }
    if (!(resp.status >= 200 && resp.status < 300)) {
      logger.warn("proxy", "mp4", "route request not ok, keeping native wire", url, resp?.status);
      return null;
    }
    const contentType = mediaSafeType(headerValue(resp.headers, "content-type") ?? "video/mp4");
    const response = this.#makeResponse(resp.body, {
      status: resp.status,
      headers: { ...(resp.headers ?? {}), "content-type": contentType }
    });
    this.#onRoute({ url, status: resp.status, bytes: resp.body?.byteLength ?? 0 });
    logger.warn(
      "proxy",
      "mp4",
      "routed fetch through proxy",
      url,
      { status: resp.status, bytes: (resp.body?.byteLength ?? 0).toLocaleString() }
    );
    return response;
  }
}