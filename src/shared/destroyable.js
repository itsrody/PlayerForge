/**
 * Base class for lifecycle-managed components.
 *
 * Provides the standard destroy protocol shared by every Shell sub-component:
 * - `#destroyed` guard — `destroy()` is idempotent
 * - `#scope` AbortController — cascading teardown via `signal`
 * - `signal` getter — sub-components bind listeners/timers to this
 * - `onDestroy()` hook — subclasses override for component-specific cleanup
 *
 * Subclasses call `super.destroy()` at the end of their override so the
 * base teardown (abort + flag) runs last, after all sub-component work
 * is done.
 *
 * @example
 * class MyComponent extends Destroyable {
 *   #dom = new DOMManager();
 *   destroy() {
 *     this.#dom.destroy();
 *     super.destroy();
 *   }
 * }
 */
export class Destroyable {
  #destroyed = false;
  #scope = new AbortController();

  /** Lifecycle signal — abort cascades to all signal-scoped listeners. */
  get signal() {
    return this.#scope.signal;
  }

  /** True after `destroy()` has been called. */
  get isDestroyed() {
    return this.#destroyed;
  }

  /**
   * Tear down the component. Idempotent — safe to call multiple times.
   * Subclasses override and call `super.destroy()` at the end.
   */
  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#scope.abort();
  }
}
