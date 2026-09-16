/**
 * Standardized scoped timer with auto-cleanup.
 *
 * Replaces the 5 separate `clearTimeout + null-set` patterns in InputForge
 * (#holdTimer, #keyboardHoldTimer, #pinchInitTimer) and the ad-hoc timer
 * management in kernel.js (grace timers) and lifecycle.js (settle timers).
 *
 * Each ScopedTimer owns a single setTimeout and exposes:
 * - `schedule(fn, ms)` — arm a new timer (cancels any pending one)
 * - `cancel()` — drop the pending timer
 * - `isActive` — synchronous check if a timer is pending
 *
 * On AbortSignal abort, the pending timer is cancelled automatically.
 *
 * A `ScopedTimerSet` manages multiple named timers with batch cancel,
 * replacing the manual field-per-timer pattern.
 *
 * @example
 * const hold = new ScopedTimer(signal);
 * hold.schedule(() => startHold(), HOLD_TIMEOUT_MS);
 * // later: hold.cancel();
 * // or: signal fires -> auto-cancelled
 */
export class ScopedTimer {
  #cancel = null;
  #destroyed = false;

  /**
   * @param {AbortSignal} [signal] - Optional lifecycle signal; auto-cancel on abort.
   */
  constructor(signal) {
    if (signal) {
      signal.addEventListener("abort", () => {
        this.cancel();
        this.#destroyed = true;
      }, { once: true });
    }
  }

  /** True when a timer is pending. */
  get isActive() {
    return this.#cancel !== null;
  }

  /**
   * Arm a timer. Cancels any previously pending timer.
   * @param {Function} fn - Callback to invoke after `ms`.
   * @param {number} ms - Delay in milliseconds.
   */
  schedule(fn, ms) {
    if (this.#destroyed) return;
    this.cancel();
    const id = setTimeout(() => {
      this.#cancel = null;
      fn();
    }, ms);
    this.#cancel = () => clearTimeout(id);
  }

  /** Cancel the pending timer. No-op when nothing is pending. */
  cancel() {
    this.#cancel?.();
    this.#cancel = null;
  }
}

/**
 * A collection of named ScopedTimers with batch cancel.
 *
 * Replaces the manual `#holdTimer`, `#keyboardHoldTimer`, `#pinchInitTimer`
 * field trio in InputForge and the per-video grace timer map in kernel.js.
 *
 * @example
 * const timers = new ScopedTimerSet(signal);
 * timers.get("hold").schedule(() => startHold(), 500);
 * timers.get("keyboard").schedule(() => startKeyboardHold(), 500);
 * // on destroy: all cancelled automatically
 */
export class ScopedTimerSet {
  /** @type {Map<string, ScopedTimer>} */
  #timers = new Map();

  /**
   * @param {AbortSignal} signal - Lifecycle signal; all timers cancel on abort.
   */
  constructor(signal) {
    signal.addEventListener("abort", () => this.cancelAll(), { once: true });
  }

  /**
   * Get or create a named timer.
   * @param {string} name
   * @returns {ScopedTimer}
   */
  get(name) {
    let timer = this.#timers.get(name);
    if (!timer) {
      timer = new ScopedTimer();
      this.#timers.set(name, timer);
    }
    return timer;
  }

  /** Cancel all timers. */
  cancelAll() {
    for (const timer of this.#timers.values()) {
      timer.cancel();
    }
  }

  /** Remove all timer references. */
  clear() {
    this.#timers.clear();
  }
}
