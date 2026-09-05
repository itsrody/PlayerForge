/**
 * stream-transport.js — the request-boundary wire (consolidated from
 * `mp4.js` + `provider.js` + `token-manager.js`).
 *
 * The proxy is the network layer: it never touches the DOM. This module owns
 * the byte-moving face — `ProxyProvider` fetches one whole media payload per
 * request (GM first, native fetch fallback, bytes/streams honored), and
 * `Mp4Router` fabriates the page's Response over the proxied bytes, becoming
 * the Network initiator for MP4-shaped GETs (§7.6). Tokenized CDN paths stay
 * intact (`TokenManager`: TTL-tracked refresh + URL rewrite); redirect chains
 * are peeled hop-by-hop; a whole-file element route carries a size ceiling
 * that reverts to the native media-stack wire.
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
import { isProgressiveStreamUrl } from "../../shared/media-shapes.js";
import { SegmentError } from "./segment-flow.js";
import { injectPathTokens, injectQueryParams } from "./manifest-pipe.js";


const MP4_CONTENT_TYPE_RE = /^video\/mp4\b/i;
const MEDIA_FAMILY_RE = /^(?:video|audio)\//i;

/** True for a `video/mp4` content-type header value. */
export function isMp4ContentType(contentType) {
  return MP4_CONTENT_TYPE_RE.test(String(contentType ?? ""));
}

/** A content-type a media fetch will accept. Servers often tag progressive MP4s
 *  `application/octet-stream` or `binary/octet-stream`; handing that through to
 *  the page would make `Response#blob()` return a blob the player refuses to
 *  load. Map anything that is not a video/audio media type to `video/mp4`. */
export function mediaSafeType(contentType) {
  const value = String(contentType ?? "");
  return MEDIA_FAMILY_RE.test(value) ? value : "video/mp4";
}

/**
 * The stream-shaped URL taxonomy now lives in media-shapes.js; this function
 * delegates so the seam consumers (bootstrap, element-plane), the MPC contract,
 * and this module's own routing all share one predicate under the historical
 * name. `get_video`/`stream=1` carry no content-type hint, so the URL shape
 * marks them routable - the response content-type (when a capture sees one)
 * confirms.
 */
export function isMp4StreamUrl(url) {
  return isProgressiveStreamUrl(url);
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

/** A location with its own absolute scheme (or a `//` authority) needs no
 *  base. Hoisted - a regex literal in `resolveLocation` would re-allocate per
 *  redirect hop the router peels. */
const ABSOLUTE_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function resolveLocation(baseUrl, location) {
  const loc = String(location ?? "").trim();
  if (!loc) {
    return null;
  }
  return URL.canParse(loc, baseUrl)
    ? new URL(loc, baseUrl).href
    : ABSOLUTE_SCHEME_RE.test(loc) ? loc : null;
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
 * The same caller-classify semantic serves Mode-A segments: a manifest-engaged
 * segment URL (`.ts`/`.m4s`/...) is not MP4-shaped either, so the interpose
 * seam passes `byShape: true` once IT has matched the segment shape - the
 * progressive-MP4 shape gate is skipped, every other gate stays.
 */
export class Mp4Router {
  #provider;
  #enabledFor;
  #makeResponse;
  #onRoute;
  #reportNativeWire;

  constructor({
    provider,
    enabledFor = () => true,
    makeResponse = (body, init) => new Response(body, init),
    onRoute = () => {},
    reportNativeWire = () => {}
  } = {}) {
    if (!provider) {
      throw new TypeError("Mp4Router requires a provider");
    }
    this.#provider = provider;
    this.#enabledFor = enabledFor;
    this.#makeResponse = makeResponse;
    this.#onRoute = onRoute;
    this.#reportNativeWire = reportNativeWire;
  }

  async routeRequest(url, { byContent = false, byShape = false, signal = null, onProgress = null, stream = false } = {}) {
    if ((!byContent && !byShape && !isMp4StreamUrl(url)) || !this.#enabledFor(url)) {
      return null;
    }
    return this.#route(url, 0, signal, onProgress, stream);
  }

  /** Content-type-armed route: URL shape is not required, the caller already
   *  confirmed the response is `video/mp4`. */
  routeContent(url) {
    return this.routeRequest(url, { byContent: true });
  }

  async #route(url, hops = 0, signal = null, onProgress = null, stream = false) {
    let resp;
    let via;
    try {
      ({ via, resp } = await this.#provider.fetch(url, { signal, onProgress, stream }));
    } catch (err) {
      if (err?.name === "AbortError") {
        return null;
      }
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
      return this.#route(next, hops + 1, signal, onProgress, stream);
    }
    if (!(resp.status >= 200 && resp.status < 300)) {
      logger.warn("proxy", "mp4", "route request not ok, keeping native wire", url, resp?.status);
      return null;
    }
    const contentType = mediaSafeType(headerValue(resp.headers, "content-type") ?? "video/mp4");
    const body = resp.body;
    const response = this.#makeResponse(body, {
      status: resp.status,
      headers: { ...(resp.headers ?? {}), "content-type": contentType }
    });
    const bytes = resp.streamed ? null : (body?.byteLength ?? 0);
    this.#onRoute({ url, status: resp.status, bytes });
    // A routed request that went out over the native-fetch fallback rode the
    // same wire the media element's own GETs use; surface it on the kernel's
    // net-watch feed (via:proxy) so the fallback is not a blind spot.
    if (via === "fetch") {
      this.#reportNativeWire(url, resp.status);
    }
    logger.warn(
      "proxy",
      "mp4",
      resp.streamed ? "routed stream through proxy" : "routed fetch through proxy",
      url,
      { status: resp.status, bytes: bytes == null ? "(streaming)" : bytes.toLocaleString() }
    );
    return response;
  }
}


