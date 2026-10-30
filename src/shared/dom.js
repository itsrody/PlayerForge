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
import { Scope, logger, postTask, yield_, Fan } from "./runtime.js";

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
 *
 * Deliberately NOT on the shared Fan (native EventTarget): this feed's
 * dispatch is a compiled contract the platform fan-out cannot express -
 * per-consumer throw isolation (one throwing subscriber must not abort the
 * batch to its peers), the batch argument itself, tombstone compaction
 * driven by a #live count, and liveness-gated observer teardown (EventTarget
 * exposes no listener census). Its audience-snapshot rule simply matches
 * native dispatch by coincidence of design.
 */

/** Cap on how long a hidden document's mutation batch stays deferred. */
const DEFER_VISIBILITY_CAP_MS = 500;
/** Sparsity threshold for subscriber-slot compaction. */
const COMPACTION_RATIO = 4;
/**
 * Batch size above which the append switches from apply() to an index walk.
 * apply() spreads the batch onto the call stack and an engine cap rejects
 * applied-arg batches with a RangeError (measured: V8 at ~124k args, Firefox
 * between 262k and 524k) - which a mass-DOM-teardown batch can reach,
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
 * index). `#live` counts active slots so teardown stays automatic. This
 * replaces a Set-snapshot fan-out: the per-batch `[...subscribers]`
 * allocation is gone from the mutation hot path.
 */
class DomWatch {
  #slots = [];
  #live = 0;

  #observer = null;
  /** Document the observer is currently bound to - see #ensureObserver(). */
  #queued = false;
  /** Pooled records buffers: flush swaps active/recycled instead of allocating. */
  #pendingRecords = [];
  #recycledRecords = [];

  /** Retained handle for the hidden-tab deferred flush; null when none pending. */
  #deferHandle = null;
  /** Abort scope for the visibilitychange resume listener: flush and idle
   *  teardown release it natively instead of pairing add/remove by hand. */
  #deferAc = null;

  #flush() {
    this.#queued = false;
    const records = this.#pendingRecords;
    // Double-buffer swap: hand the drained batch back as the recycled buffer
    // instead of abandoning it for a fresh allocation (nothing longer references
    // `records` once this synchronous fan-out completes, so reuse is safe).
    this.#pendingRecords = this.#recycledRecords;
    // Re-arm the incoming buffer EMPTY. The swap alone leaves the batch
    // delivered two flushes ago inside it, and the observer only ever appends:
    // without this, every flush from the third onward re-delivered stale
    // records alongside the current batch (observed as [1,1,2,2,3] for five
    // single-mutation rounds) - each one costing subscribers a redundant DOM
    // walk over records they had already handled.
    this.#pendingRecords.length = 0;
    this.#recycledRecords = records;
    // Dispatch from a length-hold: tombstones are skipped, and slots appended
    // mid-batch (subscriptions landing during delivery) belong to the next
    // batch - subscribe/unsubscribe can't skew the current audience.
    const slots = this.#slots;
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
    if (this.#live > 0 && slots.length > this.#live * COMPACTION_RATIO) {
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

  #flushPending() {
    this.#deferAc?.abort();
    this.#deferAc = null;
    this.#deferHandle?.abort();
    this.#deferHandle = null;
    this.#flush();
  }

