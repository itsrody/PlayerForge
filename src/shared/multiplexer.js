/**
 * Typed subscriber multiplexer (fan-out).
 *
 * A single implementation for the register-dispatch-teardown pattern used
 * by fullscreen state changes, resume store notifications, and any future
 * event source that fans out to multiple listeners.
 *
 * Subscribers that throw are isolated: one bad callback never prevents the
 * rest from firing. AbortSignal-based cleanup is first-class — the signal
 * that owns a subscriber's lifetime auto-removes it on abort, so callers
 * never need to track manual unsubscribe handles.
 */
export class Multiplexer {
  /** @type {Set<Function>} */
  #subs = new Set();

  /**
   * Subscribe a callback. Returns an unsubscribe function for manual
   * teardown; pass `signal` for automatic teardown on abort.
   *
   * @param {Function} cb - The callback to invoke on dispatch.
   * @param {AbortSignal} [signal] - Optional lifecycle signal.
   * @returns {Function} Unsubscribe function.
   */
  subscribe(cb, signal) {
    this.#subs.add(cb);
    if (signal) {
      signal.addEventListener("abort", () => this.#subs.delete(cb), { once: true });
    }
    return () => this.#subs.delete(cb);
  }

  /**
   * Dispatch to every subscriber. Each callback receives the same args.
   * A throwing callback is caught and logged to console — it does not
   * prevent remaining subscribers from firing.
   *
   * @param  {...any} args - Forwarded to every subscriber.
   */
  dispatch(...args) {
    for (const cb of this.#subs) {
      try { cb(...args); } catch (err) { console.error("[Multiplexer]", err); }
    }
  }

  /**
   * Remove all subscribers. Called on module-level teardown.
   */
  clear() {
    this.#subs.clear();
  }

  /**
   * Number of active subscribers (useful for diagnostic logging).
   */
  get size() {
    return this.#subs.size;
  }
}