/** Cadence for whole-file progress breadcrumbs: log the first byte and then
 *  once per 64MiB, so a multi-minute movie download stays audible in the
 *  console without flooding it. */
const PROGRESS_LOG_STEP = 64 * 1024 * 1024;

export class ProxyProvider {
  /**
   * @param {object} [env] injectable runtime seams (tests replace these):
   * @param {Function} [env.gmFetch]   GM_xmlhttpRequest-compatible (req, cb) → aborter.
   * @param {object}   [env.native]    { fetch, headersClass } native fetch seams.
   * @param {object}   [env.gmAbort]   AbortController subclass that forwards to GM.abort.
   */
  constructor({
    gmFetch,
    native = { fetch, headersClass: Headers },
    gmAbort = null
  } = {}) {
    if (typeof native?.fetch !== "function") {
      throw new TypeError("ProxyProvider requires a native fetch seam");
    }
    this.#gmFetch = gmFetch;
    this.#nativeFetch = native.fetch;
    this.#gmAbort = gmAbort;
  }

  #gmFetch = null;
  #nativeFetch = null;
  #gmAbort = null;

  /** Fetch a single segment. `byteRange` is `{start, end}` (inclusive) or a
   *  `"start-end"` string; it becomes `Range: bytes=start-end`. Returns the
   *  provider chosen and the response. `onProgress` (optional) receives
   *  `{ loaded, total }` as bytes arrive - the caller's abort railway for
   *  oversized whole-file routes. `stream` (optional, default false) asks for
   *  the body as a passthrough ReadableStream rather than a fully-drained
   *  Uint8Array: only the native-fetch route can honor it (GM is serialized,
   *  so a GM-granular body is always drained); the element whole-file route
   *  never streams - it needs the whole bytes to build a blob and to enforce
   *  its size ceiling. */
  async fetch(uri, { signal, headers = {}, timeoutMs = 0, byteRange = null, onProgress = null, stream = false } = {}) {
    logger.log("proxy", "provider", "fetch", uri, { timeoutMs, byteRange, stream });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const requestHeaders = { ...headers };
    const rangeText = byteRange ? rangeHeaderValue(byteRange) : null;
    if (rangeText) {
      requestHeaders.Range = rangeText;
    }
    if (this.#gmFetch) {
      try {
        return {
          via: "gm",
          resp: await this.#gmRequest(uri, requestHeaders, signal, timeoutMs, onProgress)
        };
      } catch (err) {
        // An aborted GM attempt must not spawn a fallback fetch; any other
        // wire failure (setup, network, timeout) is a fallback candidate.
        if (err?.name === "AbortError") throw err;
        logger.warn("proxy", "provider", "GM request failed, falling back to fetch", uri, err?.message ?? err);
      }
    }
    return { via: "fetch", resp: await this.#fetchRequest(uri, requestHeaders, signal, timeoutMs, onProgress, stream) };
  }

  #gmRequest(uri, headers, signal, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Whole-file progressive MP4 downloads can run for minutes; report
      // download progress at a bounded cadence so the wait is visible and a
      // doggedly-slow CDN is distinguishable from a dead pipe.
      let lastProgressBytes = 0;
      const callbacks = {
        onabort: () => reject(new DOMException("Aborted", "AbortError")),
        onerror: (e) => reject(new SegmentError(`GM request failed: ${e?.error ?? e}`, { status: 0 })),
        ontimeout: () => reject(new SegmentError("GM request timed out", { status: 0 })),
        onprogress: (ev) => {
          const loaded = Number(ev?.loaded ?? 0);
          const total = Number(ev?.total ?? 0);
          onProgress?.({ loaded, total });
          const first = lastProgressBytes === 0 && loaded > 0;
          if (!first && loaded - lastProgressBytes < PROGRESS_LOG_STEP) {
            return;
          }
          lastProgressBytes = loaded;
          const mb = Math.round(loaded / (1024 * 1024));
          const size = total > 0 ? ` of ${Math.round(total / (1024 * 1024))}MiB` : "";
          logger.log("proxy", "provider", "GM progress", uri, `${mb}MiB${size}`);
        },
        onload: (res) => {
          if (settled) return;
          settle();
          const body = toUint8(res.response ?? res.responseArrayBuffer);
          logger.log("proxy", "provider", "GM response", uri, { status: res.status ?? 0, bytes: body.byteLength });
          resolve({
            status: res.status ?? 0,
            headers: new HeadersLike(res.responseHeaders).toObject(),
            body
          });
        }
      };
      const settle = () => { settled = true; };
      let req;
      try {
        const options = {
          method: "GET",
          url: uri,
          headers,
          responseType: "arraybuffer",
          ...callbacks
        };
        if (timeoutMs > 0) {
          // Never send `timeout: 0`: Tampermonkey (Firefox) interprets an
          // explicit 0 as "fire ontimeout immediately", which killed the GM
          // GET before a single byte arrived and forced the CORS-blocked
          // native-fetch fallback. Omitted entirely means "no timeout".
          options.timeout = timeoutMs;
        }
        req = this.#gmFetch(options, callbacks);
      } catch (err) {
        settle();
        reject(new SegmentError(`GM request setup failed: ${err?.message ?? err}`, { status: 0 }));
        return;
      }
      if (signal) {
        const onAbort = () => {
          if (settled) return;
          settled = true;
          if (req?.abort) req.abort();
          this.#gmAbort?.(req, callbacks);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  async #fetchRequest(uri, headers, signal, timeoutMs = 0, onProgress = null, stream = false) {
    // Honor a caller timeout on the fallback wire too: AbortSignal.timeout
    // aborts the network read, and the loop's own aborted check keeps mocks
    // that ignore the signal from hanging past the deadline.
    const extra = timeoutMs > 0 ? [AbortSignal.timeout(timeoutMs)] : [];
    const signals = extra.concat(signal ? [signal] : []);
    const wireSignal = signals.length > 0 ? AbortSignal.any(signals) : null;
    const res = await this.#nativeFetch(uri, {
      method: "GET",
      headers,
      signal: wireSignal ?? undefined
    });
    const total = Number(res.headers?.get?.("content-length") ?? 0) || 0;
    // A real page-facing stream rides straight through the native response
    // body - the proxy never buffers it, playback starts on the first chunk
    // and seeking stays native. Progress cannot be measured without draining
    // (no caller railway), which is exactly why the element whole-file route
    // opts out of streaming.
    if (stream && typeof res?.body?.getReader === "function") {
      logger.log("proxy", "provider", "native fetch stream passthrough", uri, { status: res.status });
      return { status: res.status, headers: headerObject(res.headers), body: res.body, streamed: true };
    }
    if (typeof res?.body?.getReader !== "function") {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress?.({ loaded: buf.byteLength, total });
      logger.log("proxy", "provider", "native fetch response", uri, { status: res.status, bytes: buf.byteLength });
      return { status: res.status, headers: headerObject(res.headers), body: buf };
    }
    // Stream the body chunk-wise so progress reaches the caller's abort
    // railway (the oversized-element ceiling) before the whole file is buffered.
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      if (wireSignal?.aborted) {
        try {
          await reader.cancel();
        } catch {}
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      loaded += value?.byteLength ?? 0;
      chunks.push(value);
      onProgress?.({ loaded, total });
    }
    let merged;
    if (chunks.length === 1) {
      // Single-read bodies (the common small-segment case) pass through
      // without a copy.
      merged = chunks[0];
    } else {
      const first = chunks[0];
      const firstLen = first.byteLength;
      // ReadableStream chunks never share an underlying buffer, so an
      // exclusively-owned, byte-aligned first chunk can be grown in place via
      // ArrayBuffer.transfer (zero-copy resize); otherwise concat fresh. The
      // length is captured before transfer, which detaches the source view.
      const realloc =
        first.byteOffset === 0 &&
        firstLen === first.buffer.byteLength &&
        chunks.slice(1).every((chunk) => chunk.buffer !== first.buffer);
      merged = realloc ? new Uint8Array(first.buffer.transfer(loaded)) : new Uint8Array(loaded);
      let offset = realloc ? firstLen : 0;
      for (let i = realloc ? 1 : 0; i < chunks.length; i++) {
        merged.set(chunks[i], offset);
        offset += chunks[i].byteLength;
      }
    }
    logger.log("proxy", "provider", "native fetch response", uri, { status: res.status, bytes: merged.byteLength });
    return { status: res.status, headers: headerObject(res.headers), body: merged };
  }
}

