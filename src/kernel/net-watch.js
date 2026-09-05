/**
 * Single realm-wide network feed for every network-wide interest (§7.7).
 *
 * The kernel's unified net-watch: one live PerformanceObserver over
 * `resource` entries, coalesced per microtask, fanned out to subscribers -
 * the network sibling of dom-watch.js. The media element's native GETs (the
 * network-process loads this userscript's request seams can never see) and
 * every other resource sighting reach subscribers here without each interest
 * owning its own observer or polling the performance timeline.
 *
 * Realm-native, not privileged: PerformanceObserver is per-frame by design,
 * so a subframe's element GETs surface in ITS realm with no TM privileges and
 * no cross-frame routing - the "top-frame-only" GM_webRequest limitation never
 * applies to this feed and there is nothing to relay. GM_webRequest stays a
 * top-frame tab-wide analyst (the bootstrap role split) and is deliberately
 * NOT a transport of this module. Because the feed is realm-local, page
 * scripts cannot spoof it and no privileged action is reachable through it -
 * observe-only by construction.
 *
 * Firefox-native: PerformanceObserver / PerformanceResourceTiming are FF 57+
 * (baseline 2024). `entry.name` (the URL) survives cross-origin -
 * Timing-Allow-Origin only zeros granular timestamps, never the name.
 * `buffered: false` is the efficient mode by design: a buffered replay would
 * O(n) the whole 250-entry default window on first callback and drop the live
 * pressure this feed exists to catch.
 *
 * Resource rule borrowed from uBO (and dom-watch.js): the underlying observer
 * exists only while at least one subscriber is attached, and teardown is
 * automatic when the last one leaves (or via AbortSignal). An optional
 * per-subscriber `filter` runs inline (uBO-style) so one observer + one
 * fan-out pass serves every interest; ad/analytics entries never leave the
 * dispatcher unless a subscriber opts into them.
 *
 * Deterministic: like dom-watch.js, the observer class is resolved from the
 * active global at call time, so a test installing a stub before subscribing
 * drives the whole feed headless.
 */
const subscribers = new Set();

let observer = null;
let queued = false;
let pendingEntries = [];

function flush() {
  queued = false;
  const entries = pendingEntries;
  pendingEntries = [];
  for (const subscriber of subscribers) {
    const handler = subscriber.handler;
    if (!subscriber.filter) {
      handler(entries);
      continue;
    }
    const matched = [];
    for (const entry of entries) {
      if (subscriber.filter(entry)) {
        matched.push(entry);
      }
    }
    if (matched.length) {
      handler(matched);
    }
  }
}

function ensureObserver() {
  // Structural guard mirroring dom-watch.js's `!doc?.documentElement`: the
  // observer class exists in every browser (FF 57+, baseline) and modern Node;
  // a realm without it (stripped test host) stays idle rather than throwing.
  const ObserverClass = globalThis.PerformanceObserver;
  if (typeof ObserverClass !== "function") {
    return;
  }
  if (observer) {
    return;
  }
  observer = new ObserverClass((list) => {
    for (const entry of list.getEntries()) {
      pendingEntries.push(entry);
    }
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  });
  observer.observe({ type: "resource", buffered: false });
}

/** Idempotent no-op when already detached (observer torn down). */
function stopIfIdle() {
  if (subscribers.size === 0 && observer) {
    observer.disconnect();
    observer = null;
    pendingEntries = [];
  }
}

/**
 * Subscribe to every resource sighting. `handler(entries)` receives one
 * coalesced batch per microtask. `filter(entry)` (optional) is applied inline
 * so only matching entries reach this handler; a subscriber without a filter
 * sees everything. Returns the unsubscribe function.
 */
export function onNetEvents(handler, { signal, filter = null } = {}) {
  ensureObserver();
  const subscriber = { handler, filter: typeof filter === "function" ? filter : null };
  subscribers.add(subscriber);
  const off = () => {
    subscribers.delete(subscriber);
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}