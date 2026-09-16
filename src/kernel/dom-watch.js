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

/**
 * Append-only subscriber slots with tombstones. A live subscription is a
 * [handler] slot; unsubscribe writes a null tombstone without reindexing.
 * `live` counts active slots so teardown stays automatic. This replaces a
 * Set-snapshot fan-out: the per-batch `[...subscribers]` allocation is gone
 * from the mutation hot path.
 */
const slots = [];
let live = 0;

let observer = null;
/** Document the observer is currently bound to - see ensureObserver(). */
let observedDoc = null;
let queued = false;

/**
 * Pooled records buffer: swapped on each flush instead of allocating a fresh
 * array per microtask. The old buffer is reused on the next observer callback
 * after the flush completes, eliminating per-batch array churn on the mutation
 * hot path.
 */
let pendingRecords = [];
let recycledRecords = [];

/**
 * Cap on how long a hidden document's mutation batch stays deferred (see
 * scheduleFlush). Records accumulate meanwhile, so a backgrounded SPA build
 * never stalls discovery past this window.
 */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Cap timeout for a currently-deferred hidden-document flush; 0 = none. */
let visibilityDeferTimer = 0;
/** Retained handle for scheduler.postTask() so it can be cancelled if the
 *  document becomes visible before the delay elapses. Null when not pending. */
let backgroundTaskHandle = null;

/** Module-level VisibilityWatcher replaces manual visibilitychange handling.
 *  Lazily initialized on first use to avoid accessing `document` at import
 *  time — test harnesses may import dom-watch without a DOM. */
let visWatcher = null;
let visScope = null;

/**
 * Sparsity threshold for slot compaction. When the slots array has more than
 * COMPACTION_RATIO empty tombstones per live slot, compact by filtering out
 * nulls and reindexing. This prevents unbounded iteration over dead slots on
 * long-lived SPA pages with frequent subscribe/unsubscribe churn. The
 * compaction runs in O(n) over the slot array and is triggered at most once
 * per flush cycle.
 */
const COMPACTION_RATIO = 4;

/**
 * Real-hidden only: `visibilityState === "hidden"` is the primitive behind
 * `document.hidden` in every browser, but jsdom documents default to
 * `visibilityState: "prerender"` with `hidden: true` - gating on `hidden`
 * alone would silently drop every mutation in a test host.
 */
function isDocumentHidden() {
  return document.visibilityState === "hidden";
}

function flushPending() {
  clearTimeout(visibilityDeferTimer);
  visibilityDeferTimer = 0;
  if (backgroundTaskHandle) {
    backgroundTaskHandle = null;
  }
  flush();
}

/** Defer the batch until the document is visible again or the cap elapses.
 *  Uses scheduler.postTask() (Firefox 142+ / Chrome 129+) with 'background'
 *  priority when available: the browser's task scheduler natively prioritizes
 *  visible-tab work over this hidden-tab flush, and the delay option provides
 *  the timeout cap. Falls back to setTimeout for older runtimes. */
function deferFlushUntilVisible() {
  if (visibilityDeferTimer || backgroundTaskHandle) {
    return;
  }
  if (typeof globalThis.scheduler?.postTask === "function") {
    backgroundTaskHandle = globalThis.scheduler.postTask(flushPending, {
      priority: "background",
      delay: DEFER_VISIBILITY_CAP_MS
    });
  } else {
    visibilityDeferTimer = setTimeout(flushPending, DEFER_VISIBILITY_CAP_MS);
  }
  // Lazily create and subscribe to the module-level VisibilityWatcher on
  // first use. This avoids accessing `document` at import time so test
  // harnesses that import dom-watch without a DOM don't break.
  if (!visWatcher) {
    visScope = new AbortController();
    visWatcher = new VisibilityWatcher(visScope.signal);
  }
  visWatcher.onVisible(flushPending);
}

function flush() {
  queued = false;
  // Swap the pooled buffer: the current pending records become the dispatch
  // set, and the old recycled buffer is reused on the next observer callback.
  // This eliminates per-flush array allocation on the mutation hot path.
  const records = pendingRecords;
  pendingRecords = recycledRecords;
  recycledRecords = [];
  // Dispatch from a length-hold: tombstones are skipped, and slots appended
  // mid-batch (subscriptions landing during delivery) belong to the next
  // batch - subscribe/unsubscribe can't skew the current audience.
  const length = slots.length;
  for (let i = 0; i < length; i++) {
    const slot = slots[i];
    if (!slot) {
      continue;
    }
    // uBO safeObserverHandler rule: one throwing consumer must never abort
    // the fan-out to its peers in the same batch, nor escape into the page's
    // unhandled-rejection path.
    try {
      slot[0](records);
    } catch (err) {
      logger.error("dom-watch", "A dom-watch subscriber threw during dispatch", err);
    }
  }
  // Post-dispatch compaction: when the slot array has accumulated enough
  // tombstones relative to live subscribers, filter and reindex to prevent
  // unbounded iteration growth. Runs in O(n) and is triggered at most once
  // per flush cycle; the cost is amortized across the mutation batches that
  // built up the sparsity.
  if (live > 0 && slots.length > live * COMPACTION_RATIO) {
    let write = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) {
        slots[write++] = slots[i];
      }
    }
    slots.length = write;
  }
}

/**
 * Cooperative scheduling between the mutation batch and the subscriber
 * dispatch: `scheduler.yield()` (Firefox 142+ / Chrome 129+; on the Firefox
 * 157 floor) interleaves input / paint. Falls back to flush() directly when
 * the API is absent (jsdom tests) so the test tick() helper stays compatible.
 */
async function scheduleFlush() {
  if (typeof globalThis.scheduler?.yield === "function") {
    await globalThis.scheduler.yield();
  }
  // Hidden-document deferral: a background tab keeps a live-but-idle observer
  // instead of paying per-mutation JS dispatch for a page nobody is looking
  // at. Records keep accumulating; the batch flushes on visibility resume or
  // when the cap elapses (whichever first).
  if (isDocumentHidden()) {
    deferFlushUntilVisible();
    return;
  }
  flush();
}

function ensureObserver() {
  const doc = globalThis.document;
  if (!doc?.documentElement) {
    return;
  }
  if (observer && observedDoc === doc) {
    return;
  }
  // Re-bind when the active document changed underneath us. Never happens
  // in a real page; happens constantly under jsdom test harnesses that
  // install a fresh document per case.
  observer?.disconnect();
  queued = false;
  pendingRecords = [];
  recycledRecords = [];
  observer = new MutationObserver((records) => {
    // Batch push: splice the observer's records into the pending buffer
    // directly instead of per-record iteration. The native array push is
    // optimized in all major engines for argument-list splicing.
    Array.prototype.push.apply(pendingRecords, records);
    if (!queued) {
      queued = true;
      queueMicrotask(scheduleFlush);
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  observedDoc = doc;
}

/** Idempotent no-op when already detached (observer torn down). */
function stopIfIdle() {
  if (live === 0 && observer) {
    observer.disconnect();
    observer = null;
    observedDoc = null;
    pendingRecords = [];
    recycledRecords = [];
    slots.length = 0;
    clearTimeout(visibilityDeferTimer);
    visibilityDeferTimer = 0;
    backgroundTaskHandle = null;
  }
}

export function onDomMutations(handler, { signal } = {}) {
  ensureObserver();
  slots.push([handler]);
  live += 1;
  const index = slots.length - 1;
  const off = () => {
    if (slots[index]) {
      slots[index] = null;
      live -= 1;
    }
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}
