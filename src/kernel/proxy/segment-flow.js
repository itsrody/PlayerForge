/**
 * segment-flow.js — the fragment-plan parser + flow state machine
 * (consolidated from `segment-manager.js` + `manifest-segments.js`).
 *
 * `SegmentManager` owns the lifecycle of every media segment between manifest
 * rewrite and SourceBuffer: fetch (via the caller's transport seam, later
 * `ProxyProvider`), optional decrypt (the seam for AES-128 / ClearKey), and
 * strictly in-order delivery to the append gate. It is intentionally pure
 * orchestration - no browser API is touched here - so the transitions, reorder
 * buffer, retry bounds, token refresh (403/410 is the NORMAL credential-expiry
 * signal, routed to the refresh seam, never counted as a media failure), and
 * abort semantics run headless with injected seams.
 *
 * `parseManifest`/`parseHls`/`parseDash` turn a rewritable `.m3u8` / `.mpd`
 * into fragment plans, including the pieces fragmented-MP4 streams actually
 * need that URL-only rewriting can't see: the init segment, byte ranges, media
 * sequence/start numbers, and the encryption key active at each fragment.
 * Kind detection is resolved from the URL suffix via manifest-pipe's
 * `detectManifestKind`, then sniffed from the text via `sniffManifestKind`.
 *
 * Hard guarantees enforced here, mirroring the repo's rules:
 * - segments are delivered to append() in ascending sequence order, never
 *   out of order (except an opt-in gap slide after a bounded wait);
 * - one fetch in flight per concurrency slot, a byte cap on pending fetches,
 *   and a cap on active (reorder-buffered) segments - bounded memory;
 * - retries are bounded and token-path retries are bounded independently;
 * - a 403/410 is the NORMAL "credential expired" signal, routed to the token
 *   refresh seam, never counted as a media failure;
 * - abort (pause/seek/teardown) cancels every in-flight fetch and halts.
 */
import { logger } from "../../shared/logger.js";
import { MANIFEST_KIND, detectManifestKind, sniffManifestKind } from "./manifest-pipe.js";

export const STATUS = Object.freeze({
  IDLE: "IDLE",
  FETCHING: "FETCHING",
  DECRYPTING: "DECRYPTING",
  BUFFERING: "BUFFERING",
  DONE: "DONE",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED"
});

/** Statuses that keep a segment "owed" (uncapped by memory) and block drain. */
const ACTIVE = new Set([STATUS.IDLE, STATUS.FETCHING, STATUS.DECRYPTING, STATUS.BUFFERING]);

/** Transport/decrypt failures carry a numbered HTTP status when known; 403/410
 *  are the token-expiry signal. `status` defaults to 0 (non-HTTP fault).
 *  `retryable` defaults to true; false means "will not heal by retry" (a
 *  corrupted blob, bad key/IV - a bounded retry loop would only burn calls), so
 *  the manager skips immediately. */
export class SegmentError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.name = "SegmentError";
    this.status = status;
    this.retryable = retryable === false ? false : true;
  }
}

/**
 * options:
 *   fetch(segment, signal) -> Promise<Uint8Array|ArrayBuffer>  required
 *   append(segment, bytes)  -> Promise<void>                    required (in-order)
 *   decrypt(segment, bytes) -> Promise<bytes>|null              for encrypted segments
 *   refresh(segment)        -> Promise<{uri?,byteRange?,auth?}|null>  token refresh seam
 *   signal                 external AbortSignal (stream scoped)
 *   scheduler(fn, ms)      deterministic test injection; default setTimeout
 *   clock() -> ms          deterministic test injection; default Date.now
 *   concurrency, maxQueued, maxPendingBytes, retryBaseMs, maxRetryMs,
 *   maxRetries, maxRefreshes, allowGaps, gapTimeoutMs
 *   lookaheadMs         media-milliseconds to keep prefetched (0 = off)
 *   throughput          NetworkThroughput seam sampled per fetch
 */
export class SegmentManager {
  #fetch;
  #append;
  #decrypt;
  #refresh;
  #scheduler;
  #clock;

  #concurrency;
  #maxQueued;
  #maxPendingBytes;
  #retryBaseMs;
  #maxRetryMs;
  #maxRetries;
  #maxRefreshes;
  #allowGaps;
  #gapTimeoutMs;
  #lookaheadMs;
  #throughput;

  #aheadMs = 0;

  #internalAc = new AbortController();
  #ownsAc = new AbortController();
  #fetchSignal;
  #aborted = false;

  #pending = new Map();
  #deliverSeq = 0;
  #inFlight = 0;
  #active = 0;
  #pendingBytes = 0;
  #delivering = false;
  #gapSince = null;
  #gapScheduled = false;
  #scheduled = new Set();
  #listeners = new Set();
  #drainPromise = null;
  #drainResolve = null;