/** Minimal response-header parser for the header-block string GM returns. */
class HeadersLike {
  #map = new Map();
  constructor(headerBlock = "") {
    for (const line of String(headerBlock).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (!name) continue;
      this.#map.set(name, this.#map.has(name) ? `${this.#map.get(name)}, ${value}` : value);
    }
  }
  toObject() {
    return Object.fromEntries(this.#map);
  }
}

function headerObject(headers) {
  const obj = {};
  if (headers?.forEach) headers.forEach((v, k) => { obj[k] = v; });
  return obj;
}

/** `{start, end}` or `"start-end"` → HTTP `Range` header value, null when no
 *  exact bytes are understood. */
function rangeHeaderValue(range) {
  if (range == null) {
    return null;
  }
  if (typeof range === "string") {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(range);
    return m ? `bytes=${m[1]}-${m[2]}` : null;
  }
  if (typeof range === "object" && Number.isInteger(range.start) && Number.isInteger(range.end)) {
    return `bytes=${range.start}-${range.end}`;
  }
  return null;
}

function toUint8(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return new Uint8Array(0);
}


export const TOKEN_STATE = Object.freeze({
  IDLE: "idle",
  ARMED: "armed",
  REFRESHING: "refreshing",
  FAILED: "failed"
});

const DEFAULT_QUERY_SCHEME = Object.freeze({ token: "md5", expires: "expires" });

/**
 * options:
 *   getToken(signal) -> Promise<{
 *     token, expires,            // required (expires: epoch seconds)
 *     token_ip?, client_ip?,     // IP-bound token: prefer token_ip when both
 *     url?, url_ip?, cookie?,    // cookie/header creds to attach on requests
 *   }> | null
 *   clock() -> ms          deterministic test injection; default Date.now
 *   scheduler(fn, ms)      deterministic test injection; default setTimeout
 *   queryScheme {token, expires}  query-form param names (default md5/expires)
 *   minLeadMs, retryBaseMs, maxRetryMs, maxAttempts   backoff/lead tuning
 */
export class TokenManager {
  #getToken;
  #clock;
  #scheduler;
  #queryScheme;
  #minLeadMs;
  #retryBaseMs;
  #maxRetryMs;
  #maxAttempts;

