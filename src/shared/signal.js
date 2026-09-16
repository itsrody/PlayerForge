/**
 * AbortSignal composition utilities.
 *
 * Handles the jsdom brand-check issue where AbortSignal.any() rejects
 * signals constructed in a different realm — a single helper that every
 * call site can delegate to instead of duplicating the try/catch fallback.
 *
 * Firefox 157+ always takes the composed path; the fallback fires only
 * in test harnesses (jsdom) that brand-check AbortSignal.
 */

/** @type {(signals: AbortSignal[], timeoutMs: number) => AbortSignal} */
const anyFn = typeof AbortSignal.any === "function" ? AbortSignal.any.bind(AbortSignal) : null;

/**
 * Compose a timeout signal with an existing base signal, producing a
 * signal that aborts when EITHER fires (the sooner of the two).
 *
 * Falls back gracefully when AbortSignal.any is unavailable (jsdom):
 * the returned signal is the base signal alone — callers lose the
 * timeout but keep the abort-on-destroy contract.
 *
 * @param {AbortSignal} base - The lifecycle signal (typically a scope's).
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {AbortSignal} A signal that aborts on the sooner of base or timeout.
 */
export function composeTimeout(base, timeoutMs) {
  if (!anyFn) {
    return base;
  }
  try {
    return anyFn([base, AbortSignal.timeout(timeoutMs)]);
  } catch {
    // jsdom brand-check: AbortSignal.timeout() from a different realm.
    return base;
  }
}

/**
 * Compose two signals, producing a signal that aborts when EITHER fires.
 * Identical to composeTimeout but without a built-in timeout — useful
 * when one signal is lifecycle (scope) and the other is user-controlled
 * (e.g. a manual AbortController for a cancellation button).
 *
 * @param {AbortSignal} a
 * @param {AbortSignal} b
 * @returns {AbortSignal}
 */
export function composeSignals(a, b) {
  if (!anyFn) {
    return a;
  }
  try {
    return anyFn([a, b]);
  } catch {
    return a;
  }
}
