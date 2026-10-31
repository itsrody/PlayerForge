/**
 * Page runtime.
 *
 * One module for the machinery every engine composes:
 *   1. Scheduling     - postTask/yield_, delay, debounce (time backend)
 *   2. Step lists     - runSteps/runStepsAsync (ordered sequences)
 *   3. Scopes         - Scope (the one teardown primitive)
 *   4. Debug runtime  - logger chatter
 *
 * The scheduler façade is single-backend: it composes the platform's own
 * primitives (scheduler.postTask / scheduler.yield, Chromium 95+/129+ and
 * present on the Firefox 159 floor - verified live, including dedicated
 * workers) and adds nothing else - no fallback arm, no
 * capability ladder. Behavioral parity is proven end-to-end via the check
 * harness (check/), not here.
 *
 * Retirement audit, re-probed on the shipping engine (Firefox 159, live):
 * nothing upstream is sunsetting - the surface is still a WICG draft and
 * neither MDN (restated 2025) nor Chrome's deprecation ledger records any
 * move against it; the engine honors the priority tiers natively
 * (deterministic user-blocking > user-visible > background landing order).
 * The façade itself cannot retire into nothing either: it is the one owner
 * of the dead-handle guard, the owner-signal release, the swallowed task
 * rejection and the abort() contract that delay/debounce and every boot
 * deadline share. Even its two-controller shape is measured, not chosen: an
 * AbortSignal abort landing inside the task body rejects the COMPLETED
 * task's promise (live on 159), so one controller driving the task signal
 * directly would bucket every successful fire into the AbortError rejection
 * the façade only exists to swallow - the cancel signal and the release
 * signal stay separate for that measured reason.
 *
 * Hot-path exports stay plain functions at module scope (every engine's
 * optimizing tier inlines them without shape-change penalties); only
 * stateful runtime behavior lives in
 * classes/examples below.
 */
/* - 1. Scheduling - */
/**
 * Native task scheduler facade.
 *
 * One façade over the platform's scheduling primitives so consumers never
 * duplicate the owner-signal abort choreography across the tree:
 *
 *   postTask(fn, { priority, delay, signal }) → { abort() }
 *     scheduler.postTask (shipped on every engine at the 159 floor)
 *
 *   yield_() → Promise
 *     scheduler.yield (same surface; the one engine divergence is guarded
 *     inside it - an inherited-abort rejection the facade swallows)
 *
 * Every export is a plain function so the engine's optimizing tier can keep
 * the fast path inline (monomorphic, shape-stable per call).
 */

/**
 * Schedule `fn` to run after `delay` ms at the given priority.
 *
 * Returns a `{ abort() }` handle that cancels the pending task. Abort is real,
 * not cosmetic: the handle owns an AbortController and also follows `signal`
 * when one is passed, so pagehide/kernel teardown lands the task immediately
 * instead of letting it fire (or leak) later. The abort rejection of the
 * underlying postTask promise is swallowed - callers never await it.
 *
 * @param {Function} fn
 * @param {{ priority?: string, delay?: number, signal?: AbortSignal }} opts
 * @returns {{ abort(): void }}
 */
export function postTask(fn, { priority = "user-visible", delay: ms = 0, signal } = {}) {
  // An owner signal that is already aborted means the caller is torn down. A
  // listener attached to an aborted signal never fires, so without this the
  // task would still schedule (and run post-teardown); hand back a dead handle.
  if (signal?.aborted) {
    return { abort() {} };
  }
  const ac = new AbortController();
  // The owner-signal release runs on every end of the task - firing, handle
  // abort, owner abort. A page-lifetime owner scope (the kernel's) must never
  // pin a finished task's controller, so the release signal is the native
  // detach: the platform drops the owner listener when it aborts, whichever
  // path drove it. AbortSignal.any would compose the signals instead, but a
  // source subscription in the any() composite lives until the owner aborts -
  // the exact leak this bridge avoids - so the release stays one controller.
  const release = new AbortController();
  const end = () => {
    release.abort();
    ac.abort();
  };
  signal?.addEventListener("abort", end, { signal: release.signal });
  const task = globalThis.scheduler.postTask(() => {
    release.abort();
    fn();
  }, { priority, delay: ms, signal: ac.signal });
  // Aborting the task rejects its promise; nobody awaits it, so keep the
  // rejection off the unhandled-rejection path.
  task.catch(() => {});
  return {
    abort: end
  };
}

