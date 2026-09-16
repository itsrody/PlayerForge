/**
 * Single document-level mutation feed for every document-wide interest.
 *
 * Discovery (kernel/sdk.js) and the shell-host reconnect watchdog
 * (chrome/inject.js) both need "something anywhere changed" - running two
 * full-document MutationObservers makes SPA pages pay twice per mutation
 * batch. This dispatcher observes once, coalesces records per microtask,
 * and fans out to subscribers.
 *
 * Scope discipline: container- and anchor-scoped observers elsewhere stay
 * native on purpose - the browser filters their subtrees in C++, while a
 * shared dispatcher would filter every document mutation in JS just to
 * reconstruct that scoping.
 *
 * Resource rule borrowed from uBO: the underlying observer exists only
 * while at least one subscriber is attached, and teardown is automatic
 * when the last one leaves (or via AbortSignal).
 *
 * Dispatch rule also borrowed from uBO's safeObserverHandler: each listener
 * is isolated so a throwing consumer cannot abort delivery to the peers in
 * this batch, and fan-out holds the slot length at dispatch start - a
 * subscription that lands mid-batch never mutates the live iterator.
 */
import { logger } from "../shared/logger.js";
import { VisibilityWatcher } from "../shared/visibility-watcher.js";
import { postTask } from "../shared/scheduler.js";

/** Cap on how long a hidden document's mutation batch stays deferred. */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Sparsity threshold for slot compaction. */
const COMPACTION_RATIO = 4;

/**
 * Document-level mutation dispatcher. Encapsulates the subscriber slot
 * pool, MutationObserver lifecycle, record pooling, and visibility
 * deferral into a single class. A module-level singleton instance is
 * exported; the public API surface remains function-based for consumers.
 */
class DomWatchDispatcher {
  /** Append-only subscriber slots with tombstones. */
  #slots = [];
  #live = 0;

  #observer = null;
  /** Document the observer is currently bound to. */
  #observedDoc = null;
  #queued = false;

  /**
   * Pooled records buffer: swapped on each flush instead of allocating a
   * fresh array per microtask.
   */
  #pendingRecords = [];
  #recycledRecords = [];

  /** Retained handle for the deferred flush timer. */
  #deferHandle = null;

  /** Lazily initialized VisibilityWatcher. */
  #visWatcher = null;
  #visScope = null;

  /**
   * Dispatch the current batch to all live subscribers, then compact
   * tombstones when sparsity exceeds the threshold.
   */
  #flush() {
    this.#queued = false;
    const records = this.#pendingRecords;
    this.#pendingRecords = this.#recycledRecords;
    this.#recycledRecords = [];

    const length = this.#slots.length;
    for (let i = 0; i < length; i++) {
      const slot = this.#slots[i];
      if (!slot) {
        continue;
      }
      try {
        slot[0](records);
      } catch (err) {
        logger.error("dom-watch", "A dom-watch subscriber threw during dispatch", err);
      }
    }

    if (this.#live > 0 && this.#slots.length > this.#live * COMPACTION_RATIO) {
      let write = 0;
      for (let i = 0; i < this.#slots.length; i++) {
        if (this.#slots[i]) {
          this.#slots[write++] = this.#slots[i];
        }
      }
      this.#slots.length = write;
    }
  }

  #flushPending() {
    this.#deferHandle?.abort();
    this.#deferHandle = null;
    this.#flush();
  }

  /** Defer the batch until the document is visible again or the cap elapses. */
  #deferFlushUntilVisible() {
    if (this.#deferHandle) {
      return;
    }
    this.#deferHandle = postTask(() => this.#flushPending(), {
      priority: "background",
      delay: DEFER_VISIBILITY_CAP_MS
    });
    if (!this.#visWatcher) {
      this.#visScope = new AbortController();
      this.#visWatcher = new VisibilityWatcher(this.#visScope.signal);
    }
    this.#visWatcher.onVisible(() => this.#flushPending());
  }

  async #scheduleFlush() {
    if (typeof globalThis.scheduler?.yield === "function") {
      await globalThis.scheduler.yield();
    }
    if (document.visibilityState === "hidden") {
      this.#deferFlushUntilVisible();
      return;
    }
    this.#flush();
  }

  #ensureObserver() {
    const doc = globalThis.document;
    if (!doc?.documentElement) {
      return;
    }
    if (this.#observer && this.#observedDoc === doc) {
      return;
    }
    this.#observer?.disconnect();
    this.#queued = false;
    this.#pendingRecords = [];
    this.#recycledRecords = [];
    this.#observer = new MutationObserver((records) => {
      Array.prototype.push.apply(this.#pendingRecords, records);
      if (!this.#queued) {
        this.#queued = true;
        queueMicrotask(() => this.#scheduleFlush());
      }
    });
    this.#observer.observe(doc.documentElement, { childList: true, subtree: true });
    this.#observedDoc = doc;
  }

  /** Tear down the observer when no subscribers remain. */
  #stopIfIdle() {
    if (this.#live === 0 && this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
      this.#observedDoc = null;
      this.#pendingRecords = [];
      this.#recycledRecords = [];
      this.#slots.length = 0;
      this.#deferHandle?.abort();
      this.#deferHandle = null;
    }
  }

  /**
   * Subscribe to document-level mutations.
   * @param {Function} handler - Receives the MutationRecord array.
   * @param {{ signal?: AbortSignal }} opts
   * @returns {Function} Unsubscribe function.
   */
  onDomMutations(handler, { signal } = {}) {
    this.#ensureObserver();
    this.#slots.push([handler]);
    this.#live += 1;
    const index = this.#slots.length - 1;
    const off = () => {
      if (this.#slots[index]) {
        this.#slots[index] = null;
        this.#live -= 1;
      }
      this.#stopIfIdle();
    };
    signal?.addEventListener("abort", off, { once: true });
    return off;
  }
}

/** Module-level singleton. */
const dispatcher = new DomWatchDispatcher();

/** Subscribe to document-level mutations. */
export function onDomMutations(handler, opts) {
  return dispatcher.onDomMutations(handler, opts);
}
