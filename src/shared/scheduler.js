/**
 * Chromium-native task scheduler.
 *
 * One façade over Chromium's scheduling primitives so consumers never
 * duplicate `typeof scheduler?.*` capability guards across the tree:
 *
 *   postTask(fn, { priority, delay, signal }) → { abort() }
 *     scheduler.postTask (Chromium 95+) → setTimeout fallback
 *
 *   yield_() → Promise
 *     scheduler.yield (Chromium 129+) → requestAnimationFrame → noop
 *
 * Detection runs once at module load and every export is a plain function so
 * V8 can keep the fast path inline (Maglev/TurboFan-friendly, no hidden-class
 * penalty per call).
 */

const HAS_POST_TASK =
  typeof globalThis.scheduler?.postTask === "function";

const HAS_YIELD =
  typeof globalThis.scheduler?.yield === "function";

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
  if (!HAS_POST_TASK) {
    // setTimeout fallback - dead code on the Chromium 153 floor, kept for the
    // jsdom test harness.
    const id = setTimeout(fn, ms);
    return { abort: () => clearTimeout(id) };
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
 * non-urgent work (mutation fan-out, large parses). Resolves on the next task
 * (postTask/rAF/microtask depending on runtime support).
 *
 * @returns {Promise<void>}
 */
export const yield_ = HAS_YIELD
  ? () => globalThis.scheduler.yield()
  : typeof globalThis.requestAnimationFrame === "function"
    ? () => new Promise((r) => { globalThis.requestAnimationFrame(() => r()); })
    : () => Promise.resolve();