  constructor(options) {
    const opts = options || {};
    if (typeof opts.fetch !== "function" || typeof opts.append !== "function") {
      throw new TypeError("SegmentManager requires fetch() and append() seams");
    }
    this.#fetch = opts.fetch;
    this.#append = opts.append;
    this.#decrypt = typeof opts.decrypt === "function" ? opts.decrypt : null;
    this.#refresh = typeof opts.refresh === "function" ? opts.refresh : null;
    this.#scheduler = typeof opts.scheduler === "function" ? opts.scheduler : (fn, ms) => setTimeout(fn, ms);
    this.#clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();

    this.#concurrency = Math.max(1, opts.concurrency ?? 1);
    this.#maxQueued = Math.max(0, opts.maxQueued ?? 128);
    this.#maxPendingBytes = Math.max(0, opts.maxPendingBytes ?? 0);
    this.#retryBaseMs = Math.max(1, opts.retryBaseMs ?? 150);
    this.#maxRetryMs = Math.max(1, opts.maxRetryMs ?? 5000);
    this.#maxRetries = Math.max(1, opts.maxRetries ?? 3);
    this.#maxRefreshes = Math.max(0, opts.maxRefreshes ?? 1);
    this.#allowGaps = opts.allowGaps === true;
    this.#gapTimeoutMs = Math.max(0, opts.gapTimeoutMs ?? 2000);
    this.#lookaheadMs = Math.max(0, opts.lookaheadMs ?? 0);
    this.#throughput = opts.throughput ?? null;
    if (Number.isInteger(opts.startSeq) && opts.startSeq > 0) {
      this.#deliverSeq = opts.startSeq;
    }

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => this.abort(), { signal: this.#ownsAc.signal });
    }
    this.#fetchSignal = opts.signal
      ? AbortSignal.any([this.#internalAc.signal, opts.signal])
      : this.#internalAc.signal;
  }

  /** Subscribe to flow events; returns an unsubscribe function. Event shapes:
   *  {type:"status", id, from, to} transition, {type:"refresh", id} token
   *  refresh issued, {type:"append", id} bytes delivered to the sink,
   *  {type:"skip", id, reason} a gap or hard failure skipped over. */
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(event) {
    for (const cb of this.#listeners) {
      cb(event);
    }
  }

  #setStatus(seg, to) {
    const from = seg.status;
    if (from === to) {
      return;
    }
    seg.status = to;
    // A segment leaves the "owed" set exactly once - on its first final
    // status - so the active count (reorder-buffer cap + drain) and the
    // look-ahead credit (bufferedAheadMs) stay exact no matter how late
    // delivery runs relative to the fetch step.
    if (ACTIVE.has(from) && !ACTIVE.has(to)) {
      this.#active = Math.max(0, this.#active - 1);
      if (seg.durationMs > 0) {
        this.#aheadMs = Math.max(0, this.#aheadMs - seg.durationMs);
      }
    }
    this.#emit({ type: "status", id: seg.id, from, to });
  }

  /**
   * Register a segment for the stream. `info` = {id, uri, byteRange?,
   * encrypted?, key?, auth?, byteHint?, durationMs?}. `durationMs` (media
   * milliseconds) feeds the look-ahead watermark; `byteHint` the byte budget.
   * Idempotent per id (duplicates and already-finalized ids are ignored);
   * returns false once the stream aborts.
   */
  enqueue(info) {
    if (this.#aborted) {
      return false;
    }
    const id = info?.id;
    if (!Number.isInteger(id) || id < 0 || typeof info.uri !== "string") {
      throw new TypeError("SegmentManager.enqueue requires {id: integer, uri: string}");
    }
    if (this.#pending.has(id)) {
      return true;
    }
    const seg = {
      id,
      uri: info.uri,
      byteRange: info.byteRange ?? null,
      encrypted: info.encrypted === true,
      key: info.key ?? null,
      auth: info.auth ?? null,
      byteHint: Math.max(0, info.byteHint ?? 0),
      durationMs: Math.max(0, Number(info.durationMs) || 0),
      attempts: 0,
      refreshes: 0,
      bytes: null,
      retryAt: null,
      startedAt: null,
      status: STATUS.IDLE
    };
    this.#pending.set(id, seg);
    this.#active++;
    this.#emit({ type: "status", id, from: null, to: STATUS.IDLE });
    logger.log("proxy", "segment", "enqueue", { id, uri: seg.uri, encrypted: seg.encrypted, byteHint: seg.byteHint, durationMs: seg.durationMs });
    this.#pump();
    return true;
  }

  /** Status of a segment id ("null" once pruned or never enqueued). */
  statusOf(id) {
    return this.#pending.get(id)?.status ?? null;
  }

  /** Drop finalized bookkeeping at or below `id` (the MSE "drop the TimeRanges
   *  slot" cadence, §7.2). Active segments are never pruned. */
  pruneThrough(id) {
    if (!Number.isInteger(id)) {
      return;
    }
    let pruned = 0;
    for (const [seq, seg] of this.#pending) {
      if (seq <= id && !ACTIVE.has(seg.status)) {
        this.#pending.delete(seq);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.log("proxy", "segment", "pruned through", id, `${pruned} segments`);
    }
  }

  /** Abort the stream: cancels in-flight fetches, halts delivery, abandons
   *  every still-owed segment (SKIPPED), and resolves the drain. Idempotent. */
  abort() {
    if (this.#aborted) {
      return;
    }
    this.#aborted = true;
    logger.log("proxy", "segment", "abort", { inFlight: this.#inFlight, pending: this.#pending.size });
    this.#internalAc.abort();
    this.#clearSchedules();
    for (const seg of this.#pending.values()) {
      if (ACTIVE.has(seg.status)) {
        this.#setStatus(seg, STATUS.SKIPPED);
      }
    }
    this.#emit({ type: "abort" });
    this.#maybeDrained();
  }

  /** Abort + release the external signal listener (stream teardown). */
  destroy() {
    this.abort();
    this.#ownsAc.abort();
  }

  get aborted() {
    return this.#aborted;
  }

  get inFlight() {
    return this.#inFlight;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  get pendingBytes() {
    return this.#pendingBytes;
  }

  /** Media-milliseconds of started (fetched/fetching/buffering) segments - the
   *  look-ahead watermark's live reading. Zero with the window off. */
  get bufferedAheadMs() {
    return this.#aheadMs;
  }

  /** The sampled network estimate (bps) from the throughput seam. */
  throughputBps() {
    return this.#throughput?.estimateBps() ?? 0;
  }

  /** Resolves once the stream drains: no in-flight fetches and no active
   *  (queued/buffering) segments. Retry backoff keeps it pending, by design. */
  waitDrain() {
    if (!this.#drainPromise) {
      this.#drainPromise = new Promise((resolve) => {
        this.#drainResolve = resolve;
      });
    }
    return this.#drainPromise;
  }

  #maybeDrained() {
    if (this.#drainPromise && this.#inFlight === 0 && this.#active === 0) {
      const resolve = this.#drainResolve;
      this.#drainPromise = null;
      this.#drainResolve = null;
      resolve();
    }
  }

  #schedule(fn, ms) {
    const handle = this.#scheduler(fn, ms);
    if (handle != null && typeof handle !== "undefined") {
      this.#scheduled.add(handle);
    }
  }

