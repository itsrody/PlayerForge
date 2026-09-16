/**
 * Gecko-native task scheduler.
 *
 * Wraps the best available Firefox scheduling primitive per call site so
 * consumers never duplicate `typeof scheduler?.postTask` guards:
 *
 *   postTask(fn, { priority, delay, signal }) → { abort() }
 *     scheduler.postTask (Firefox 101+) → setTimeout fallback
 *
 *   yield() → Promise
 *     scheduler.yield (Firefox 142+) → requestAnimationFrame → noop
 *
 *   scheduleIdle(fn, { timeout }) → Promise
 *     requestIdleCallback (Firefox 55+) → microtask fallback
 *
 * Detection runs once at module load. Every export is a plain function
 * (no class) so SpiderMonkey can inline the fast path.
 */

/* ------------------------------------------------------------------ */
/*  Capability detection (one-shot, frozen)                           */
/* ------------------------------------------------------------------ */

const HAS_POST_TASK =
  typeof globalThis.scheduler?.postTask === "function";

const HAS_YIELD =
  typeof globalThis.scheduler?.yield === "function";

/* ------------------------------------------------------------------ */
/*  postTask — delayed execution with priority                        */
/* ------------------------------------------------------------------ */

/**
 * Schedule `fn` to run after `delay` ms at the given priority.
 *
 * Returns a handle with `abort()` that cancels the pending task. The
 * handle is API-agnostic: callers never see TaskController vs numeric
 * timer ID differences.
 *
 * @param {Function} fn
 * @param {{ priority?: string, delay?: number, signal?: AbortSignal }} opts
 * @returns {{ abort(): void }}
 */
export function postTask(fn, { priority = "user-visible", delay: ms = 0, signal } = {}) {
  if (HAS_POST_TASK) {
    const handle = globalThis.scheduler.postTask(fn, {
      priority,
      delay: ms,
      signal
    });
    return { abort: () => handle.abort?.() };
  }
  // setTimeout fallback — dead code on Firefox 157+, kept for jsdom tests.
  const id = setTimeout(fn, ms);
  return { abort: () => clearTimeout(id) };
}

/* ------------------------------------------------------------------ */
/*  yield — cooperative yield to the browser                          */
/* ------------------------------------------------------------------ */

/**
 * Yield control to the browser so pending paint/input work can run.
 * Resolves on the next task (postTask / rAF / microtask depending on
 * what the runtime supports).
 *
 * @returns {Promise<void>}
 */
export const yield_ = HAS_YIELD
  ? () => globalThis.scheduler.yield()
  : typeof requestAnimationFrame === "function"
    ? () => new Promise((r) => requestAnimationFrame(() => r()))
    : () => Promise.resolve();

// ESM export alias — `yield` is reserved in strict mode.
export { yield_ as yield };

/* ------------------------------------------------------------------ */
/*  scheduleIdle — idle-time work with timeout cap                    */
/* ------------------------------------------------------------------ */

/**
 * Run `fn` during browser idle time. Resolves when the callback fires.
 * Falls back to a microtask when requestIdleCallback is absent.
 * Checks at call time (not module load) so test-host polyfills work.
 *
 * @param {Function} fn
 * @param {{ timeout?: number }} opts
 * @returns {Promise<void>}
 */
export function scheduleIdle(fn, { timeout = 1500 } = {}) {
  if (typeof requestIdleCallback === "function") {
    return new Promise((resolve) => {
      requestIdleCallback(() => {
        fn();
        resolve();
      }, { timeout });
    });
  }
  return Promise.resolve().then(fn);
}
