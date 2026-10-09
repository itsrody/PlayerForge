import { Scope } from "./scope.js";
import { logger } from "./diagnostics.js";
import { postTask, yield_ } from "./scheduler.js";

/**
 * DOM lifecycle: one module for the three ways the fork creates, observes and
 * recycles nodes.
 *
 *   1. the shared document-level mutation feed (§1) - one observer per
 *      document, shared by the kernel probe, the kernel's permanent rider and
 *      the shell-host watchdog - plus the scoped-observer registry, which
 *      owns the lifetime (but never the mechanism) of the three observers
 *      that stay native for C++ subtree filtering;
 *   2. DOMManager (§2) - the per-shell owner: listeners, created elements,
 *      attribute/style rollbacks, external cleanups, plus the two factories
 *      that used to live in sibling files (`pool`, `watch`);
 *   3. DomPool (§3) - acquire/release recycling for elements whose count is
 *      runtime-dynamic.
 *
 * They were three files and one leak class. A shell had to remember three
 * teardown calls, and two of the three consumers got it wrong: a toast pooled
 * a node it checked out (so the pool's destroy could never remove it) and the
 * history section had no teardown at all. Co-locating them makes "who owns
 * this node" answerable by reading one file, and the manager can now own a
 * pool and a mutation subscription the same way it owns a listener.
 *
 * Scope discipline, deliberately NOT unified: container- and anchor-scoped
 * observers elsewhere stay native. The browser filters their subtrees in C++,
 * while a shared dispatcher would filter every document mutation in JS just to
 * reconstruct that scoping. §1 observes `document.documentElement` once; the
 * container/anchor observers in chrome/inject.js and kernel/kernel.js
 * are separate and stay that way.
 */

/* ==================================================================
   §1 — Shared document-level mutation feed
   ================================================================== */

/** Cap on how long a hidden document's mutation batch stays deferred. */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Sparsity threshold for subscriber-slot compaction. */
const COMPACTION_RATIO = 4;
/**
 * Batch size above which the append switches from apply() to an index walk.
 * apply() spreads the batch onto the call stack and the engine refuses at
 * some argument count with a RangeError - which a mass-DOM-teardown batch
 * can reach, and which would escape the observer callback before the queue
 * flag below is set, silently dropping the whole batch. apply() stays the
 * fast path for every batch we actually see (measurably cheaper than an
 * element-by-element push loop), the walk only takes over where it is safe
 * rather than fast.
 */
const PUSH_APPLY_LIMIT = 65536;

/**
 * Append-only subscriber slots with tombstones. A live subscription is a
 * [handler] tuple; unsubscribe nulls `slot[0]` without reindexing, and the
 * `off` closure captures the TUPLE, never its index. That is the whole point:
 * compaction below reindexes the array, so an index captured at subscribe
 * time can point at a different live subscriber by the time it is called -
 * tombstoning the wrong slot and leaving `live` permanently off by one, which
 * would strand the observer for the life of the page.
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
    if (!slot?.[0]) {
      continue;
    }
    // uBO safeObserverHandler rule: one throwing consumer must never abort
    // the fan-out to its peers in the same batch, nor escape into the page's
    // unhandled-rejection path.
    try {
      slot[0](records);
    } catch (err) {
      logger.error("dom-manager", "A mutation subscriber threw during dispatch", err);
    }
  }

  // uBO compaction rule: tombstoned slots are reindexed once they outnumber
  // live slots 4:1 - a churny page can't grow the slot array without bound.
  if (live > 0 && slots.length > live * COMPACTION_RATIO) {
    let write = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]?.[0]) {
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

/** Release a parked deferred flush and the visibility listener that resumes it. */
function clearDefer() {
  deferAc?.dispose();
  deferAc = null;
  deferHandle?.abort();
  deferHandle = null;
}

function flushPending() {
  clearDefer();
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
  deferAc = new Scope();
  deferHandle = postTask(flushPending, { priority: "background", delay: DEFER_VISIBILITY_CAP_MS });
  document.addEventListener("visibilitychange", onVisibilityChange, { signal: deferAc.signal });
}

