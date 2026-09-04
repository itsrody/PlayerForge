/**
 * Transport provider for the routed segment pipe (§7.1).
 *
 * The ProxyProvider fetches one whole segment per request, segment-granular,
 * never true streaming — GM_xmlhttpRequest is serialized and reports a single
 * progress event (§13). It tries transport strategies in priority order:
 *
 *   1. GM_xmlhttpRequest (binary, headers honored) — bypasses CORS/CSP.
 *   2. Native fetch + arrayBuffer — same-origin or permissive-CORS fallback.
 *
 * Every fetch honors an AbortSignal and resolves to an opaque binary payload
 * { status, headers, body }. The caller (SegmentManager) owns decode,
 * decrypt, ordering, and backpressure; this module owns only the wire.
 */
import { logger } from "../../shared/logger.js";
import { SegmentError } from "./segment-manager.js";

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
   *  provider chosen and the response. */
  async fetch(uri, { signal, headers = {}, timeoutMs = 0, byteRange = null } = {}) {
    logger.log("proxy", "provider", "fetch", uri, { timeoutMs, byteRange });
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
          resp: await this.#gmRequest(uri, requestHeaders, signal, timeoutMs)
        };
      } catch (err) {
        // An aborted GM attempt must not spawn a fallback fetch; any other
        // wire failure (setup, network, timeout) is a fallback candidate.
        if (err?.name === "AbortError") throw err;
        logger.warn("proxy", "provider", "GM request failed, falling back to fetch", uri, err?.message ?? err);
      }
    }
    return { via: "fetch", resp: await this.#fetchRequest(uri, requestHeaders, signal) };
  }

  #gmRequest(uri, headers, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const callbacks = {
        onabort: () => reject(new DOMException("Aborted", "AbortError")),
        onerror: (e) => reject(new SegmentError(`GM request failed: ${e?.error ?? e}`, { status: 0 })),
        ontimeout: () => reject(new SegmentError("GM request timed out", { status: 0 })),
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
        req = this.#gmFetch(
          {
            method: "GET",
            url: uri,
            headers,
            responseType: "arraybuffer",
            timeout: timeoutMs,
            ...callbacks
          },
          callbacks
        );
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

  async #fetchRequest(uri, headers, signal) {
    const res = await this.#nativeFetch(uri, {
      method: "GET",
      headers,
      signal
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    logger.log("proxy", "provider", "native fetch response", uri, { status: res.status, bytes: buf.byteLength });
    return { status: res.status, headers: headerObject(res.headers), body: buf };
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