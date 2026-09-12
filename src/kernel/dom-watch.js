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
 * Dispatch rule also borrowed from uBO's safeObserverHandler: listeners are
 * visited from a snapshot (listener-set can't mutate under a live iterator),
 * and each listener is isolated so a throwing consumer cannot abort delivery
 * to the peers that share this batch.
 */
import { logger } from "../shared/logger.js";

// Append-only subscriber slots. Deletes tombstone the slot so flush can take a
// length-hold snapshot without allocating (the former Set-spread array per
// batch); liveSubscribers drives observer teardown. Subscriber counts stay
// tiny (discovery + shell watchdog), so the indexOf scans are not a concern.
const subscribers = [];
let liveSubscribers = 0;

let observer = null;
/** Document the observer is currently bound to - see ensureObserver(). */
let observedDoc = null;
let queued = false;
let pendingRecords = [];

function flush() {
  queued = false;
  const records = pendingRecords;
  pendingRecords = [];
  // Length-hold snapshot: an unsubscribe during delivery just tombstones (and
  // is skipped), a subscribe during delivery joins the next batch, and every
  // member of the original audience still gets the batch - same semantics as
  // the former Set snapshot, with no array allocation per flush.
  for (let i = 0; i < subscribers.length; i++) {
    const subscriber = subscribers[i];
    if (subscriber === null) {
      continue;
    }
    // uBO safeObserverHandler rule: one throwing consumer must never abort
    // the fan-out to its peers in the same batch, nor escape into the page's
    // unhandled-rejection path.
    try {
      subscriber(records);
    } catch (err) {
      logger.error("dom-watch", "A dom-watch subscriber threw during dispatch", err);
    }
  }
}

/**
 * scheduler.yield() lets the browser interleave input / paint between the
 * mutation batch and the subscriber dispatch.
 */
async function scheduleFlush() {
  await scheduler.yield();
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
  if (liveSubscribers === 0 && observer) {
    observer.disconnect();
    observer = null;
    observedDoc = null;
    pendingRecords = [];
  }
}

export function onDomMutations(handler, { signal } = {}) {
  ensureObserver();
  if (!subscribers.includes(handler)) {
    subscribers.push(handler);
    liveSubscribers++;
  }
  const off = () => {
    const index = subscribers.indexOf(handler);
    if (index !== -1 && subscribers[index] !== null) {
      subscribers[index] = null;
      liveSubscribers--;
    }
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}
