/**
 * Host task scheduler facade.
 *
 * One facade over the host's scheduling primitives so consumers never
 * duplicate capability guards across the tree. The Firefox 157 floor always
 * has scheduler.postTask and requestAnimationFrame, so there is no production
 * fallback: the jsdom test host gets a timer-backed polyfill installed once by
 * tests/loader.mjs instead of a branch no Gecko build would take.
 *
 *   postTask(fn, { priority, delay, signal }) → { abort() }
 *     scheduler.postTask (required on the floor)
 *
 *   yield_() → Promise
 *     requestAnimationFrame raced with a hard backstop (visible documents, so
 *     a frame boundary can run layout/paint first) → MessageChannel task
 *     (hidden documents, where rAF does not run)
 *
 * Firefox 157 ships both scheduler.yield() and scheduler.postTask(), but
 * yield() is deliberately NOT used here:
 *
 *   - It is non-Baseline (WICG Prioritized Task Scheduling); relying on it
 *     makes boot depend on an experimental API.
 *   - Per spec it inherits the calling task's scheduling state - including
 *     its abort signal. A postTask task that aborts its own handle (our
 *     whenDomSettled settle timer does exactly that, cancelling its cap
 *     sibling from inside its own callback) leaves an aborted source behind,
 *     so a yield() awaited in that task's continuation rejects with
 *     AbortError. That killed shell boot: #boot() died at its yield point,
 *     leaving no panel, no data-pf-shell mark, and a logger-only error.
 *
 * postTask itself behaves correctly in that same shape (only the yield
 * continuation is poisoned), so postTask is called directly. Every export is
 * a plain function, so the hot path stays inline-friendly.
 */

/**
 * Hard cap on the rAF wait. A visible document should produce a frame within
 * ~16-33ms, but rAF can be starved (minimized/occluded window, headless
 * hosts) without visibilityState flipping to hidden - the backstop keeps
 * yield_() bounded so boot and flushes can never stall on a dead frame.
 */
const RAF_BACKSTOP_MS = 50;

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
 * Cancellable delay: runs `fn` after `ms`, returned fn cancels the pending run.
 * Routes through postTask so the scheduler facade owns the timer (a host task
 * scheduler natively, the harness polyfill in tests; same cancel contract).
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {() => void} cancel
 */
export function delay(fn, ms) {
  const handle = postTask(fn, { delay: ms });
  return () => handle.abort();
}

/**
 * Trailing-edge debounce. Re-calling within the window reschedules. The
 * returned function carries `.flush()` (run a pending call now) and
 * `.cancel()` (drop a pending call) for teardown paths - a trailing write
 * must land before e.g. a filter section dies.
 *
 * @param {Function} fn
 * @param {number} ms
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

/**
 * Resolve on the next task. MessageChannel first: its tasks are not timer-
 * throttled on Gecko, so hidden tabs still make progress; setTimeout is the
 * fallback for hosts without it. Both ports are closed once the message
 * lands - an open port holds a handle on Node's event loop, which would
 * otherwise keep test processes alive after the work is done.
 *
 * @param {Function} resolve
 */
function nextTask(resolve) {
  if (typeof MessageChannel === "function") {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  } else {
    setTimeout(resolve, 0);
  }
}

/**
 * Yield control to the browser so pending paint/input can interleave before
 * non-urgent work (boot between DOM injection and component construction,
 * mutation fan-out before subscriber dispatch).
 *
 * Visible documents resume on the next frame (rAF), which is the boundary the
 * callers' comments promise; a 50ms backstop timer covers frames that never
 * arrive. Hidden documents - where rAF does not run - and hosts without rAF
 * resume on the next task instead. Never reads scheduler.yield (see header).
 *
 * @returns {Promise<void>}
 */
export function yield_() {
  const frameAvailable =
    typeof requestAnimationFrame === "function" &&
    (typeof document === "undefined" ||
      document.visibilityState !== "hidden");
  if (!frameAvailable) {
    return new Promise((resolve) => {
      nextTask(resolve);
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const backstop = setTimeout(done, RAF_BACKSTOP_MS);
    requestAnimationFrame(() => {
      clearTimeout(backstop);
      done();
    });
  });
}
