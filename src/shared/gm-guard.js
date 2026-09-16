/**
 * GM API guard utilities.
 *
 * Violentmonkey's GM_* APIs are injected as globals by the manager, but
 * not every host exposes every API (e.g. GM_getResourceText is optional).
 * Every call site previously duplicated the same `typeof GM_xxx !== "function"`
 * guard — this module collapses that into a single pattern.
 *
 * `guardedGM(name, ...args)` returns the GM function's result, or null when
 * the function is unavailable. A two-arg variant `guardedGMWithHandle` first
 * checks that a registration handle is non-null before calling (for unregister
 * functions that are no-ops when the handle is missing).
 */

/**
 * Call a GM API by global name, returning null when the API is missing.
 * Handles: GM_registerMenuCommand, GM_addValueChangeListener,
 * GM_getResourceText, and any future GM_* that follows the same shape.
 *
 * @param {string} name - The global name (e.g. "GM_registerMenuCommand").
 * @param  {...any} args - Forwarded to the GM function.
 * @returns {any|null} The GM function's return value, or null.
 */
export function guardedGM(name, ...args) {
  const fn = globalThis[name];
  if (typeof fn !== "function") {
    return null;
  }
  return fn(...args);
}

/**
 * Call a GM unregister/cleanup API that requires a registration handle.
 * When `handle` is null/undefined (registration was unavailable), this is
 * a no-op. When the GM API is missing, this is also a no-op.
 *
 * @param {string} name - The global name (e.g. "GM_unregisterMenuCommand").
 * @param {any} handle - The handle returned by the corresponding register call.
 */
export function guardedGMWithHandle(name, handle) {
  if (handle == null) {
    return;
  }
  const fn = globalThis[name];
  if (typeof fn !== "function") {
    return;
  }
  fn(handle);
}