  #clearSchedules() {
    for (const handle of this.#scheduled) {
      try {
        clearTimeout(handle);
      } catch {}
    }
    this.#scheduled.clear();
  }

  /** Lowest-id IDLE segment is the next fetch candidate (fills reorder gaps
   *  first). Segments in retry/refresh cooling (retryAt in the future) are
   *  skipped so a pump from a failed fetch's down-path cannot bypass backoff.
   *  Returns null when nothing is eligible. */
  #nextEligible() {
    const now = this.#clock();
    let best = null;
    for (const seg of this.#pending.values()) {
      if (seg.status !== STATUS.IDLE) {
        continue;
      }
      if (seg.retryAt != null && now < seg.retryAt) {
        continue;
      }
      if (!best || seg.id < best.id) {
        best = seg;
      }
    }
    return best;
  }

  #canStartFetch(seg) {
    if (this.#inFlight >= this.#concurrency) {
      return false;
    }
    if (this.#lookaheadMs > 0 && seg.durationMs > 0 && this.#aheadMs + seg.durationMs > this.#lookaheadMs) {
      // The look-ahead watermark: never pull more media ahead than the
      // window. Once buffered media crosses the ceiling the pipeline holds
      // idle slots until delivery repays the credit - the bandwidth-
      // acceleration bound that keeps an ample pipe racing ahead to a bounded
      // horizon instead of unbounded.
      logger.log("proxy", "segment", "look-ahead full", seg.id, "bufferedMs", this.#aheadMs, "windowMs", this.#lookaheadMs);
      return false;
    }
    if (this.#maxPendingBytes > 0 && this.#pendingBytes >= this.#maxPendingBytes) {
      return false;
    }
    if (this.#maxQueued > 0) {
      // The reorder-buffer cap limits segments that have actually STARTED
      // (fetching/decrypting/buffering); unstarted IDLE segments hold no
      // bytes and must not consume the cap. Starting them from #pump is the
      // only way into the pipeline, so this scan keeps the cap exact.
      let started = 0;
      for (const seg of this.#pending.values()) {
        if (
          seg.status === STATUS.FETCHING ||
          seg.status === STATUS.DECRYPTING ||
          seg.status === STATUS.BUFFERING
        ) {
          started++;
          if (started >= this.#maxQueued) {
            return false;
          }
        }
      }
    }
    return true;
  }

  #pump() {
    while (!this.#aborted) {
      const seg = this.#nextEligible();
      if (!seg) {
        break;
      }
      if (!this.#canStartFetch(seg)) {
        break;
      }
      this.#startFetch(seg);
    }
    this.#tryDeliver();
    this.#maybeDrained();
  }

  #startFetch(seg) {
    this.#inFlight++;
    this.#pendingBytes += seg.byteHint;
    if (seg.durationMs > 0) {
      this.#aheadMs += seg.durationMs;
    }
    seg.retryAt = null;
    seg.startedAt = this.#clock();
    this.#setStatus(seg, STATUS.FETCHING);
    logger.log("proxy", "segment", "fetching", seg.id, seg.uri);
    this.#run(seg).catch(() => {}).finally(() => {
      this.#inFlight--;
      this.#pendingBytes = Math.max(0, this.#pendingBytes - seg.byteHint);
      this.#pump();
    });
  }

  async #run(seg) {
    try {
      let bytes = await this.#fetch(seg, this.#fetchSignal);
      if (this.#throughput) {
        const elapsed = this.#clock() - (seg.startedAt ?? this.#clock());
        const size = bytes?.byteLength ?? bytes?.length ?? 0;
        this.#throughput.sample(size, elapsed);
      }
      if (seg.encrypted) {
        if (typeof this.#decrypt !== "function") {
          throw new SegmentError("no decrypt seam for encrypted segment", { retryable: false });
        }
        this.#setStatus(seg, STATUS.DECRYPTING);
        logger.log("proxy", "segment", "decrypting", seg.id);
        bytes = await this.#decrypt(seg, bytes);
      }
      seg.bytes = bytes;
      this.#setStatus(seg, STATUS.BUFFERING);
      logger.log("proxy", "segment", "buffered", seg.id, bytes?.byteLength ?? bytes?.length ?? 0, "bytes");
    } catch (err) {
      await this.#recover(seg, err);
      return;
    }
    this.#tryDeliver();
  }

  async #recover(seg, err) {
    if (this.#aborted) {
      this.#setStatus(seg, STATUS.SKIPPED);
      return;
    }
    const status = err && typeof err.status === "number" ? err.status : 0;
    const tokenSignal = status === 403 || status === 410;
    const retryable = !err || err.retryable !== false;
    if (tokenSignal && this.#refresh && seg.refreshes < this.#maxRefreshes) {
      // Credential expired mid-stream is the NORMAL signal, not a media
      // failure: refresh once (bounded by maxRefreshes) with the token seam,
      // then re-arm as IDLE with whatever fresh uri/auth it produced. The
      // attempts counter is intentionally untouched by this path.
      seg.refreshes++;
      seg.retryAt = null;
      this.#emit({ type: "refresh", id: seg.id });
      logger.log("proxy", "segment", "token refresh", seg.id, status);
      let outcome = null;
      try {
        outcome = await this.#refresh(seg);
      } catch {}
      if (outcome && typeof outcome === "object") {
        if (typeof outcome.uri === "string") {
          seg.uri = outcome.uri;
        }
        if (outcome.byteRange) {
          seg.byteRange = outcome.byteRange;
        }
        if (outcome.auth) {
          seg.auth = outcome.auth;
        }
      }
      this.#setStatus(seg, STATUS.IDLE);
      this.#pump();
      return;
    }
    if (retryable) {
      seg.attempts++;
      if (seg.attempts < this.#maxRetries) {
        const delay = Math.min(this.#retryBaseMs * (1 << (seg.attempts - 1)), this.#maxRetryMs);
        seg.retryAt = this.#clock() + delay;
        this.#setStatus(seg, STATUS.IDLE);
        logger.log("proxy", "segment", "retry scheduled", seg.id, `attempt ${seg.attempts}`, `${delay}ms`);
        this.#schedule(() => {
          if (!this.#aborted) {
            seg.retryAt = null;
            this.#pump();
          }
        }, delay);
        return;
      }
    }
    this.#setStatus(seg, STATUS.FAILED);
    this.#setStatus(seg, STATUS.SKIPPED);
    this.#emit({ type: "skip", id: seg.id, reason: retryable ? "fail" : "decode", attempts: seg.attempts });
    logger.warn("proxy", "segment", "skip", seg.id, retryable ? "fail" : "decode", `attempts=${seg.attempts}`);
  }

  /** Deliver ready bytes in strict ascending order: one append in flight at a
   *  time, finalized entries walked, real holes either waited out (default) or
   *  skipped after the gap timeout (allowGaps). */
  #tryDeliver() {
    if (this.#aborted || this.#delivering) {
      return;
    }
    let id = this.#deliverSeq;
    for (;;) {
      const seg = this.#pending.get(id);
      if (!seg) {
        if (this.#allowGaps && this.#hasLater(id)) {
          const now = this.#clock();
          if (this.#gapSince == null) {
            this.#gapSince = now;
          }
          if (now - this.#gapSince >= this.#gapTimeoutMs) {
            this.#emit({ type: "skip", id, reason: "gap" });
            logger.log("proxy", "segment", "gap skip", id);
            this.#deliverSeq = ++id;
            this.#gapSince = null;
            this.#gapScheduled = false;
            continue;
          }
          this.#scheduleGapRecheck();
        }
        break;
      }
      if (seg.status === STATUS.BUFFERING) {
        this.#delivering = true;
        this.#deliver(seg);
        return;
      }
      if (ACTIVE.has(seg.status)) {
        if (this.#gapScheduled) {
          this.#gapScheduled = false;
        }
        break;
      }
      this.#deliverSeq = ++id;
    }
    this.#maybeDrained();
  }

  async #deliver(seg) {
    try {
      await this.#append(seg, seg.bytes);
      this.#setStatus(seg, STATUS.DONE);
      this.#emit({ type: "append", id: seg.id });
      logger.log("proxy", "segment", "appended", seg.id);
    } catch {
      if (this.#aborted) {
        this.#setStatus(seg, STATUS.SKIPPED);
      } else {
        this.#setStatus(seg, STATUS.FAILED);
        this.#setStatus(seg, STATUS.SKIPPED);
        this.#emit({ type: "skip", id: seg.id, reason: "append" });
        logger.warn("proxy", "segment", "append skipped", seg.id);
      }
    } finally {
      this.#delivering = false;
      this.#tryDeliver();
      // Delivery frees the look-ahead credit (bufferedAheadMs drops as a head
      // reaches DONE); only a pump can spend that freed credit, and the fetch
      // step's own finally already ran before the async append resolved.
      this.#pump();
    }
  }

  #hasLater(id) {
    for (const seq of this.#pending.keys()) {
      if (seq > id) {
        return true;
      }
    }
    return false;
  }

  #scheduleGapRecheck() {
    if (this.#gapScheduled || this.#aborted) {
      return;
    }
    const elapsed = Math.max(0, this.#clock() - (this.#gapSince ?? this.#clock()));
    const remaining = Math.max(0, this.#gapTimeoutMs - elapsed);
    this.#gapScheduled = true;
    this.#schedule(() => {
      if (this.#aborted) {
        return;
      }
      this.#gapScheduled = false;
      this.#tryDeliver();
    }, remaining);
  }
}/**
 * Manifest → fragment plan parser (§Phase 6 prep, MP4-fragment aware).
 *
 * Pure text-in / structure-out: no browser API, no logging, no side effects.
 * The SegmentManager lives off `enqueue({id, uri, byteRange, encrypted,
 * key})` calls, and this module is what turns a rewritable `.m3u8` / `.mpd`
 * into those plans — including the pieces fragmented-MP4 streams actually
 * need that URL-only rewriting can't see: the init segment (`#EXT-X-MAP` /
 * DASH `<Initialization>` / `initialization=`), byte ranges, media
 * sequence/start numbers, and the encryption key active at each fragment.
 *
 * Both formats resolve every URI against the manifest URL so the gate's
 * scope check and the provider's fetch see absolute targets.
 *
 * Output shape (shared by HLS + DASH):
 *   {
 *     kind,                 "m3u8" | "mpd"
 *     sequence,             HLS media sequence / DASH base start number
 *     lanes: [ {
 *       id, mimeType, codecs, maps/init, segments: [{
 *         id, uri, byteRange|null, duration, encrypted, key|null, map
 *       }]
 *     } ]
 *   }
 *
 * `byteRange` is normalized to `{start, end}` (byte offsets, inclusive) so
 * the provider can emit `Range: bytes=start-end`. HLS `n@o` / `n` forms and
 * DASH `<range>a-b</range>`-style strings all normalize to that.
 *
 * Unbounded DASH `SegmentTemplate`s (no timeline, no endNumber) emit the
 * template only — `resolveTemplate(template, n)` expands a numbered URI.
 */
