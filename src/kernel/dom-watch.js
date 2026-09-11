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

const subscribers = new Set();

let observer = null;
/** Document the observer is currently bound to - see ensureObserver(). */
let observedDoc = null;
let queued = false;
let pendingRecords = [];

function flush() {
  queued = false;
  const records = pendingRecords;
  pendingRecords = [];
  // Dispatch from a snapshot: a subscriber that unsubscribes during delivery
  // (or another that subscribes) must not skew the current batch's audience.
  const snapshot = [...subscribers];
  for (const subscriber of snapshot) {
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
 * Chromium-native scheduling advantage: `scheduler.yield()` lets the browser
 * interleave input / paint between the mutation batch and the subscriber
 * dispatch. Falls back to flush() directly when the API is absent (jsdom
 * tests, non-Chromium hosts) so the test tick() helper stays compatible.
 */
async function scheduleFlush() {
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
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
  if (subscribers.size === 0 && observer) {
    observer.disconnect();
    observer = null;
    observedDoc = null;
    pendingRecords = [];
  }
}

export function onDomMutations(handler, { signal } = {}) {
  ensureObserver();
  subscribers.add(handler);
  const off = () => {
    subscribers.delete(handler);
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}
