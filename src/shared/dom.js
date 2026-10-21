/**
 * DOM substrate.
 *
 * One module for the document's material concerns:
 *   1. Mutation feed  - onDomMutations (the one document-level observer)
 *   2. Pooling        - DomPool (element recycling)
 *   3. Ledger         - DOMManager (per-shell DOM lifecycle + rollbacks)
 *   4. Traversal      - shadow-boundary piercing helpers (deepestActiveElement,
 *                       isInsideShell)
 *   5. Fullscreen gate- fs, initFullscreenGate, subscribeFullscreen
 *
 * Substrate rule (documented in the feed): container- and anchor-scoped
 * observers stay native everywhere else - the browser filters their subtrees
 * in C++, while a shared dispatcher would filter every document mutation in
 * JS just to reconstruct that scoping.
 */
import { Scope, logger, postTask, yield_ } from "./runtime.js";

/* - 1. Mutation feed - */
/**
 * Single document-level mutation feed for every document-wide interest.
 *
 * Discovery (kernel/discovery.js) and the shell-host reconnect watchdog
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

/** Cap on how long a hidden document's mutation batch stays deferred. */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Sparsity threshold for subscriber-slot compaction. */
const COMPACTION_RATIO = 4;
/**
 * Batch size above which the append switches from apply() to an index walk.
 * apply() spreads the batch onto the call stack and V8 refuses somewhere past
 * ~124k arguments (RangeError) - which a mass-DOM-teardown batch can reach,
 * and which would escape the observer callback before the queue flag below is
 * set, silently dropping the whole batch. apply() stays the fast path for
 * every batch we actually see (measurably cheaper than an element-by-element
 * push loop), the walk only takes over where it is safe rather than fast.
 */
const PUSH_APPLY_LIMIT = 65536;

/**
 * Append-only subscriber slots with tombstones. A live subscription is a
 * [handler] slot; unsubscribe nulls the handler *inside its own slot* rather
 * than writing a positional tombstone - the returned off() closes over the
 * slot object, so compaction can reindex slots freely without orphaning any
 * unsubscribe handle (a positional handle would write to a stale index after
 * compaction: no-op at best - leaking a zombie subscriber that keeps the
 * observer alive forever - or killing whichever subscriber now sits at that
 * index). `live` counts active slots so teardown stays automatic. This
 * replaces a Set-snapshot fan-out: the per-batch `[...subscribers]`
 * allocation is gone from the mutation hot path.
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
/** Abort scope for the visibilitychange resume listener: flush and idle
 *  teardown release it natively instead of pairing add/remove by hand. */
let deferAc = null;