/** Upper bound for expanding DASH timeline/template loops. */
const MAX_CONCRETE_SEGMENTS = 1024;

/**
 * Resolve a manifest-internal reference (possibly relative) against the
 * manifest URL. Non-URL refs and unresolvable bases fall back to the raw
 * reference so nothing crashes on bare-relative plans.
 */
function resolveManifestRef(baseUrl, uri) {
  const ref = String(uri ?? "").trim();
  if (!ref) {
    return ref;
  }
  if (ABSOLUTE_REF_RE.test(ref)) {
    return ref;
  }
  if (!baseUrl) {
    return ref;
  }
  return URL.canParse(ref, baseUrl) ? new URL(ref, baseUrl).href : ref;
}

/** True when a reference is a URL-ish thing we should resolve/route (skips
 *  bare numbers, `data:` payloads, and `#`-fragments). */

/**
 * Normalize a byte-range string to `{start, end}`.
 * - `"720-1439"`  → {start:720, end:1439}
 * - `"720@0"`     → {start:0, end:719} (length@offset, inclusive end)
 * - `"720"`       → length only; needs `startHint` (the running offset on the
 *   same resource) else null (unresolvable, fetch whole resource instead)
 */
const BYTE_RANGE_RE = /^(\d+)-(\d+)$/;
const BYTE_OFFSET_RE = /^(\d+)@(\d+)$/;
const BYTE_LENGTH_RE = /^(\d+)$/;