  #ac = new AbortController();
  #state = TOKEN_STATE.IDLE;
  #token = null;
  #timer = null;
  #scheduled = new Set();
  #attempts = 0;
  #refreshing = null;
  #listeners = new Set();

  constructor(options = {}) {
    const opts = options || {};
    this.#getToken = typeof opts.getToken === "function" ? opts.getToken : null;
    this.#clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
    this.#scheduler = typeof opts.scheduler === "function" ? opts.scheduler : (fn, ms) => setTimeout(fn, ms);
    this.#queryScheme = { ...DEFAULT_QUERY_SCHEME, ...(opts.queryScheme ?? {}) };
    this.#minLeadMs = Math.max(0, opts.minLeadMs ?? 2000);
    this.#retryBaseMs = Math.max(1, opts.retryBaseMs ?? 1000);
    this.#maxRetryMs = Math.max(1, opts.maxRetryMs ?? 60000);
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  }

  /** Subscribe to flow events; returns an unsubscribe function. Event shapes:
   *  {type:"state", from, to}, {type:"refresh", ok, reason?, reactive?}. */
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(event) {
    for (const cb of this.#listeners) {
      cb(event);
    }
  }

  #setState(to) {
    if (this.#state === to) {
      return;
    }
    const from = this.#state;
    this.#state = to;
    logger.log("proxy", "token", "state", from, "->", to);
    this.#emit({ type: "state", from, to });
  }