/**
 * Yield control to the browser so pending paint/input can interleave before
 * non-urgent work (mutation fan-out, large parses). Resolves on the next
 * scheduler slot.
 *
 * Chromium and Firefox 159 disagree on one shape, and this facade is the single
 * guard: `scheduler.yield()` inherits the *current task's* signal, so a
 * continuation that wakes inside a postTask task whose signal was aborted
 * mid-flight (DomSettleWait's done() aborts its own settle handle by design;
 * the wake-up continuation therefore runs inside an already-aborted task)
 * rejects with AbortError on Firefox but resolves on Chromium - which would
 * strand every shell boot whose settle window closed via its own handle.
 * Re-probed live on the Firefox 159 page realm (Oct 2026) and the divergence
 * is exactly as recorded: the continuation of a yield whose enclosing task
 * had already aborted its own signal never resumes (the promise rejects
 * AbortError), while a yield parked BEFORE an external abort resolves - so
 * the guard remains load-bearing and Chromium parity stays the contract. The
 * rejected alternatives: rethrowing treats internal bookkeeping as teardown and
 * kills the boot; threading owner signals through every yield_() call site
 * forks the one cooperative backend three ways. Chromium parity is the
 * contract - yield always lands on the next scheduler slot. A non-AbortError
 * rejection is a real scheduler complaint and propagates.
 *
 * @returns {Promise<void>}
 */
export function yield_() {
  return globalThis.scheduler.yield().catch((err) => {
    if (err?.name !== "AbortError") {
      throw err;
    }
    return new Promise((res) => {
      // A fresh controller: the aborted task's signal is not inherited, so the
      // slot lands regardless of what the wake-up task did to its own signal.
      globalThis.scheduler.postTask(() => res(), {});
    });
  });
}

/** Cancellable delay: runs `fn` after `ms`, returned fn cancels the pending run.
 *  Routed through postTask so the scheduler façade owns the timer (the
 *  platform task scheduler; same cancel contract). */
export function delay(fn, ms) {
  const handle = postTask(fn, { delay: ms });
  return () => handle.abort();
}

/**
 * Trailing-edge debounce. Re-calling within the window reschedules. The
 * returned function carries `.flush()` (run a pending call now) and
 * `.cancel()` (drop a pending call) for teardown paths - a trailing write
 * must land before e.g. a filter section dies.
 */
export function debounce(fn, ms) {
  let cancel = null;
  let pendingArgs = null;
  const debounced = (...args) => {
    pendingArgs = args;
    cancel?.();
    cancel = delay(() => {
      cancel = null;
      fn(...pendingArgs);
      pendingArgs = null;
    }, ms);
  };
  debounced.flush = () => {
    if (!cancel) {
      return;
    }
    cancel();
    cancel = null;
    fn(...pendingArgs);
    pendingArgs = null;
  };
  debounced.cancel = () => {
    cancel?.();
    cancel = null;
    pendingArgs = null;
  };
  return debounced;
}

/* - 2. Step lists - */
/**
 * Ordered lifecycle step lists.
 *
 * Every boot and teardown sequence in the tree is the same shape - "run these
 * steps, in this order". These helpers are the one place that shape lives, so
 * the order stays visible as a data list instead of being implied by the
 * statement order of a long method body. Each step is a thunk that closes over
 * its own context.
 *
 * `runSteps` is synchronous: teardown must finish in the same turn (the owner
 * may be detached by the time it returns), so it never yields. `runStepsAsync`
 * awaits its steps in order and, with `yieldBetween`, hands control to the
 * event loop between them (past the first) - used where a first-call
 * construction burst would otherwise wedge input. Its resolved value is the
 * per-step results, so a caller can collect handles to tear down later.
 */


/**
 * @param {Array<() => void>} steps
 */
export function runSteps(steps) {
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
  }
}

/**
 * @param {Array<() => any>} steps
 * @param {{ yieldBetween?: boolean }} [opts]
 * @returns {Promise<any[]>}
 */
