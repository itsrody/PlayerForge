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
 *
 * Resource discipline beyond uBO: the records buffer is *pooled* - flush
 * swaps the active/recycled arrays instead of allocating a fresh one per
 * microtask - and tombstoned subscriber slots are compacted once they
 * outnumber live ones 4:1, so a long-lived page never grows the slot array.
 * When the tab is hidden, dispatch (whose subscribers re-scan the DOM) is
 * parked on a background-priority postTask capped at DEFER_VISIBILITY_CAP_MS
 * and resumed on visibility, so a backgrounded SPA doesn't fight its own
 * throttled idle budget with mutation scans.
 */
import { logger } from "../shared/logger.js";
import { postTask, yield_ } from "../shared/scheduler.js";

/** Cap on how long a hidden document's mutation batch stays deferred. */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Sparsity threshold for subscriber-slot compaction. */
const COMPACTION_RATIO = 4;

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
/** Pooled records buffers: flush swaps active/recycled instead of allocating. */
let pendingRecords = [];
let recycledRecords = [];

/** Retained handle for the hidden-tab deferred flush; null when none pending. */
let deferHandle = null;

function flush() {
  queued = false;
  const records = pendingRecords;
  // Double-buffer swap: hand the drained batch back as the recycled buffer
  // instead of abandoning it for a fresh allocation (nothing longer references
  // `records` once this synchronous fan-out completes, so reuse is safe).
  pendingRecords = recycledRecords;
  recycledRecords = records;
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

  // uBO compaction rule: tombstoned slots are reindexed once they outnumber
  // live slots 4:1 - a churny page can't grow the slot array without bound.
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

const onVisibilityChange = () => {
  if (document.visibilityState !== "hidden") {
    flushPending();
  }
};

function flushPending() {
  deferHandle?.abort();
  deferHandle = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  flush();
}

/**
 * Park the pending batch while the document is hidden. A hidden tab's timer
 * and observer still tick; dispatching the (DOM-scanning) subscribers is what
 * should wait, so it is deferred to a background-priority postTask with a hard
 * cap - and resumed the moment the tab is visible again.
 */
function deferFlushUntilVisible() {
  if (deferHandle) {
    return;
  }
  deferHandle = postTask(flushPending, { priority: "background", delay: DEFER_VISIBILITY_CAP_MS });
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Chromium-native scheduling advantage: `scheduler.yield()` lets the browser
 * interleave input / paint between the mutation batch and the subscriber
 * dispatch. Falls back to flush() directly when the API is absent (jsdom
 * tests, non-Chromium hosts) so the test tick() helper stays compatible.
 */
async function scheduleFlush() {
  await yield_();
  if (document.visibilityState === "hidden") {
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
    // Coalesce the batch into the pooled buffer in one place; the browser
    // already arrived with a pooled record list, so this is an append-only
    // copy with no per-record allocation.
    Array.prototype.push.apply(pendingRecords, records);
    if (!queued) {
      queued = true;
      queueMicrotask(scheduleFlush);
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  observedDoc = doc;
}

/**
 * Drop the observer (and any parked defer) the moment the last subscriber
 * leaves. Idempotent no-op when already detached.
 */
function stopIfIdle() {
  if (live === 0 && observer) {
    observer.disconnect();
    observer = null;
    observedDoc = null;
    pendingRecords = [];
    recycledRecords = [];
    slots.length = 0;
    deferHandle?.abort();
    deferHandle = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
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