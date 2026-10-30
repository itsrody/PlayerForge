/**
 * Page runtime.
 *
 * One module for the machinery every engine composes:
 *   1. Scheduling     - postTask/yield_, delay, debounce (time backend)
 *   2. Step lists     - runSteps/runStepsAsync (ordered sequences)
 *   3. Scopes         - Scope (the one teardown primitive)
 *   4. Debug runtime  - logger chatter + the LoAF diagnostic
 *
 * The scheduler façade is single-backend: it composes the platform's own
 * primitives (scheduler.postTask / scheduler.yield, Chromium 95+/129+ and
 * present on the Firefox 159 floor - verified live, including dedicated
 * workers) and adds nothing else - no fallback arm, no
 * capability ladder. Behavioral parity is proven end-to-end via the check
 * harness (check/), not here.
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
  const dropOwnerSignal = () => signal?.removeEventListener("abort", onOwnerAbort);
  const onOwnerAbort = () => {
    dropOwnerSignal();
    ac.abort();
  };
  signal?.addEventListener("abort", onOwnerAbort, { once: true });
  const task = globalThis.scheduler.postTask(() => {
    dropOwnerSignal();
    fn();
  }, { priority, delay: ms, signal: ac.signal });
  // Aborting the task rejects its promise; nobody awaits it, so keep the
  // rejection off the unhandled-rejection path.
  task.catch(() => {});
  return {
    abort: () => {
      dropOwnerSignal();
      ac.abort();
    }
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
 * strand every shell boot whose settle window closed via its own handle. The
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
 * the consumer census: resume's readopt attempt evolved into a bare
 * controller, and every other sub-lifecycle (defer signals, hint caps)
 * already was one. Public class APIs keep their `destroy()` name and
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
   */
  subscribe(cb, { signal } = {}) {
    const handler = (event) => cb(event.detail);
    this.addEventListener(this.#type, handler, { signal });
    const sig = () => this.removeEventListener(this.#type, handler);
    sig[Symbol.dispose] = sig;
    return sig;
  }
}

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

/** Report only the worst few per flush so the console isn't flooded. */
const MAX_REPORT = 3;
/** Only frames that crossed an interaction or took > this long are worth noise. */
const JANK_THRESHOLD_MS = 150;

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
 * kept in step by a caller. Here the visibility flag and the observer are
 * private fields of one instance: the observer can never outlive (or
 * flip on separately from) the flag it serves.
 *
 * Two tiers on purpose: setLogs() flips console chatter alone (the logger
 * façade's enable/disable), while setRuntime() flips logs AND the LoAF
 * jank diagnostic as one unit (the kernel's boot probe and the GM menu
 * toggle route through the setDebugRuntime export). A production user
 * without debug toggled pays exactly zero cost: no observer, no buffered
 * entries, no console I/O.
 *
 * The LoAF surface (Chromium 123+) reports frames delayed beyond 50ms
 * with script attribution, including forced-style/layout breakdowns, so
 * jank - ours or an SDK's - surfaces on the console instead of a
 * tracing session.
 */
class DebugRuntime {
  #logsEnabled = false;
  #observer = null;

  get logsEnabled() {
    return this.#logsEnabled;
  }

  setLogs(on) {
    this.#logsEnabled = on;
  }

  setRuntime(on) {
    // Idempotence guard: mid-flight subscribers (the kernel's storage-watch
    // debug mirror) re-fire on every foreign configs write; a value-neutral
    // flip must not churn the perf observer's install/teardown.
    if (on === this.#logsEnabled) {
      return;
    }
    this.#logsEnabled = on;
    if (on) {
      this.#installPerf();
    } else {
      this.#teardownPerf();
    }
  }

  #installPerf() {
    // Single-backend: the platform's PerformanceObserver decides (LoAF is an
    // entry type) - a realm that lacks either exposes it through the same
    // check. Node, for instance, ships PerformanceObserver without
    // long-animation-frame.
    if (this.#observer ||
        !globalThis.PerformanceObserver?.supportedEntryTypes?.includes("long-animation-frame")) {
      return;
    }
    try {
      this.#observer = new PerformanceObserver((entries) => this.#report(entries));
      this.#observer.observe({ type: "long-animation-frame", buffered: false });
    } catch {
      this.#observer = null;
    }
  }

  #teardownPerf() {
    if (!this.#observer) {
      return;
    }
    this.#observer.disconnect();
    this.#observer = null;
  }

  /** Report only the worst few per flush so the console isn't flooded. */
  #report(entries) {
    const worst = entries.getEntries()
      .filter((e) => e.duration >= JANK_THRESHOLD_MS)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, MAX_REPORT);
    for (const entry of worst) {
      const blocked = entry.blockingDuration ?? 0;
      const forced = entry.scripts?.reduce((sum, s) => sum + (s.forcedStyleAndLayoutDuration ?? 0), 0) ?? 0;
      logger.warn(
        "perf",
        `LoAF ${entry.duration.toFixed(0)}ms (blocking ${blocked.toFixed(0)}ms, forced style+layout ${forced.toFixed(1)}ms)`
      );
      for (const script of entry.scripts ?? []) {
        if (script.name) {
          logger.warn("perf", `  - ${script.name}`);
        }
        if (script.forcedStyleAndLayoutDuration > 0) {
          logger.warn("perf", `     forced style+layout ${script.forcedStyleAndLayoutDuration.toFixed(1)}ms`);
        }
      }
    }
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

/** Flip the debug runtime - console logs and the LoAF diagnostic - as one. */
export function setDebugRuntime(on) {
  debug.setRuntime(on);
}