export function normalizeByteRange(value, { startHint = null } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  let m = BYTE_RANGE_RE.exec(text);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    return { start, end: Math.max(end, start) };
  }
  m = BYTE_OFFSET_RE.exec(text);
  if (m) {
    const length = parseInt(m[1], 10);
    const start = parseInt(m[2], 10);
    return { start, end: start + length - 1 };
  }
  m = BYTE_LENGTH_RE.exec(text);
  if (m) {
    const length = parseInt(m[1], 10);
    if (startHint == null) {
      return null;
    }
    return { start: startHint, end: startHint + length - 1 };
  }
  return null;
}

/** Comma-split HLS tag attributes (quotes honored), lowercase keys, values
 *  unquoted. Mirrors the splitter the gate uses for classification. */
function parseHlsAttrs(input) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (const ch of String(input ?? "")) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === "," && !inQuote) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  const out = new Map();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** Whitespace-separated XML tag attributes (double-quoted values). */
const XML_ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
const TAG_TAIL_SLASH_RE = /\/\s*$/;
const XML_WS_RE = /\s/;

/** Absolute-scheme media refs (or a `//` authority) need no base resolution.
 *  Hoisted - a regex literal in `resolveManifestRef` would re-allocate per
 *  segment/media reference the parser walks. */
const ABSOLUTE_REF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function parseXmlAttrs(input) {
  const out = new Map();
  let m;
  while ((m = XML_ATTR_RE.exec(String(input ?? "")))) {
    out.set(m[1] ?? m[3], m[2] ?? m[4]);
  }
  return out;
}