/**
 * yield_() hands the browser a frame/task boundary between the mutation
 * batch and the subscriber dispatch, so pending input/paint can interleave
 * (rAF + backstop on visible documents, a MessageChannel task when hidden -
 * see shared/scheduler.js). The facade's fast fallback keeps the jsdom
 * test tick() helper compatible either way.
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
  if (!doc) {
    return;
  }
  if (observer && observedDoc === doc) {
    return;
  }
  // Re-bind when the active document changed underneath us. Never happens
  // in a real page; happens constantly under jsdom test harnesses that
  // install a fresh document per case. The parked defer goes first: it holds
  // a background postTask and a visibilitychange listener resolved against the
  // OLD document, and carrying either across a rebind would dispatch this
  // document's batch on the previous page's visibility timeline.
  observer?.disconnect();
  clearDefer();
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
        logger.error("dom-manager", "Flush scheduling failed:", err);
      });
    }
  });
  // The DOCUMENT node is the target, not document.documentElement. A
  // document-start userscript is evaluated AHEAD of the parser, before the
  // root element exists - that early window is the entire point of instant
  // injection, and the old documentElement target made it fatal: the guard
  // bailed out with no retry, so any subscriber that arrived in that window
  // was wired to a feed that could never produce a record for the life of the
  // page, while its `live` count kept the observer from ever being reclaimed.
  // The document node always exists, and observing it is a strict superset of
  // the old subtree: it additionally reports the root element being inserted
  // or replaced.
  observer.observe(doc, { childList: true, subtree: true });
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
    clearDefer();
  }
}

/**
 * Subscribe to every document mutation, coalesced per task.
 *
 * Returns an unsubscribe function. Pass `signal` to bind the subscription to
 * an owner: DOMManager.watch() does exactly that, which is what keeps a
 * subscriber from outliving the shell that asked for it.
 */
export function onDomMutations(handler, { signal } = {}) {
  ensureObserver();
  const slot = [handler];
  slots.push(slot);
  live += 1;
  const off = () => {
    if (slot[0]) {
      slot[0] = null;
      live -= 1;
    }
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}

/**
 * Scoped-observer registry: the ownership half of every native observer that
 * is deliberately NOT the shared feed. Scoped observers stay native (the
 * browser filters their subtrees in C++, while a shared dispatcher would
 * filter every document mutation in JS just to reconstruct that scoping -
 * and gorhill's December 2025 surveyor fix is the field evidence: one
 * observer designed for its specific lookup beats the generic feed feeding
 * every consumer). What the registry unifies is the lifetime, not the
 * mechanism: each entry releases (disconnects + unlists) on its signal's
 * abort or on an explicit release, and the live labels are inspectable for
 * diagnostics and the leak-radar test.
 *
 * Callers keep disconnecting in their own paths too (settle's done(),
 * the watchdog's cleanup, the session's stopWatching) - release is
 * idempotent, and the inventory entry is what those paths must additionally
 * drop, which is why they go through the returned handle instead of calling
 * disconnect() directly.
 */
const trackedObservers = new Map();

/** Labels of currently live scoped observers, oldest first. */
export function trackedObserverLabels() {
  return [...trackedObservers.values()];
}

export function trackScopedObserver(observer, label, signal) {
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    observer.disconnect();
    trackedObservers.delete(observer);
  };
  trackedObservers.set(observer, label);
  signal?.addEventListener("abort", release, { once: true });
  return release;
}

/* ==================================================================
   §2 — DOMManager
   ================================================================== */

/**
 * First-write-wins rollback records, keyed per ELEMENT rather than per
 * manager. The old per-manager tuple arrays could not see each other, so when
 * two managers marked the same element+attribute the second recorded the
 * first manager's value as the "original" and the final state came down to
 * which one disposed first. With the record shared, the first writer owns the
 * restore and the result is order-independent: the attribute returns to its
 * pre-PlayerForge value exactly once, whoever tears down.
 *
 * WeakMap on the element, so a record can never outlive its node.
 */
const attrOriginals = new WeakMap();
const styleOriginals = new WeakMap();

/**
 * Apply an attribute map to a node: `class` as a property, object `style`
 * merged, `on*` as listeners, everything else as a literal attribute.
 *
 * Shared by DOMManager.createElement and chrome/toolbox.js so the two
 * element factories cannot drift into different attribute rules. `signal`
 * binds `on*` listeners to an owner; without it they are plain listeners and
 * the caller owns their lifetime.
 */
export function applyAttrs(node, attrs, signal) {
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      node.className = value;
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key.length > 2 && key.startsWith("on") && typeof value === "function") {
      // Lowercased: `addEventListener` event types are case-sensitive, so an
      // `onClick` key used to register a listener for "Click" that never
      // fires. Bound to the signal when there is one, so a handler attached
      // through an attribute map obeys the same teardown rule as listen().
      node.addEventListener(key.slice(2).toLowerCase(), value, signal ? { signal } : undefined);
    } else {
      node.setAttribute(key, value);
    }
  }
  return node;
}

