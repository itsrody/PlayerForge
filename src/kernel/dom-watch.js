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
 */
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
  for (const subscriber of subscribers) {
    subscriber(records);
  }
}

function ensureObserver() {
  const doc = globalThis.document;
  if (!doc?.documentElement || typeof MutationObserver === "undefined") {
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
      queueMicrotask(flush);
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