/** Parse an `#EXTINF:4.0,Title` line into duration seconds. */
function parseExtinf(line) {
  const value = line.slice("#EXTINF".length).replace(/^\s*:/, "").trim();
  const duration = parseFloat(value.split(/[,\s]/, 1)[0].trim());
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function parseHlsKey(line, baseUrl) {
  const attrs = parseHlsAttrs(line.slice("#EXT-X-KEY:".length));
  const method = (attrs.get("method") ?? "").toUpperCase();
  if (!method) {
    return null;
  }
  const uriAttr = attrs.get("uri");
  const key = {
    method,
    keyFormat: attrs.get("keyformat") ?? null,
    iv: attrs.get("iv") ?? null,
    uri: uriAttr ? resolveManifestRef(baseUrl, uriAttr) : null
  };
  return key;
}

/**
 * Parse an HLS playlist into a single muxed lane. Fragment-aware fields:
 * `#EXT-X-MAP` entries become lane `maps` (each mapped segment records which
 * one applies), `#EXT-X-BYTERANGE` becomes `{start,end}`, and the active
 * `#EXT-X-KEY` (including mid-list rotation) rides along on each segment.
 */
export function parseHls(text, { baseUrl = null } = {}) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const segments = [];
  const maps = [];
  const mapsByRef = new Map();
  let mediaSequence = 0;
  let duration = 0;
  let activeKey = null;
  let lastMap = null;
  let pendingRange = null;
  let lastResource = null;
  const resourceEnds = new Map(); // running offset for length-only BYTERANGE

  const registerMap = (map) => {
    const ref = map.uri + (map.byteRange ? `#${map.byteRange.start}-${map.byteRange.end}` : "#full");
    if (!mapsByRef.has(ref)) {
      mapsByRef.set(ref, maps.length);
      maps.push({ uri: map.uri, byteRange: map.byteRange });
    }
    return mapsByRef.get(ref);
  };

  for (const line of lines) {
    const tag = line.trim();
    if (!tag || tag.startsWith("#EXTM3U") || tag.startsWith("#EXT-X-VERSION")) {
      continue;
    }
    if (tag.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const n = parseInt(tag.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim(), 10);
      mediaSequence = Number.isFinite(n) ? n : 0;
      continue;
    }
    if (tag.startsWith("#EXT-X-KEY:")) {
      activeKey = parseHlsKey(tag, baseUrl);
      continue;
    }
    if (tag.startsWith("#EXT-X-MAP:")) {
      const attrs = parseHlsAttrs(tag.slice("#EXT-X-MAP:".length));
      const uri = attrs.get("uri");
      if (uri) {
        const startHint = resourceEnds.get(uri) ?? null;
        const map = {
          uri: resolveManifestRef(baseUrl, uri),
          byteRange: normalizeByteRange(attrs.get("byterange") ?? null, { startHint })
        };
        lastMap = registerMap(map);
        if (map.byteRange) {
          resourceEnds.set(uri, map.byteRange.end + 1);
        }
      }
      continue;
    }
    if (tag.startsWith("#EXT-X-BYTERANGE:")) {
      const raw = tag.slice("#EXT-X-BYTERANGE:".length).trim();
      const current = resourceEnds.get(lastResource) ?? null;
      pendingRange = normalizeByteRange(raw, { startHint: current });
      continue;
    }
    if (tag.startsWith("#EXTINF")) {
      duration = parseExtinf(tag);
      continue;
    }
    if (tag.startsWith("#")) {
      continue;
    }
    // Media reference line.
    const uriRef = tag;
    const uri = resolveManifestRef(baseUrl, uriRef);
    lastResource = uri;
    const byteRange = pendingRange;
    pendingRange = null;
    if (byteRange) {
      resourceEnds.set(uri, byteRange.end + 1);
    }
    segments.push({
      id: mediaSequence + segments.length,
      uri,
      byteRange,
      duration,
      encrypted: !!activeKey && activeKey.method === "AES-128",
      key: activeKey,
      map: lastMap
    });
    duration = 0;
  }

  return {
    kind: MANIFEST_KIND.M3U8,
    sequence: mediaSequence,
    lanes: [{ id: "main", mimeType: null, codecs: null, maps, segments }]
  };
}

