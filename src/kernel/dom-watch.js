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
let pendingRecords = [];

/**
 * Cap on how long a hidden document's mutation batch stays deferred (see
 * scheduleFlush). Records accumulate meanwhile, so a backgrounded SPA build
 * never stalls discovery past this window.
 */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Cap timeout for a currently-deferred hidden-document flush; 0 = none. */
let visibilityDeferTimer = 0;
let visibilityListenerAttached = false;

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
  flush();
}

function onVisibilityChanged() {
  visibilityListenerAttached = false;
  if (!isDocumentHidden()) {
    flushPending();
  }
}

/** Defer the batch until the document is visible again or the cap elapses. */
function deferFlushUntilVisible() {
  if (visibilityDeferTimer) {
    return;
  }
  visibilityDeferTimer = setTimeout(flushPending, DEFER_VISIBILITY_CAP_MS);
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener("visibilitychange", onVisibilityChanged, { once: true });
  }
}

function flush() {
  queued = false;
  const records = pendingRecords;
  pendingRecords = [];
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
  observer = new MutationObserver((records) => {
    for (const record of records) {
      pendingRecords.push(record);
    }
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
    slots.length = 0;
    clearTimeout(visibilityDeferTimer);
    visibilityDeferTimer = 0;
    if (visibilityListenerAttached) {
      document.removeEventListener("visibilitychange", onVisibilityChanged);
      visibilityListenerAttached = false;
    }
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