export async function runStepsAsync(steps, { yieldBetween = false } = {}) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    if (yieldBetween && i > 0) {
      await yield_();
    }
    results.push(steps[i]());
  }
  return results;
}
/* - 3. Scopes - */
/**
 * Lifecycle scope: one AbortController with an idempotent dispose and
 * reverse-order cleanup registration.
 *
 * This is the single teardown primitive classes compose instead of
 * hand-rolling a `#destroyed` boolean + a pile of `?.disconnect()` sweeps:
 *
 *   - `signal`    — hand straight to `addEventListener`/`postTask`/observers
 *                   that accept `{ signal }`; abort tears them down natively.
 *   - `onDispose(fn)` — reverse-registration-order cleanup for everything
 *                   that has no signal form (elements, rollbacks, stores).
 *                   Runs immediately if the scope is already disposed.
 *   - `dispose()` — idempotent: marks disposed FIRST (re-entrant destroy
 *                   calls no-op), aborts the signal, then runs disposers.
 *
 * Disposer errors are isolated AND logged - one throw never strands the
 * rest, and the throw surfaces rather than vanishing (the dispose loop's
 * silent `catch {}` was the dom-watch policy's isolation without its
 * breadcrumb; a teardown-throw was equally invisible to the debug flip and
 * the check forensics). Sub-lifetimes needing no disposer registry stay
 * bare native AbortControllers - the child() composition facility died in
 * the consumer census: every sub-lifecycle (defer signals, hint caps) was
 * already a bare one. Public class APIs keep their `destroy()` name and
 * simply delegate here.
 */
export class Scope {
  #controller = new AbortController();
  /** Lazily allocated; null after dispose. */
  #disposers = null;
  #disposed = false;

  /** AbortSignal for `{ signal }` registration on any abortable API. */
  get signal() {
    return this.#controller.signal;
  }

  /** True from the start of dispose() onward. */
  get disposed() {
    return this.#disposed;
  }

  /**
   * Register a cleanup callback. Runs at dispose() in reverse registration
   * order; if the scope is already disposed it runs synchronously now -
   * carrying the loop's isolated-error handling, so a late registration
   * can neither outlive its owner nor strand its registrant's flow.
   */
  onDispose(fn) {
    if (this.#disposed) {
      this.#runDisposer(fn);
      return;
    }
    (this.#disposers ??= []).push(fn);
  }

  /** The one isolation site: catch, log, never rethrow. */
  #runDisposer(fn) {
    try {
      fn();
    } catch (err) {
      error("scope", "A disposer threw during teardown", err);
    }
  }

  /** Idempotent teardown: mark disposed, abort, run disposers reversed. */
  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#controller.abort();
    const disposers = this.#disposers;
    this.#disposers = null;
    if (disposers) {
      for (let i = disposers.length - 1; i >= 0; i--) {
        this.#runDisposer(disposers[i]);
      }
    }
  }
}

/* - 3.5 Fan-out - */

/**
 * The ONE plain-fan-out owner: a single native EventTarget carrying one
 * event per instance, dispatching one payload to the current audience.
 * Every subscriber-set + notify-loop + manual abort-listener-pair machine
 * routes through this - the platform supplies the semantics those machines
 * hand-parsed: an already-aborted signal is a no-op subscription (the DOM
 * spec adds nothing for it; the manual "signal?.aborted" guard in three
 * files spelled this), a live signal's listener is removed at its abort
 * with no add/remove pair, and dispatch snapshots the audience so
 * mid-dispatch subscriptions join the next batch (dom-watch documents the
 * same rule as its length-hold). Dispatch is synchronous and, as with any
 * uncaught-through-native-dispatch throw, is reported to the page error
 * surface rather than aborting the emit call. The event type is
 * instance-internal - it never escapes this class, so the tag is a call-site
 * derived label (debug visibility in devtools), not a hand-spelled contract.
 *
 * Why no platform primitive replaces it: Observable / EventTarget.when()
 * (the W3C "better addEventListener") is Chromium 135+ only and Mozilla
 * holds a negative standards position on it (bug 1871732 - complexity,
 * venue, API design), so this floor has no native fan-out subscription to
 * adopt. Two pooling candidates were measured and declined on Firefox 159:
 * a pooled CustomEvent re-owned per emit via defineProperty runs
 * ~680ns/emit against ~1690ns for the fresh event - but a listener that
 * synchronously re-emits mid-dispatch throws InvalidStateError on a pooled
 * instance (an in-dispatch event cannot re-dispatch) while a fresh event
 * re-enters cleanly, and the settings bus is exactly that re-entrant shape
 * (foreign-merge journeys can re-enter subscribe-listened setters). The
 * ~1us/emit saved is noise against the real consumers: the reference-box
 * tick fans at most tens of times per second and the echo row budgets
 * 1000 emissions strictly within 400ms dominated by delivery, not
 * allocation. Fresh allocation stays.
 *
 * The subscribe handle is a Disposable: the same function it always was
 * (no census consumer ever called it - every teardown rides the signal)
 * carrying [Symbol.dispose] (fully-shipped Firefox 134; using/DisposableStack
 * verified live on the 159 page realm), so a future consumer can take a
 * subscription under `using` without any Fan-side second teardown path.
 */
