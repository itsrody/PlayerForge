/**
 * Lifecycle scope: one AbortController with an idempotent dispose, reverse-
 * order cleanup registration, and optional child scopes.
 *
 * This is the single teardown primitive classes compose instead of
 * hand-rolling a `#destroyed` boolean + a pile of `?.disconnect()` sweeps:
 *
 *   - `signal`    — hand straight to `addEventListener`/`postTask`/observers
 *                   that accept `{ signal }`; abort tears them down natively.
 *   - `onDispose(fn)` — reverse-registration-order cleanup for everything
 *                   that has no signal form (elements, rollbacks, stores).
 *                   Runs immediately if the scope is already disposed.
 *   - `child()`   — a sub-scope (a panel press, a readopt attempt) disposed
 *                   with its parent, independently before that.
 *   - `dispose()` — idempotent: marks disposed FIRST (re-entrant destroy
 *                   calls no-op), aborts the signal, then runs disposers.
 *
 * The controller is held, not extended, on purpose: `new AbortController()`
 * runs at construction, so the binding resolves to whatever constructor the
 * current realm lends (jsdom test hosts lend a realm-local one per case,
 * which their brand-checked addEventListener requires). A subclass would
 * freeze the base at module evaluation, ahead of any lending. There is no
 * second object to keep in sync regardless: the signal handed out IS the
 * controller's, and dispose() is the only writer.
 *
 * Disposer errors are isolated (one throw never strands the rest), matching
 * the dispatch-isolation policy used across the shared mutation feed and the
 * emitters.
 * Public class APIs keep their `destroy()` name and simply delegate here.
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

  /** Convenience: signal.aborted without reaching through the getter. */
  get aborted() {
    return this.#controller.signal.aborted;
  }

  /**
   * Register a cleanup callback. Runs at dispose() in reverse registration
   * order; if the scope is already disposed it runs synchronously now, so a
   * late registration can never outlive its owner.
   */
  onDispose(fn) {
    if (this.#disposed) {
      fn();
      return;
    }
    (this.#disposers ??= []).push(fn);
  }

  /** Sub-scope disposed with this one (or early via its own dispose()). */
  child() {
    const child = new Scope();
    this.onDispose(() => child.dispose());
    return child;
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
        try {
          disposers[i]();
        } catch {}
      }
    }
  }
}