/**
 * Per-shell DOM lifecycle manager.
 *
 * Tracks every DOM artifact a shell creates — observers, elements, and
 * inline style/attribute rollbacks — and tears them all down in one call.
 * Prevents the most common class of leak in complex component trees:
 * forgetting to remove one observer or listener in a rarely-tested code
 * path. Teardown bookkeeping itself belongs to the Scope (§2 note on
 * onDispose), so this class holds only what the platform cannot unbind for
 * it: created nodes and rollback records.
 *
 * Event listeners are NOT tracked in a registry: `listen()` hands the
 * manager's own AbortSignal to `addEventListener`, so removal is the
 * platform's job on dispose — no [target, event, handler, opts] tuples to
 * retain, no manual removeEventListener sweep, and the target's listener
 * list drops the entry at abort instead of waiting for GC.
 *
 * The shell owns one manager and lends it to sub-components through
 * `shell.dom`, so a panel section, a subtitle track or an input forge
 * registers against the same lifetime instead of inventing one.
 *
 * Hot-path code (scrub, cue rendering) stays on direct DOM access; the
 * manager only wraps lifecycle-bound operations that need cleanup.
 */
export class DOMManager {
  /** [element] Created elements for automatic remove(). */
  #elements = [];
  /** [el, Map<attr, original>] pairs this manager is responsible for restoring. */
  #attrTouched = [];
  /** [el, Map<prop, original>] pairs this manager is responsible for restoring. */
  #styleTouched = [];
  #scope = new Scope();

  /**
   * Add an event listener that is automatically removed when the manager is
   * destroyed. Returns a disposer for the case where the listener has to go
   * before then (a scoped re-arm, a panel close).
   */
  listen(target, event, handler, opts) {
    if (this.#scope.disposed) {
      return () => {};
    }
    // Normalize the boolean shorthand so `{ signal }` never drops `capture`.
    const options = typeof opts === "boolean" ? { capture: opts } : { ...opts };
    options.signal = this.#scope.signal;
    target.addEventListener(event, handler, options);
    return () => target.removeEventListener(event, handler, options);
  }