/** DASH `$Token$` substitution. Supports `$Number$`, `$Number%0Nd$`,
 *  `$RepresentationID$`, `$Bandwidth$`. */
export function resolveTemplate(uriTemplate, n, { representationId = null, bandwidth = null } = {}) {
  let out = String(uriTemplate ?? "");
  out = out.replace(/\$Number(?:%0?(\d+)d)?\$/g, (all, width) => {
    const text = String(n);
    if (width && text.length < parseInt(width, 10)) {
      return text.padStart(parseInt(width, 10), "0");
    }
    return text;
  });
  out = out.replaceAll("$RepresentationID$", representationId ?? "");
  out = out.replaceAll("$Bandwidth$", bandwidth ?? "");
  return out;
}

/** Structured DASH walker tokens (lite). */
function tokenizeXml(text) {
  const tokens = [];
  let i = 0;
  let buffer = "";
  const src = String(text ?? "");
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      buffer += src.slice(i);
      break;
    }
    if (lt > i) {
      buffer += src.slice(i, lt);
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) {
      break;
    }
    if (buffer.trim()) {
      tokens.push({ type: "text", text: buffer.trim() });
      buffer = "";
    }
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) {
      continue; // comments / declaration / doctype
    }
    if (raw.startsWith("/")) {
      tokens.push({ type: "close", name: raw.slice(1).trim().toLowerCase() });
      continue;
    }
    const self = TAG_TAIL_SLASH_RE.test(raw);
    const body = raw.replace(TAG_TAIL_SLASH_RE, "");
    const sp = body.search(XML_WS_RE);
    const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const attrs = sp < 0 ? {} : Object.fromEntries(parseXmlAttrs(body.slice(sp + 1)));
    tokens.push({ type: "open", name, attrs, self });
  }
  if (buffer.trim()) {
    tokens.push({ type: "text", text: buffer.trim() });
  }
  return tokens;
}

/**
 * Parse a DASH MPD into SourceBuffer-style lanes (one per Representation).
 * Handles `SegmentTemplate` (timeline + numbered + unbounded → `template`),
 * `SegmentList` (concrete `SegmentURL`s), and `SegmentBase`
 * (init + whole-file media). Init surfaces (`initialization=` /
 * `<Initialization sourceURL= range=>`) land on `lane.init`.
 */