function flush() {
  queued = false;
  const records = pendingRecords;
  // Double-buffer swap: hand the drained batch back as the recycled buffer
  // instead of abandoning it for a fresh allocation (nothing longer references
  // `records` once this synchronous fan-out completes, so reuse is safe).
  pendingRecords = recycledRecords;
  // Re-arm the incoming buffer EMPTY. The swap alone leaves the batch
  // delivered two flushes ago inside it, and the observer only ever appends:
  // without this, every flush from the third onward re-delivered stale
  // records alongside the current batch (observed as [1,1,2,2,3] for five
  // single-mutation rounds) - each one costing subscribers a redundant DOM
  // walk over records they had already handled.
  pendingRecords.length = 0;
  recycledRecords = records;
  // Dispatch from a length-hold: tombstones are skipped, and slots appended
  // mid-batch (subscriptions landing during delivery) belong to the next
  // batch - subscribe/unsubscribe can't skew the current audience.
  const length = slots.length;
  for (let i = 0; i < length; i++) {
    const slot = slots[i];
    if (!slot || !slot[0]) {
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
  // Safe because unsubscribe tracks slot identity (see onDomMutations), not
  // slot position.
  if (live > 0 && slots.length > live * COMPACTION_RATIO) {
    let write = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot && slot[0]) {
        slots[write++] = slot;
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
  deferAc?.abort();
  deferAc = null;
  deferHandle?.abort();
  deferHandle = null;
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
  deferAc = new AbortController();
  deferHandle = postTask(flushPending, { priority: "background", delay: DEFER_VISIBILITY_CAP_MS });
  document.addEventListener("visibilitychange", onVisibilityChange, { signal: deferAc.signal });
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
    if (records.length < PUSH_APPLY_LIMIT) {
      Array.prototype.push.apply(pendingRecords, records);
    } else {
      for (let i = 0; i < records.length; i++) {
        pendingRecords.push(records[i]);
      }
    }
    if (!queued) {
      queued = true;
      // scheduleFlush() runs synchronously up to its yield_() await, so the
      // extra queueMicrotask hop the original shape paid bought nothing -
      // the yield already provides the task boundary before dispatch.
      scheduleFlush().catch((err) => {
        logger.error("dom-watch", "Flush scheduling failed:", err);
      });
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
    deferAc?.abort();
    deferAc = null;
    deferHandle?.abort();
    deferHandle = null;
  }
}

export function onDomMutations(handler, { signal } = {}) {
  // An already-aborted signal never fires the teardown listener, so
  // subscribing would pin this slot (and keep the document observer alive)
  // forever. Treat it as a no-op subscription.
  if (signal?.aborted) {
    return () => {};
  }
  ensureObserver();
  const slot = [handler];
  slots.push(slot);
  live += 1;
  const off = () => {
    if (slot[0]) {
      slot[0] = null;
      live -= 1;
      // Release the abort listener on manual unsubscribe too - otherwise the
      // signal retains this closure until it aborts (possibly never).
      signal?.removeEventListener("abort", off);
    }
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}/* - 2. Pooling - */
/**
 * Lightweight DOM element pool — acquire/release lifecycle for reusable
 * elements. Caller handles DOM attach/detach; the pool manages reuse and
 * cleanup. Elements grow the pool on demand but never shrink automatically —
 * call shrink() to drop excess elements after bulk removals.
 *
 * Used by toasts, history cards, and subtitle cue slots to avoid repeated
 * createElement/remove cycles on hot paths.
 */
export class DomPool {
  /** Factory: creates a fresh element (not attached to any parent). */
  #factory;
  /** Reset: clears recycled element state (textContent, classes, styles). */
  #reset;
  /** Available elements ready for reuse. */
  #available;

  /**
   * @param {{ factory: () => HTMLElement, reset: (el: HTMLElement) => HTMLElement, initial?: number }}
   */
  constructor({ factory, reset, initial = 0 }) {
    this.#factory = factory;
    this.#reset = reset;
    this.#available = [];
    for (let i = 0; i < initial; i++) {
      this.#available.push(factory());
    }
  }

  /** Get a pooled element (reset) or create a new one. */
  acquire() {
    return this.#available.length > 0
      ? this.#reset(this.#available.pop())
      : this.#factory();
  }

  /** Return an element to the pool for reuse. Caller must detach first. */
  release(element) {
    this.#available.push(element);
  }

  /** Drop elements beyond `keep` count. Removes excess from DOM. */
  shrink(keep) {
    while (this.#available.length > keep) {
      this.#available.pop().remove();
    }
  }

  /** Remove all pooled elements from DOM and empty the pool. */
  destroy() {
    for (const el of this.#available) {
      el.remove();
    }
    this.#available.length = 0;
  }

  /** Number of elements currently available for reuse. */
  get idle() {
    return this.#available.length;
  }
}
/* - 3. Ledger - */

/**
 * Per-shell DOM lifecycle manager.
 *
 * Tracks every DOM artifact a shell creates — observers, elements, and
 * inline style/attribute rollbacks — and tears them all down in one call.
 * Prevents the most common class of leak in complex component trees:
 * forgetting to remove one observer or listener in a rarely-tested code
 * path.
 *
 * Event listeners are NOT tracked in a registry: `listen()` hands the
 * manager's own AbortSignal to `addEventListener`, so removal is the
 * platform's job on dispose — no [target, event, handler, opts] tuples to
 * retain, no manual removeEventListener sweep, and the target's listener
 * list drops the entry at abort instead of waiting for GC.
 *
 * Hot-path code (scrub, cue rendering) stays on direct DOM access; the
 * manager only wraps lifecycle-bound operations that need cleanup.
 */
export class DOMManager {
  /** [element] Created elements for automatic remove(). */
  #elements = [];
  /** [el, attr, value, original] triples for attribute rollback on destroy. */
  #attrRollbacks = [];
  /** [el, prop, value, original] triples for style rollback on destroy. */
  #styleRollbacks = [];
  /** [fn] External cleanup callbacks (e.g. dom-watch unsubscribe handles). */
  #cleanups = [];
  #scope = new Scope();

  /**
   * Add an event listener that is automatically removed when the manager is
   * destroyed. Returns the handler for call-site reference (e.g. passing to
   * removeEventListener before destroy is called).
   */
  listen(target, event, handler, opts) {
    // Normalize the boolean shorthand so `{ signal }` never drops `capture`.
    const options = typeof opts === "boolean" ? { capture: opts } : { ...opts };
    options.signal = this.#scope.signal;
    target.addEventListener(event, handler, options);
    return handler;
  }

  /**
   * Create a ResizeObserver that is automatically disconnected on destroy.
   * Returns the observer for manual use between creation and destroy.
   */
  observeResize(target, callback) {
    if (this.#scope.disposed) return null;
    const observer = new ResizeObserver(callback);
    observer.observe(target);
    this.#scope.onDispose(() => observer.disconnect());
    return observer;
  }

  /**
   * Create an element and append it to a parent. The element is automatically
   * removed from the DOM on destroy.
   */
  createElement(tag, attrs, parent) {
    if (this.#scope.disposed) return null;
    const doc = parent?.ownerDocument ?? document;
    const node = doc.createElement(tag);
    if (attrs) {
      // for-in + hasOwn over Object.entries: attr maps are tiny and built per
      // tracked element, and Object.entries allocates a pair array plus the
      // key/value arrays for every one - measured ~78 vs ~20 ns/op for a
      // 3-key map. hasOwn keeps own-only semantics identical.
      for (const key in attrs) {
        if (!Object.hasOwn(attrs, key)) {
          continue;
        }
        const value = attrs[key];
        if (key === "class") {
          node.className = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(node.style, value);
        } else {
          node.setAttribute(key, value);
        }
      }
    }
    parent?.appendChild(node);
    this.#elements.push(node);
    return node;
  }

  /**
   * Set an attribute on an element, recording the original value for
   * automatic restoration on destroy. If the element already has the
   * attribute, the original is preserved (first-write wins).
   */
  markAttribute(el, attr, value) {
    if (this.#scope.disposed) return;
    const existing = this.#attrRollbacks.find(([e, a]) => e === el && a === attr);
    if (!existing) {
      const original = el.getAttribute(attr);
      this.#attrRollbacks.push([el, attr, value, original]);
    }
    el.setAttribute(attr, value);
  }

  /**
   * Set an inline style property, recording the original value for
   * automatic restoration on destroy.
   */
  markStyle(el, prop, value) {
    if (this.#scope.disposed) return;
    const existing = this.#styleRollbacks.find(([e, p]) => e === el && p === prop);
    if (!existing) {
      const original = el.style.getPropertyValue(prop);
      this.#styleRollbacks.push([el, prop, value, original]);
    }
    el.style.setProperty(prop, value);
  }

  /**
   * Register an external cleanup callback (e.g. an unsubscribe handle from
   * dom-watch.js or a pool destroy). Called in reverse order on destroy.
   */
  onCleanup(fn) {
    if (this.#scope.disposed) {
      fn();
      return;
    }
    this.#cleanups.push(fn);
  }

  /**
   * Tear down every tracked artifact. Idempotent — safe to call multiple
   * times: Scope.dispose() flips `disposed` before it aborts, so re-entrant
   * calls no-op from the first line on.
   */
  destroy() {
    if (this.#scope.disposed) return;

    // Mark disposed + abort the signal FIRST: every signal-bound listener
    // and observer disconnect registered above is released by the platform
    // here (onDispose runs observer disconnects), and cleanup callbacks
    // below can no longer register new tracked artifacts.
    this.#scope.dispose();

    // External cleanups (may reference elements being removed next).
    for (let i = this.#cleanups.length - 1; i >= 0; i--) {
      try { this.#cleanups[i](); } catch {}
    }
    this.#cleanups.length = 0;

    // Attribute rollbacks (restore original values).
    for (const [el, attr, , original] of this.#attrRollbacks) {
      if (original == null) {
        el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, original);
      }
    }
    this.#attrRollbacks.length = 0;

    // Style rollbacks (restore original values).
    for (const [el, prop, , original] of this.#styleRollbacks) {
      if (original) {
        el.style.setProperty(prop, original);
      } else {
        el.style.removeProperty(prop);
      }
    }
    this.#styleRollbacks.length = 0;

    // Remove created elements.
    for (let i = this.#elements.length - 1; i >= 0; i--) {
      this.#elements[i].remove();
    }
    this.#elements.length = 0;
  }
}
/* - 4. Traversal - */

/**
 * The deepest active element, piercing open shadow boundaries.
 * When `host` has a shadow root, the shadow tracks the real focused
 * element; otherwise falls back to `document.activeElement` (light DOM
 * or test environments like JSDOM).
 */
export function deepestActiveElement(host) {
  let el = host?.shadowRoot?.activeElement ?? document.activeElement;
  while (el?.shadowRoot) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

/**
 * True when `node` is a descendant of `host`'s shadow root
 * (or is the host itself). Falls back to light-DOM `contains()` when
 * no shadow root exists (e.g. JSDOM tests).
 */
export function isInsideShell(host, node) {
  return node === host || (host.shadowRoot?.contains(node) ?? host.contains(node));
}

/* - 5. Fullscreen gate - */

/**
 * SOL - the single fullscreen gate across PlayerForge. A boolean, not a DOM
 * reference: `true` means ALLOW every fs-gated feature, `false` means BLOCK
 * them. It is maintained exclusively by initFullscreenGate() off the native
 * `fullscreenchange` event, and every fs-conditioned path in the codebase
 * (gesture intents, input binding gates, shell state, pinch wiring) reads
 * this one boolean - nothing else touches fullscreen directly.
 *
 * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
 * fullscreen: latching `!!document.fullscreenElement` at the transition is the
 * single source of truth, regardless of which actor entered it. Module-level
 * so it represents document-wide truth and survives shell create/destroy.
 */
export let fs = false;

/** Subscribers notified on a fullscreen state transition (subscribed from a
 *  single underlying native listener; see initFullscreenGate). */
const fsSubscribers = new Set();

/** Document the gate is currently bound to, so a repeated init (e.g. double
 *  script eval) re-seeds `fs` without stacking duplicate native listeners. */
let fsGateDoc = null;

/**
 * Build the `fs` gate off the native fullscreen event and fan out transitions.
 * Call once at startup. `doc` is injectable for jsdom tests so they drive the
 * real mechanism.
 *
 * This is the ONLY place that touches fullscreen: it owns the `fs` value AND
 * the single underlying `fullscreenchange` listener. Every other fs-conditioned
 * path reads `fs` directly or subscribes to transitions via subscribeFullscreen,
 * so there is one gate and one transition source regardless of shell count.
 */
export function initFullscreenGate(doc = document) {
  fs = !!doc.fullscreenElement;
  // Re-seed `fs` above, but bind the transition listener once per document -
  // a second init on the same doc would otherwise double-fire every flip.
  if (fsGateDoc === doc) {
    return;
  }
  fsGateDoc = doc;
  const update = () => {
    const next = !!doc.fullscreenElement;
    if (next === fs) {
      return;
    }
    fs = next;
    for (const cb of fsSubscribers) {
      cb(next);
    }
  };
  doc.addEventListener("fullscreenchange", update);
}

/**
 * Subscribe to fullscreen state transitions (fires only on an actual flip,
 * before the gates' consumers observe the new `fs`). Returns an unsubscribe
 * function; pass `signal` to have it torn down automatically.
 */
export function subscribeFullscreen(cb, signal) {
  // An aborted signal's teardown listener never fires - adding `cb` now would
  // pin it in fsSubscribers forever (and keep firing post-teardown).
  if (signal?.aborted) {
    return () => {};
  }
  fsSubscribers.add(cb);
  if (signal) {
    signal.addEventListener("abort", () => fsSubscribers.delete(cb), { once: true });
  }
  return () => fsSubscribers.delete(cb);
}