  /**
   * Create an element and append it to a parent. The element is automatically
   * removed from the DOM on destroy, and `on*` handlers in the attribute map
   * are removed with it.
   */
  createElement(tag, attrs, parent) {
    if (this.#scope.disposed) return null;
    const doc = parent?.ownerDocument ?? document;
    const node = doc.createElement(tag);
    if (attrs) {
      applyAttrs(node, attrs, this.#scope.signal);
    }
    parent?.appendChild(node);
    this.#elements.push(node);
    return node;
  }

  /**
   * Adopt an element built elsewhere (a multi-node tree assembled by a
   * factory, a node handed over by a feature) so destroy() removes it. The
   * counterpart to createElement for the shapes an attribute map cannot
   * express.
   */
  own(node) {
    if (this.#scope.disposed) return node;
    this.#elements.push(node);
    return node;
  }

  /**
   * Create a recycling pool whose elements are removed when this manager is
   * destroyed. Prefer this over a bare `new DomPool()` for anything owned by
   * a shell: an unmanaged pool has to be destroyed by hand, and forgetting is
   * silent.
   */
  pool(options) {
    const pool = new DomPool(options);
    this.onCleanup(() => pool.destroy());
    return pool;
  }

  /**
   * Subscribe to the shared document mutation feed for the manager's
   * lifetime. Routes to the single document-level observer in §1 - it never
   * opens an observer of its own.
   */
  watch(handler) {
    const off = onDomMutations(handler, { signal: this.#scope.signal });
    this.onCleanup(off);
    return off;
  }

  /**
   * Register a natively-created scoped observer under this manager's
   * lifetime: it disconnects (and unlists) with the manager, and the
   * returned handle releases it early. The observer stays native - this is
   * ownership, not mechanism (see trackScopedObserver).
   */
  trackObserver(observer, label) {
    const release = trackScopedObserver(observer, label, this.#scope.signal);
    this.onCleanup(release);
    return release;
  }

  /**
   * Set an attribute on an element, recording the original value for
   * automatic restoration on destroy. If another owner already recorded the
   * original, that record is kept (first-write wins).
   */
  markAttribute(el, attr, value) {
    if (this.#scope.disposed) return;
    let originals = attrOriginals.get(el);
    if (!originals) {
      originals = new Map();
      attrOriginals.set(el, originals);
      this.#attrTouched.push([el, originals]);
    }
    if (!originals.has(attr)) {
      originals.set(attr, el.getAttribute(attr));
    }
    el.setAttribute(attr, value);
  }

  /**
   * Set an inline style property, recording the original value for
   * automatic restoration on destroy. First-write wins, as above.
   */
  markStyle(el, prop, value) {
    if (this.#scope.disposed) return;
    let originals = styleOriginals.get(el);
    if (!originals) {
      originals = new Map();
      styleOriginals.set(el, originals);
      this.#styleTouched.push([el, originals]);
    }
    if (!originals.has(prop)) {
      originals.set(prop, el.style.getPropertyValue(prop));
    }
    el.style.setProperty(prop, value);
  }

  /**
   * Register an external cleanup callback (a pool destroy, a detached node
   * removal). Runs in reverse registration order on destroy, immediately if
   * the manager is already destroyed.
   */
  onCleanup(fn) {
    this.#scope.onDispose(fn);
  }

  /**
   * Tear down every tracked artifact. Idempotent — safe to call multiple
   * times: Scope.dispose() flips `disposed` before it aborts, so re-entrant
   * calls no-op from the first line on.
   */
  destroy() {
    if (this.#scope.disposed) return;

    // Mark disposed + abort the signal FIRST: every signal-bound listener is
    // released by the platform here, and disposers (cleanups, pools,
    // subscriptions) can no longer register new tracked artifacts.
    this.#scope.dispose();

    // Attribute rollbacks (restore original values).
    for (const [el, originals] of this.#attrTouched) {
      for (const [attr, original] of originals) {
        if (original == null) {
          el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, original);
        }
      }
      // Release the baseline so the NEXT manager to touch this element
      // records a fresh one. The WeakMap is process-wide and first-write-wins,
      // so a surviving entry would suppress a later manager's rollback
      // registration entirely (markAttribute only pushes to #attrTouched when
      // it creates the record). That stranded SHELL_MARKER on the <video>
      // across a shell teardown, and the kernel refuses to adopt a marked
      // video for the life of the document - so a player that the host SPA
      // removed and re-inserted could never be shelled again. Releasing here
      // keeps the documented first-write-wins behaviour for managers that are
      // genuinely live at the same time (both would have to mark before
      // either destroys) without leaking the record past teardown.
      attrOriginals.delete(el);
    }
    this.#attrTouched.length = 0;

    // Style rollbacks (restore original values).
    for (const [el, originals] of this.#styleTouched) {
      for (const [prop, original] of originals) {
        if (original) {
          el.style.setProperty(prop, original);
        } else {
          el.style.removeProperty(prop);
        }
      }
      styleOriginals.delete(el);
    }
    this.#styleTouched.length = 0;

    // Remove created elements.
    for (let i = this.#elements.length - 1; i >= 0; i--) {
      this.#elements[i].remove();
    }
    this.#elements.length = 0;
  }
}

/* ==================================================================
   §3 — DomPool
   ================================================================== */

/**
 * Element pool — acquire/release lifecycle for reusable elements. Caller
 * handles DOM attach/detach; the pool manages reuse and cleanup.
 *
 * Used by the history section, whose card count is runtime-dynamic (watched
 * entries, removals, cross-tab adds) and whose listener lifetime must not
 * ride the card cycle.
 *
 * Two guarantees the old shape lacked, both of which had to be defended
 * against by convention at the call site:
 *
 *   - destroy() removes EVERY node the factory ever produced, not just the
 *     idle ones. A node still checked out at teardown was previously
 *     unreachable, so it could only be cleaned up by whatever happened to
 *     remove its parent.
 *   - release() is idempotent. Releasing the same node twice used to put it
 *     in the free list twice, and two later acquires handed the SAME node to
 *     two cards.
 */
export class DomPool {
  /** Factory: creates a fresh element (not attached to any parent). */
  #factory;
  /** Reset: clears recycled element state (textContent, classes, styles). */
  #reset;
  /** Available elements ready for reuse. */
  #available = [];
  /** Every element this pool produced, idle or checked out, for destroy(). */
  #owned = new Set();
  /** Membership test for #available, so a double release is a no-op. */
  #idle = new WeakSet();

  /**
   * @param {{ factory: () => HTMLElement, reset?: (el: HTMLElement) => HTMLElement, initial?: number }}
   */
  constructor({ factory, reset = (el) => el, initial = 0 }) {
    this.#factory = factory;
    this.#reset = reset;
    for (let i = 0; i < initial; i++) {
      const el = this.#track(factory());
      this.#idle.add(el);
      this.#available.push(el);
    }
  }

  #track(el) {
    this.#owned.add(el);
    return el;
  }

  /** Get a pooled element (reset) or create a new one. */
  acquire() {
    const pooled = this.#available.pop();
    if (pooled) {
      this.#idle.delete(pooled);
      return this.#reset(pooled);
    }
    return this.#track(this.#factory());
  }

  /** Return an element to the pool for reuse. Caller must detach first. */
  release(element) {
    if (!element || this.#idle.has(element)) {
      return;
    }
    this.#idle.add(element);
    this.#available.push(element);
  }

  /** Drop elements beyond `keep` count. Removes excess from DOM. */
  shrink(keep) {
    while (this.#available.length > keep) {
      const el = this.#available.pop();
      this.#idle.delete(el);
      el.remove();
    }
  }

  /** Remove every element this pool produced, idle or checked out. */
  destroy() {
    for (const el of this.#owned) {
      el.remove();
    }
    this.#owned.clear();
    this.#available.length = 0;
  }

  /** Number of elements currently available for reuse. */
  get idle() {
    return this.#available.length;
  }
}