export class Fan extends EventTarget {
  #type;

  constructor(tag) {
    super();
    this.#type = `pf:fan-${tag}`;
  }

  /** Fan one payload out synchronously. */
  emit(payload) {
    this.dispatchEvent(new CustomEvent(this.#type, { detail: payload }));
  }

  /**
   * Subscribe a callback to the payload; returns the unsubscribe handle - a
   * callable, and a Disposable ([Symbol.dispose] tears the subscription).
   * Callbacks receive the dispatched value positionally, matching the
   * notify-loop signatures this replaces.
   *
   * The handle tears down through the release-controller pattern every other
   * machine rides: one abort controller owns the listener's signal, the
   * handle aborts it (the platform drops the listener), an owner `signal`
   * rides the same release via the `once`+`signal` composition. No manual
   * `removeEventListener` anywhere in the class - and an already-aborted
   * owner signal is the no-op subscription the docstring records, returning
   * a dead handle instead of pinning a listener that could never fire or
   * detach.
   */
  subscribe(cb, { signal } = {}) {
    if (signal?.aborted) {
      return () => {};
    }
    const handler = (event) => cb(event.detail);
    const release = new AbortController();
    this.addEventListener(this.#type, handler, { signal: release.signal });
    signal?.addEventListener("abort", release.abort.bind(release), {
      once: true,
      signal: release.signal
    });
    const sig = () => release.abort();
    sig[Symbol.dispose] = sig;
    return sig;
  }
}

/* - 3.6 GC cleanup - */
/**
 * The ONE GC-backed cleanup net: a native FinalizationRegistry (floor-real,
 * spec-stable, no arms) so a machine's forgotten tear-down path cannot take
 * a live resource with it. The gap no existing owner closes: §5.5 routes
 * every teardown through the machine's own choreography (signal abort,
 * explicit stop), but a mid-flight path can DROP the owner record without
 * running the release - the strong-held record then keeps the resource
 * (an open pipe port is the live shape) after every reader is gone,
 * invisible to the owning abort. When the dropped record is next collected,
 * the registry fires the release itself - the platform is the watcher.
 *
 * Contract every subscriber holds:
 *  - Enroll the OWNER RECORD, never the resource. The release closure
 *    captures the resource, and the registry holds that closure strongly
 *    until release or unenroll - so the watched object must be a wrapper
 *    the holder can drop one hop above the resource (a pipe record, not
 *    the port), or the net can never fire. The subscriber census: the
 *    ContextPipe's pipe record (the pf context protocol). Declined verdicts
 *    live in AGENTS section 3.
 *  - A release is idempotent and resurrection-free: close(), terminate(),
 *    disconnect(), abort() state - nothing reads the spent resource.
 *  - The net is a SAFETY NET, not a second teardown root: §5.5 signal
 *    scopes stay the one teardown choreography every machine carries; the
 *    net only guarantees that a forgotten path cannot leak forever, and it
 *    says so when it does - a release firing posthumously is warn()'d (an
 *    exceptional path, surfaces even in silent mode), the same audit trail
 *    the debug forensics read.
 *
 * Page-lifetime singles (the kernel tap, the module-level subtitle
 * transport) are declined subscribers: their records are document-lifetime,
 * so nothing can be dropped mid-flight without the document taking
 * everything with it - no forgotten shape exists for a net to catch. And
 * the one real cross-document shape - a MessagePort peer dying with its
 * document - is unwitnessable by design: the surviving port's record is
 * still strongly held here, so collection never fires; the records' own
 * activity sweeps stay that cleanup's owner.
 */
export class GcCleaner {
  /** Held value and unregister token in one object per enrollment. */
  #registry = new FinalizationRegistry((entry) => entry.collect());

  /**
   * Enlist one owner record for the net. `watched` is the droppable record
   * (see the contract), `release` the resource teardown it captures, and
   * `signal` an optional owner-lifecycle abort arming BEFORE the record is
   * ever dropped. Whichever arm fires first runs the release exactly once.
   * Returns a Disposable handle: drop() runs now (the explicit healthy
   * path), [Symbol.dispose] parity like Fan's handle.
   */
  enlist(watched, release, { signal, label = "resource" } = {}) {
    let done = false;
    const token = {};
    // The internal release controller: the abort-arm listener detaches
    // natively on whichever path ends the enrollment (the posthumous fire
    // cannot reach it another way), so a released record's closure stops
    // pinning the resource at the moment the resource is spent.
    const releaseCtrl = new AbortController();
    const run = (posthumous) => {
      if (done) {
        return;
      }
      done = true;
      releaseCtrl.abort();
      // Order-free against the GC fire: an unregister after the callback
      // fired is a false return, before it cancels the fire.
      this.#registry.unregister(token);
      try {
        release();
      } catch (err) {
        error("gc-cleaner", `${label}: release threw during teardown`, err);
      }
      if (posthumous) {
        warn("gc-cleaner", `${label}: release ran posthumously - a holder dropped its record without teardown`);
      }
    };
    token.collect = () => run(true);
    signal?.addEventListener("abort", () => run(false), {
      once: true,
      signal: releaseCtrl.signal
    });
    this.#registry.register(watched, token, token);
    const handle = () => run(false);
    handle[Symbol.dispose] = handle;
    return handle;
  }
}

export const gcCleaner = new GcCleaner();

/* - 4. Debug runtime - */
const PREFIX = "[PlayerForge]";

const STYLES = {
  kernel: "color: #FF6B35; font-weight: bold",
  shell: "color: #4ECDC4; font-weight: bold",
  warn: "color: #F38181; font-weight: bold",
  error: "color: #AA0000; font-weight: bold"
};

/**
 * Chatter (log/group) is compiled out at runtime until the debug flag flips -
 * page-facing cost of a disabled log call is one boolean check, no string
 * building, no console I/O. warn/error stay unconditional: they mark
 * exceptional paths and must surface even in silent mode.
 */

function styleFor(channel) {
  return STYLES[channel] || "";
}

function log(channel, ...args) {
  if (!debug.logsEnabled) {
    return;
  }
  console.log(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", styleFor(channel), ...args);
}

function group(channel, label) {
  if (!debug.logsEnabled) {
    return;
  }
  console.group(`%c${PREFIX}%c[${channel}] ${label}`, "color: #FF6B35", styleFor(channel));
}

function groupEnd() {
  console.groupEnd();
}

function warn(channel, ...args) {
  console.warn(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.warn, ...args);
}

function error(channel, ...args) {
  console.error(`%c${PREFIX}%c[${channel}]`, "color: #FF6B35", STYLES.error, ...args);
}

/**
 * One owner of the debug runtime state. Previously the log flag lived in
 * logger.js and a second `enabled` flag lived beside the LoAF diagnostic,
 * synced externally by setDebugRuntime - two states that could only be
 * kept in step by a caller. Here the flag is one private field of one
 * instance and every flip converges on it.
 *
 * The LoAF jank arm was retired as dead weight, probed live on the
 * shipping floor: Firefox 159 exposes the entry type in neither realm -
 * page or worker - and the harness realms ship no entries either, so the
 * supportedEntryTypes gate kept the diagnostic permanently unarmed
 * everywhere this userscript runs. Its console formatting (worst-few per
 * flush, blocking/style breakdowns) was the only consumer of the
 * PerformanceObserver surface. A return would be a redesign decision with
 * its own measurement, not a dormant gate.
 */
class DebugRuntime {
  #logsEnabled = false;

  get logsEnabled() {
    return this.#logsEnabled;
  }

  setLogs(on) {
    this.#logsEnabled = on;
  }

  // setRuntime collapsed onto setLogs when the LoAF arm retired - the
  // observer was the second half of the two-tier split, and there is
  // nothing left to arm separately from the console flag.
  setRuntime(on) {
    this.setLogs(on);
  }
}

const debug = new DebugRuntime();

export const logger = {
  log,
  warn,
  error,
  group,
  groupEnd,
  /** Enable chatter - wired to the #pf-debug hash / debug setting in kernel. */
  enable() {
    debug.setLogs(true);
  },
  disable() {
    debug.setLogs(false);
  },
  get enabled() {
    return debug.logsEnabled;
  }
};

/** Flip the debug runtime - the one console flag (the LoAF arm retired). */
export function setDebugRuntime(on) {
  debug.setRuntime(on);
}