  #onVisibilityChange = () => {
    if (document.visibilityState !== "hidden") {
      this.#flushPending();
    }
  };

  /**
   * Park the pending batch while the document is hidden. A hidden tab's timer
   * and observer still tick; dispatching the (DOM-scanning) subscribers is what
   * should wait, so it is deferred to a background-priority postTask with a hard
   * cap - and resumed the moment the tab is visible again.
   */
  #deferFlushUntilVisible() {
    if (this.#deferHandle) {
      return;
    }
    this.#deferAc = new AbortController();
    this.#deferHandle = postTask(() => this.#flushPending(), { priority: "background", delay: DEFER_VISIBILITY_CAP_MS });
    document.addEventListener("visibilitychange", this.#onVisibilityChange, { signal: this.#deferAc.signal });
  }

  /**
   * Engine-native scheduling advantage: `scheduler.yield()` lets the browser
   * interleave input / paint between the mutation batch and the subscriber
   * dispatch. Unconditional since the yield_ facade shipped single-arm - the
   * direct-flush fallback this comment once claimed rode the dead yield
   * ladder.
   */
  async #scheduleFlush() {
    await yield_();
    if (document.visibilityState === "hidden") {
      this.#deferFlushUntilVisible();
      return;
    }
    this.#flush();
  }

  #ensureObserver() {
    const doc = globalThis.document;
    if (!doc?.documentElement) {
      // A document-start call can outrun the parsed root; each later
      // subscribe re-arms here, so the only cost is a quiet early arm.
      return;
    }
    if (this.#observer) {
      return;
    }
    // Per-frame bundle, hence a fixed document - the cross-document rebind
    // machinery this once had (reseed-on-swapped-doc) exercised only in
    // harnesses that install a fresh document per case.
    this.#observer = new MutationObserver((records) => {
      // Coalesce the batch into the pooled buffer in one place; the browser
      // already arrived with a pooled record list, so this is an append-only
      // copy with no per-record allocation.
      if (records.length < PUSH_APPLY_LIMIT) {
        Array.prototype.push.apply(this.#pendingRecords, records);
      } else {
        for (let i = 0; i < records.length; i++) {
          this.#pendingRecords.push(records[i]);
        }
      }
      if (!this.#queued) {
        this.#queued = true;
        // #scheduleFlush() runs synchronously up to its yield_() await, so the
        // extra queueMicrotask hop the original shape paid bought nothing -
        // the yield already provides the task boundary before dispatch.
        this.#scheduleFlush().catch((err) => {
          logger.error("dom-watch", "Flush scheduling failed:", err);
        });
      }
    });
    this.#observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  /**
   * Drop the observer (and any parked defer) the moment the last subscriber
   * leaves. Idempotent no-op when already detached.
   */
  #stopIfIdle() {
    if (this.#live === 0 && this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
      this.#pendingRecords = [];
      this.#recycledRecords = [];
      this.#slots.length = 0;
      this.#deferAc?.abort();
      this.#deferAc = null;
      this.#deferHandle?.abort();
      this.#deferHandle = null;
    }
  }

  subscribe(handler, { signal } = {}) {
    // An already-aborted signal never fires the teardown listener, so
    // subscribing would pin this slot (and keep the document observer alive)
    // forever. Treat it as a no-op subscription.
    if (signal?.aborted) {
      return () => {};
    }
    this.#ensureObserver();
    const slot = [handler];
    this.#slots.push(slot);
    this.#live += 1;
    const off = () => {
      if (slot[0]) {
        slot[0] = null;
        this.#live -= 1;
        // Release the abort listener on manual unsubscribe too - otherwise the
        // signal retains this closure until it aborts (possibly never).
        signal?.removeEventListener("abort", off);
      }
      this.#stopIfIdle();
    };
    signal?.addEventListener("abort", off, { once: true });
    return off;
  }
}

const domWatch = new DomWatch();

/** Subscribe to the document-wide mutation feed. See DomWatch. */
export function onDomMutations(handler, { signal } = {}) {
  return domWatch.subscribe(handler, { signal });
}

/* - 2. Pooling - */
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
 *
 * Per-frame semantics are a feature, not a gap: the Fullscreen spec gives every
 * document in a nested chain its OWN fullscreenElement, and the gate binds the
 * frame that contains the video - where the HUD and fs-gated gestures live - so
 * an ancestor document entering fullscreen incorrectly claims this frame's
 * state. Negative space: no vendor-prefixed fullscreen API anywhere (the
 * honest floor on every engine), no fullscreenerror listener in this gate (an
 * entry rejection is not a state flip; the HUD-layer handler in shell.js
 * covers remediation), and no polling - the native event IS the single
 * transition source, with the
 * pagehide/pageshow lifecycle listeners re-arming the latch (see init).
 */
