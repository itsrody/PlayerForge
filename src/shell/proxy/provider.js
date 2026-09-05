/**
 * Transport provider for the routed segment pipe (§7.1).
 *
 * The ProxyProvider fetches one whole segment per request, segment-granular,
 * never true streaming — GM_xmlhttpRequest is serialized and reports a single
 * progress event (§13). It tries transport strategies in priority order:
 *
 *   1. GM_xmlhttpRequest (binary, headers honored) — bypasses CORS/CSP.
 *   2. Native fetch + streamed whole-body read (progress + timeout honored) —
 *      same-origin or permissive-CORS fallback.
 *
 * Every fetch honors an AbortSignal and resolves to an opaque binary payload
 * { status, headers, body }. The caller (SegmentManager) owns decode,
 * decrypt, ordering, and backpressure; this module owns only the wire.
 */
import { logger } from "../../shared/logger.js";
import { SegmentError } from "./segment-manager.js";

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