export function parseDash(text, { baseUrl = null } = {}) {
  const tokens = tokenizeXml(text);
  const lanes = [];
  let base = baseUrl ?? "";
  let pendingBase = false;
  let rep = null; // working representation
  let adaptationMime = null;
  let adaptationCodecs = null;
  let laneCount = 0;

  const newRep = (attrs) => ({
    attrs,
    mimeType: attrs.mimeType ?? adaptationMime,
    codecs: attrs.codecs ?? adaptationCodecs,
    template: null,
    timeline: null,
    list: null,
    base: null,
    initElement: null
  });

  const useNumber = () => {
    const tpl = rep.template;
    const start = tpl ? parseInt(tpl.attrs.startNumber ?? "1", 10) : 1;
    return Number.isFinite(start) ? start : 1;
  };

  for (const token of tokens) {
    if (token.type === "text") {
      if (pendingBase && token.text) {
        base = resolveManifestRef(baseUrl ?? base, token.text);
      }
      pendingBase = false;
      continue;
    }
    if (token.type === "close") {
      if (token.name === "baseurl") {
        pendingBase = false;
      }
      if (token.name === "representation" && rep) {
        finalizeRep();
        rep = null;
      }
      continue;
    }

    const { name, attrs } = token;
    if (name === "baseurl") {
      pendingBase = true;
      continue;
    }
    if (name === "period" || name === "mpd") {
      continue;
    }
    if (name === "segmenttemplate") {
      if (rep && !rep.template) {
        rep.template = { attrs };
      }
      continue;
    }
    if (name === "segmenttimeline") {
      if (rep) {
        rep.timeline = [];
      }
      continue;
    }
    if (name === "s") {
      if (rep && rep.timeline) {
        rep.timeline.push({
          t: attrs.t ? parseInt(attrs.t, 10) : null,
          d: attrs.d ? parseInt(attrs.d, 10) : 0,
          r: attrs.r ? parseInt(attrs.r, 10) : 0
        });
      }
      continue;
    }
    if (name === "segmentlist") {
      if (rep && !rep.list) {
        rep.list = { attrs, segments: [] };
      }
      continue;
    }
    if (name === "segmenturl") {
      if (rep && rep.list) {
        rep.list.segments.push(attrs);
      }
      continue;
    }
    if (name === "segmentbase") {
      if (rep && !rep.base) {
        rep.base = { attrs };
      }
      continue;
    }
    if (name === "initialization") {
      if (rep && !rep.initElement) {
        rep.initElement = { attrs };
      }
      continue;
    }
    if (name === "adaptationset") {
      adaptationMime = attrs.mimeType ?? null;
      adaptationCodecs = attrs.codecs ?? null;
      continue;
    }
    if (name === "representation") {
      laneCount++;
      rep = newRep(attrs);
      continue;
    }
  }

  function finalizeRep() {
    const attrs = rep.attrs;
    const lane = {
      id: attrs.id ?? `rep-${laneCount}`,
      mimeType: rep.mimeType ?? null,
      codecs: rep.codecs ?? null,
      bandwidth: attrs.bandwidth ? parseInt(attrs.bandwidth, 10) : null,
      init: null,
      template: null,
      segments: []
    };

    // Init segment resolution.
    if (rep.initElement) {
      const range = rep.initElement.attrs.range ?? null;
      const sourceUrl = rep.initElement.attrs.sourceURL ?? null;
      lane.init = {
        uri: sourceUrl ? resolveManifestRef(base, sourceUrl) : base,
        byteRange: normalizeByteRange(range, { startHint: 0 })
      };
    } else if (rep.template && rep.template.attrs.initialization) {
      const tpl = resolveTemplate(rep.template.attrs.initialization, useNumber(), {
        representationId: attrs.id,
        bandwidth: attrs.bandwidth
      });
      lane.init = { uri: resolveManifestRef(base, tpl), byteRange: null };
    } else if (rep.base && rep.base.attrs.initialization) {
      const raw = String(rep.base.attrs.initialization).trim();
      const parts = raw.split("#");
      lane.init = {
        uri: parts[0] ? resolveManifestRef(base, parts[0]) : base,
        byteRange: parts[1] ? normalizeByteRange(parts[1], { startHint: 0 }) : null
      };
    }

    const timescale = rep.template?.attrs.timescale
      ? parseInt(rep.template.attrs.timescale, 10)
      : rep.list?.attrs.timescale
        ? parseInt(rep.list.attrs.timescale, 10)
        : rep.base?.attrs.timescale
          ? parseInt(rep.base.attrs.timescale, 10)
          : 1;
    const tsv = timescale > 0 ? timescale : 1;

    if (rep.list) {
      for (let i = 0; i < rep.list.segments.length; i++) {
        const s = rep.list.segments[i];
        lane.segments.push({
          id: i,
          uri: s.media ? resolveManifestRef(base, s.media) : base,
          byteRange: normalizeByteRange(s.mediaRange ?? s.range ?? null, { startHint: null }),
          duration: s.durationSec ?? 0,
          encrypted: false,
          key: null,
          map: null
        });
      }
    } else if (rep.timeline && rep.timeline.length > 0) {
      let number = useNumber();
      const tpl = rep.template ? rep.template.attrs.media : null;
      outer: for (const entry of rep.timeline) {
        const repeat = Math.max(1, entry.r + 1);
        for (let k = 0; k < repeat; k++) {
          lane.segments.push({
            id: number,
            uri: tpl ? resolveManifestRef(base, resolveTemplate(tpl, number, {
              representationId: attrs.id,
              bandwidth: attrs.bandwidth
            })) : base,
            byteRange: null,
            duration: entry.d / tsv,
            encrypted: false,
            key: null,
            map: null
          });
          number++;
          if (lane.segments.length >= MAX_CONCRETE_SEGMENTS) {
            break outer;
          }
        }
      }
    } else if (rep.template) {
      const tpl = rep.template.attrs;
      const start = useNumber();
      const end = tpl.endNumber ? parseInt(tpl.endNumber, 10) : null;
      if (end != null && !Number.isNaN(end)) {
        const step = tpl.duration ? parseInt(tpl.duration, 10) / tsv : 0;
        for (let n = start; n <= end && lane.segments.length < MAX_CONCRETE_SEGMENTS; n++) {
          lane.segments.push({
            id: n,
            uri: tpl.media ? resolveManifestRef(base, resolveTemplate(tpl.media, n, {
              representationId: attrs.id,
              bandwidth: attrs.bandwidth
            })) : base,
            byteRange: null,
            duration: step,
            encrypted: false,
            key: null,
            map: null
          });
        }
      } else {
        // Unbounded: hand the template to the flow for on-demand expansion.
        lane.template = {
          uriTemplate: resolveManifestRef(base, tpl.media ?? ""),
          number: start,
          step: tpl.duration ? parseInt(tpl.duration, 10) / tsv : 0,
          representationId: attrs.id,
          bandwidth: attrs.bandwidth
        };
      }
    } else if (rep.base) {
      // Whole-file representation: init + the resource itself as one segment.
      lane.segments = [{ id: 0, uri: base, byteRange: null, duration: 0, encrypted: false, key: null, map: null }];
    }

    lanes.push(lane);
  }

  return { kind: MANIFEST_KIND.MPD, sequence: 0, lanes };
}

/**
 * Parse a manifest into fragment plans. Kind is resolved from the URL suffix
 * first, then sniffed from the text via manifest-pipe's helpers.
 */
export function parseManifest(text, { kind = null, baseUrl = null } = {}) {
  const effectiveKind = kind ?? detectManifestKind(baseUrl) ?? sniffManifestKind(text);
  if (effectiveKind === MANIFEST_KIND.MPD) {
    return parseDash(text, { baseUrl });
  }
  return parseHls(text, { baseUrl });
}