export let fs = false;

/** Subscribers notified on a fullscreen state transition (subscribed from a
 *  single underlying native listener; see initFullscreenGate). The audience
 *  is the shared Fan (native EventTarget backend) - the hand-rolled
 *  subscriber Set plus per-signal abort listeners this once carried were
 *  the Fan contract spelled by hand. */
class FsGate {
  #audience = new Fan("fs");
  /** Document the gate is currently bound to, so a repeated init (e.g. double
   *  script eval) re-seeds `fs` without stacking duplicate native listeners. */
  #doc = null;

  #set(next) {
    if (next === fs) {
      return;
    }
    // The exported live binding stays the one document-wide truth; the class
    // writes it so every `import { fs }` reader observes the flip.
    fs = next;
    // The flip breadcrumb: every drag-gesture intent sits behind this gate,
    // so a document fullscreen (the UA window's own F11/fullscreen mode,
    // below) that played a video edge-to-edge while the gate stuck "off"
    // read exactly as this field trace - the flip row is the field's
    // one-line discriminator, no probe needed.
    logger.log("lifecycle", `fullscreen ${next ? "on" : "off"}`);
    this.#audience.emit(next);
  }

  #update() {
    this.#set(this.#truth());
  }

  /**
   * The gate's one truth: ELEMENT fullscreen (fullscreenElement - the native
   * fullscreenchange state) plus DOCUMENT fullscreen. Document fullscreen is
   * the UA window's own fullscreen mode (F11 / the browser fullscreen
   * button): it never fires fullscreenchange, never sets fullscreenElement,
   * and plays the page edge-to-edge on real sites - a direct-embedded video
   * covers the whole screen while the gate alone reads "off". Its native
   * witness is the (fullscreen) media query, which Chromium evaluates for
   * both fullscreen kinds, so the element arm stays the correctness carrier
   * while the query carries the document kind; read per update event, never
   * per press. In a fullscreened cross-origin frame the same window is
   * fullscreen while the frame document still has a null fullscreenElement,
   * so this arm is the one that arms embed gestures there as well.
   */
  #truth() {
    return !!document.fullscreenElement || matchMedia("(fullscreen)").matches;
  }

  /**
   * This is the ONLY place that touches fullscreen: it owns the `fs` value AND
   * the single underlying `fullscreenchange` listener. Every other fs-conditioned
   * path reads `fs` directly or subscribes to transitions via subscribeFullscreen,
   * so there is one gate and one transition source regardless of shell count.
   */
  init() {
    // Re-seed every call (the gate's own premise: a double script eval
    // re-seeds without stacking duplicate native listeners). The injectable
    // `doc` parameter this once carried died with the jsdom harness: the
    // bundle is per-frame and `document` cannot change underneath it.
    this.#set(this.#truth());
    if (this.#doc) {
      return;
    }
    this.#doc = document;
    document.addEventListener("fullscreenchange", () => this.#update());
    // Document fullscreen transitions through the fullscreenchange listener
    // never surface: the UA window resizes in and out of its fullscreen mode,
    // and that resize is the only native event carrying the flip. The same
    // seat re-arms the gate after a missed element flip.
    const view = document.defaultView;
    if (view) {
      view.addEventListener("resize", () => this.#update(), { passive: true });
      // Lifecycle re-arm, the one hole the transition event cannot close: the
      // latch is a plain boolean on a document object bfcache keeps alive with
      // these listeners still attached, while Chromium exits fullscreen on
      // navigation and never stores a fullscreen document in the cache - so a
      // persisted pagehide carrying fs=true is a stale future (restore will not
      // fire fullscreenchange to correct it). Force-false on persisted pagehide;
      // re-seed from the live document on every restore so the latch can only
      // ever claim state the document actually holds. Non-persisted navigations
      // reconfigure the whole frame anyway, and a real fullscreen exit lands
      // its own fullscreenchange - both stay unplumbed here. pagehide/pageshow
      // fire at the Window and do not traverse the DOM tree, so the pair binds
      // the document's view, not the document.
      view.addEventListener("pagehide", (event) => {
        if (event.persisted && fs) {
          fs = false;
        }
      });
      view.addEventListener("pageshow", () => this.#update());
    }
  }

  /**
   * Subscribe to fullscreen state transitions (fires only on an actual flip,
   * before the gates' consumers observe the new `fs`). Returns an unsubscribe
   * function; pass `signal` to have it torn down automatically.
   */
  subscribe(cb, signal) {
    return this.#audience.subscribe(cb, { signal });
  }
}

/** Subscribe to fullscreen state transitions (fires only on an actual flip,
 *  before the gates' consumers observe the new `fs`). Returns an unsubscribe
 *  function; pass `signal` to have it torn down automatically. */
const fsGate = new FsGate();

export function initFullscreenGate() {
  fsGate.init();
}

export function subscribeFullscreen(cb, signal) {
  return fsGate.subscribe(cb, signal);
}

/**
/**
 * The ONE layout-viewport read, real-world-first: the ROOT ELEMENT's
 * laid-out box is what the browser actually presented - the geometry every
 * candidate rect and gesture clientX lives in - while
 * innerWidth/innerHeight are REPORTED dims that can disagree with it
 * (engine-specific scrollbar-inclusive innerWidth gutters, 0 in instrumented
 * embeds and headless, UA resize races). The root box leads; the reported
 * arm stays the fallback for a synthetic/unstyled root; zero stays a
 * runtime fact that makes consumers PERMISSIVE, never stranding a player.
 * Both faces consume this: the kernel's viewport-presence gate (candidate
 * rect against the layout viewport, pre-shell - the fill-box identity
 * below cannot serve it, whose lifetime starts with the shell and whose
 * inline answer is the container's own box, narrower than the viewport),
 * the fs window fallback here, and the inline gesture-zone width.
 * Consumers read-and-discard synchronously; the fresh pair per call keeps
 * no pooled-object trap alive across call sites.
 */
export function layoutViewport() {
  const root = document.documentElement;
  return {
    width: (root?.clientWidth || window.innerWidth) || 0,
    height: (root?.clientHeight || window.innerHeight) || 0
  };
}

/**
 * The ONE fill-box identity for every geometry consumer (scrub gain
 * normalize, cover scale, pan clamp, fs edge zones). Inline reads the
 * container; fullscreen reads the ELEMENT the UA is actually fullscreening -
 * `document.fullscreenElement.getBoundingClientRect()` - which is the
 * device's real screen edge-to-edge where viewport-fit=cover merged on the
 * active frame (Android Chromium expands the fs element under the cutout, so
 * the safe area is INCLUDED), and the safe-rect-fitted frame otherwise: the
 * UA's own letterbox can never spill through an element rect, which is why
 * the previous window-vs-screen gap heuristic (FS_BOX_GAP_PX epsilon) had a
 * reason to exist at all. No event the UA fires - fullscreenchange, resize,
 * orientation change - reports the letterbox shape directly; the rect is the
 * only truthful witness, and it answers the embed shape too (the host doc
 * letterboxes the IFRAME while the in-frame fs element obeys its own frame
 * viewport - rect = the gesture space clientX lives in, so fs edge-zone and
 * scrub width calibration align with the coordinates every consumer reads).
 * UA window fullscreen (F11) presents no element - the window box is the
 * fallback (and the only answer headless can read, screen.width being 0
 * there). The pool keeps the scrub/pinch hot path allocation + layout free:
 * one getBoundingClientRect per invalidation, and fs flips re-target the RO
 * at the fs element so its own box changes (entry ratio snap, device zoom)
 * re-read instead of floating stale.
 *
 * The rect is complete (x/y origin added to the pooled dims) because its
 * one non-gesture consumer anchors against it, not merely sizes: the
 * subtitle renderer derives the displayed video picture within this rect
 * and lays its slots relative to it (see subtitles.js). Origin discipline:
 * the element arm reads it off the element's own rect in the same pass; the
 * inline arm reads the container's rect origin beside its client dims -
 * clientWidth/Height stay the dims source because they are UNtransformed
 * layout numbers (a site-scaled container must keep its untransformed size
 * for zoom/fill math even though GBCR reports the scaled box); the window
 * fallback settles at (0,0) since every GBCR rect the consumers couple with
 * this origin is viewport-relative. Deltas between two GBCR reads in the
 * same frame stay honest under any ancestor transform, which is what the
 * picture consumer actually couples.
 *
 * The slice's validity flips are broadcast: subscribe() rides the ONE fan-out
 * owner (Fan) armed at exactly the three invalidate sites the pool already
 * runs (container RO, fs re-target, orientation change). Read-and-discard
 * per flow stays the consumption shape for the gesture consumers (every
 * consumer re-reads in its own event flow - nobody parks a pooled box); the
 * broadcast exists for the consumer that must RE-RENDER when the box moves
 * without arming duplicate observers of the same three facts - the audit
 * (subtitles reference pass) found that path unowned.
 */
export class ReferenceBox {
  #container;
  #box = { x: 0, y: 0, width: 0, height: 0 };
  #valid = false;
  #ro = null;
  /** The one fan-out: change ticks for re-render consumers. */
  #ticks = new Fan("reference-box");

  constructor(container, signal) {
    this.#container = container;
    this.#ro = new ResizeObserver(() => {
      this.#valid = false;
      this.#ticks.emit();
    });
    this.#ro.observe(container);
    signal.addEventListener("abort", () => this.#ro.disconnect(), { once: true });
    subscribeFullscreen((active) => {
      this.#valid = false;
      // Re-target the observed element on each fs entrance; the exit
      // disconnects so the fs element's detached obs don't fire again.
      this.#ro.disconnect();
      if (active) {
        const fsEl = document.fullscreenElement;
        if (fsEl) {
          this.#ro.observe(fsEl);
        }
      }
      // The flip itself is a tick even when the dims happen to match: the
      // subscriber's position answer switches arms (element vs container),
      // and a slot anchored before the flip painted against the old arm.
      this.#ticks.emit();
    }, signal);
    screen.orientation.addEventListener("change", () => {
      this.#valid = false;
      this.#ticks.emit();
    }, { signal, passive: true });
    // Scroll is the fourth invalidation source: it repositions the rect's
    // viewport ORIGIN without firing any size signal, fs flip, or
    // orientation event. The cache predates this class's origin (its
    // pooled-for consumers were size-only, so the omission was invisible);
    // the one anchor consumer found the hole — a below-the-fold player
    // booted against the pre-scroll stage, and a scrolled-in video and a
    // stale stage stopped overlapping, so the picture clip collapsed and
    // slots anchored at the layer's own origin. Capture-phase scroll (no
    // bubbling), passive: the read is inside get().
    document.addEventListener("scroll", () => {
      this.#valid = false;
      this.#ticks.emit();
    }, { signal, capture: true, passive: true });
  }

  /** Subscribe a callback to box-change ticks; signal-scoped teardown. */
  subscribe(cb, { signal } = {}) {
    return this.#ticks.subscribe(cb, { signal });
  }

  get() {
    if (this.#valid) {
      return this.#box;
    }
    if (fs) {
      const fsEl = document.fullscreenElement;
      const rect = fsEl?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        this.#box.x = rect.x;
        this.#box.y = rect.y;
        this.#box.width = rect.width;
        this.#box.height = rect.height;
      } else {
        ({ width: this.#box.width, height: this.#box.height } =
          layoutViewport());
        // Viewport-relative read domain (every GBCR the rect couples with is
        // viewport-relative too - GBCR is viewport coords, not page coords).
        this.#box.x = 0;
        this.#box.y = 0;
      }
    } else {
      this.#box.width = this.#container.clientWidth;
      this.#box.height = this.#container.clientHeight;
      const rect = this.#container.getBoundingClientRect();
      this.#box.x = rect.x;
      this.#box.y = rect.y;
    }
    this.#valid = true;
    return this.#box;
  }
}
