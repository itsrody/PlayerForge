/**
 * The stream-proxy flow state machine (§7.3). `SegmentManager` owns the
 * lifecycle of every media segment between manifest rewrite and SourceBuffer:
 * fetch (via the caller's transport seam, later `ProxyProvider`), optional
 * decrypt (the seam for AES-128 / ClearKey), and strictly in-order delivery to
 * the append gate. It is intentionally pure orchestration - no browser API is
 * touched here - so the transitions, reorder buffer, retry bounds, token
 * refresh, and abort semantics run headless with injected seams.
 *
 * Hard guarantees enforced here, mirroring the repo's rules:
 * - segments are delivered to append() in ascending sequence order, never
 *   out of order (except an opt-in gap slide after a bounded wait);
 * - one fetch in flight per concurrency slot, a byte cap on pending fetches,
 *   and a cap on active (reorder-buffered) segments - bounded memory;
 * - retries are bounded and token-path retries are bounded independently;
 * - a 403/410 is the NORMAL "credential expired" signal, routed to the token
 *   refresh seam, never counted as a media failure;
*  - abort (pause/seek/teardown) cancels every in-flight fetch and halts.
 */
import { logger } from "../../shared/logger.js";

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
    // status - so the active count (reorder-buffer cap + drain) stays exact
    // no matter how late delivery runs relative to the fetch step.
    if (ACTIVE.has(from) && !ACTIVE.has(to)) {
      this.#active = Math.max(0, this.#active - 1);
    }
    this.#emit({ type: "status", id: seg.id, from, to });
  }

  /**
   * Register a segment for the stream. `info` = {id, uri, byteRange?,
   * encrypted?, key?, auth?, byteHint?}. Idempotent per id (duplicates and
   * already-finalized ids are ignored); returns false once the stream aborts.
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
      attempts: 0,
      refreshes: 0,
      bytes: null,
      retryAt: null,
      status: STATUS.IDLE
    };
    this.#pending.set(id, seg);
    this.#active++;
    this.#emit({ type: "status", id, from: null, to: STATUS.IDLE });
    logger.log("proxy", "segment", "enqueue", { id, uri: seg.uri, encrypted: seg.encrypted, byteHint: seg.byteHint });
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

  #canStartFetch() {
    if (this.#inFlight >= this.#concurrency) {
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
    while (!this.#aborted && this.#canStartFetch()) {
      const seg = this.#nextEligible();
      if (!seg) {
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
    seg.retryAt = null;
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
}