  #setToken(token) {
    this.#token = token;
  }

  get state() {
    return this.#state;
  }

  get token() {
    return this.#token;
  }

  get armed() {
    return this.#state === TOKEN_STATE.ARMED;
  }

  get aborted() {
    return this.#ac.signal.aborted;
  }

  /** Rewrite a URL with the live credential - path `{token}/{expires}`
   *  placeholders win when present, else the query form (`md5`/`expires`).
   *  Byte-stable when no token is current or nothing changes; a stale token
   *  can never escape because only the ARMED state rewrites. */
  rewriteUrl(uri) {
    if (this.#state !== TOKEN_STATE.ARMED || !this.#token) {
      return uri;
    }
    const t = this.#token;
    const expiresText = t.expiresRaw != null ? String(t.expiresRaw) : "";
    const pathFilled = injectPathTokens(uri, { token: t.value, expires: expiresText });
    if (pathFilled !== uri) {
      return pathFilled;
    }
    return injectQueryParams(uri, {
      [this.#queryScheme.token]: t.value,
      [this.#queryScheme.expires]: expiresText
    });
  }

  /** Obtain or re-obtain the first credential and arm. No provider configured
   *  leaves the manager IDLE (passive - reactive-only is handled elsewhere). */
  async arm() {
    if (!this.#getToken || this.aborted) {
      const reason = this.#getToken ? "aborted" : "no-provider";
      logger.log("proxy", "token", "arm declined", reason);
      return { refreshed: false, reason };
    }
    if (this.#refreshing) {
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    return this.refresh({ reactive: false });
  }

  /**
   * Force a refresh. Returns {refreshed, token, reason?}. Concurrent callers
   * share the single in-flight request. `reactive:true` distinguishes a
   * mid-playback 403 recovery (unit-test assertions on refresh events).
   */
  async refresh({ reactive = false } = {}) {
    if (!this.#getToken) {
      this.#setState(TOKEN_STATE.FAILED);
      logger.warn("proxy", "token", "refresh skipped: no provider");
      return { refreshed: false, reason: "no-provider" };
    }
    if (this.#refreshing) {
      logger.log("proxy", "token", "refresh coalesced onto in-flight", reactive);
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    this.#setState(TOKEN_STATE.REFRESHING);
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    this.#refreshing = { promise, resolve };
    try {
      return await this.#doRefresh(resolve, reactive);
    } finally {
      this.#refreshing = null;
    }
  }

  /**
   * Reactive credential expiry signal: a routed request came back 403/410.
   * Refreshes once (or waits on any in-flight refresh) and reports whether the
   * caller's single retry has a fresh credential. Any other status is not our
   * signal: {refreshed:false, reason:"not-token-error"}.
   */
  async handleStatus(status) {
    if (status !== 403 && status !== 410) {
      return { refreshed: false, reason: "not-token-error" };
    }
    logger.log("proxy", "token", "reactive expiry signal", status);
    if (this.#refreshing) {
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    if (this.aborted) {
      return { refreshed: false, reason: "aborted" };
    }
    return this.refresh({ reactive: true });
  }

  async #doRefresh(resolve, reactive) {
    let outcome;
    try {
      outcome = await this.#getToken(this.#ac.signal);
    } catch {
      if (this.aborted) {
        this.#setToken(null);
        this.#setState(TOKEN_STATE.IDLE);
        resolve({ refreshed: false, reason: "aborted", token: null });
        this.#emit({ type: "refresh", ok: false, reason: "aborted", reactive });
        return { refreshed: false, reason: "aborted", token: null };
      }
      this.#fail(reactive);
      this.#emit({ type: "refresh", ok: false, reason: "provider-error", reactive });
      const result = { refreshed: false, token: null, reason: "provider-error" };
      resolve(result);
      return result;
    }
    if (this.aborted || outcome == null) {
      if (this.aborted) {
        this.#setToken(null);
        this.#setState(TOKEN_STATE.IDLE);
      } else {
        this.#fail(reactive);
      }
      const result = outcome == null && !this.aborted
        ? { refreshed: false, token: null, reason: "empty-token" }
        : { refreshed: false, token: null, reason: "aborted" };
      resolve(result);
      this.#emit({ type: "refresh", ok: false, reason: result.reason, reactive });
      return result;
    }
    this.#attempts = 0;
    this.#token = this.#buildToken(outcome);
    this.#setState(TOKEN_STATE.ARMED);
    this.#scheduleProactive();
    const result = { refreshed: true, token: this.#token };
    logger.log("proxy", "token", "armed", { reactive, ttl: this.#token.ttl });
    resolve(result);
    this.#emit({ type: "refresh", ok: true, reactive });
    return result;
  }

  #fail(reactive) {
    this.#attempts++;
    this.#setToken(null);
    this.#setState(TOKEN_STATE.FAILED);
    if (this.#attempts < this.#maxAttempts) {
      const delay = Math.min(this.#retryBaseMs * (1 << (this.#attempts - 1)), this.#maxRetryMs);
      this.#schedule(() => {
        if (!this.aborted && this.#state === TOKEN_STATE.FAILED) {
          this.refresh({ reactive });
        }
      }, delay);
    }
  }

  #buildToken(outcome) {
    const now = this.#clock();
    const expiresRaw = Number(outcome.expires);
    const expiresAt = Number.isFinite(expiresRaw) ? expiresRaw * 1000 : now;
    return {
      value: outcome.token_ip || outcome.token,
      ip: outcome.token_ip ?? null,
      clientIp: outcome.client_ip ?? null,
      cookie: outcome.cookie ?? null,
      header: outcome.header ?? null,
      url: outcome.url ?? null,
      urlIp: outcome.url_ip ?? null,
      expiresRaw,
      expiresAt,
      issuedAt: now,
      ttl: Math.max(0, expiresAt - now)
    };
  }

  /** Proactive refresh at `expiresAt - max(minLeadMs, ttl/2)` (§12.1). The
   *  timer, not the decision, tracks wall time. */
  #scheduleProactive() {
    if (this.#timer != null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const now = this.#clock();
    const t = this.#token;
    const lead = Math.max(this.#minLeadMs, Math.floor(t.ttl / 2));
    const delay = Math.max(1, t.expiresAt - now - lead);
    this.#timer = this.#scheduler(() => {
      this.#timer = null;
      if (!this.aborted) {
        this.refresh({ reactive: false });
      }
    }, delay);
  }

  #schedule(fn, ms) {
    const handle = this.#scheduler(fn, ms);
    if (handle != null && typeof handle !== "undefined") {
      this.#scheduled.add(handle);
    }
  }

  #clearTimer(handle) {
    try {
      clearTimeout(handle);
    } catch {}
  }

  /** Teardown (player change / page unload): clear timers, drop the credential,
   *  and abort any in-flight provider request via the manager's signal. */
  destroy() {
    if (!this.aborted) {
      this.#ac.abort();
    }
    if (this.#timer != null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    for (const handle of this.#scheduled) {
      this.#clearTimer(handle);
    }
    this.#scheduled.clear();
    this.#token = null;
    this.#setState(TOKEN_STATE.IDLE);
  }
}