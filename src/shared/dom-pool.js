/**
 * Lightweight DOM element pool — acquire/release lifecycle for reusable
 * elements. Caller handles DOM attach/detach; the pool manages reuse and
 * cleanup. Elements grow the pool on demand but never shrink automatically —
 * call shrink() to drop excess elements after bulk removals.
 *
 * Used by toasts, history cards, and subtitle cue slots to avoid repeated
 * createElement/remove cycles on hot paths.
 */
export class DomPool {
  /** Factory: creates a fresh element (not attached to any parent). */
  #factory;
  /** Reset: clears recycled element state (textContent, classes, styles). */
  #reset;
  /** Available elements ready for reuse. */
  #available;

  /**
   * @param {{ factory: () => HTMLElement, reset: (el: HTMLElement) => HTMLElement, initial?: number }}
   */
  constructor({ factory, reset, initial = 0 }) {
    this.#factory = factory;
    this.#reset = reset;
    this.#available = [];
    for (let i = 0; i < initial; i++) {
      this.#available.push(factory());
    }
  }

  /** Get a pooled element (reset) or create a new one. */
  acquire() {
    return this.#available.length > 0
      ? this.#reset(this.#available.pop())
      : this.#factory();
  }

  /** Return an element to the pool for reuse. Caller must detach first. */
  release(element) {
    this.#available.push(element);
  }

  /** Drop elements beyond `keep` count. Removes excess from DOM. */
  shrink(keep) {
    while (this.#available.length > keep) {
      this.#available.pop().remove();
    }
  }

  /** Remove all pooled elements from DOM and empty the pool. */
  destroy() {
    for (const el of this.#available) {
      el.remove();
    }
    this.#available.length = 0;
  }

  /** Number of elements currently available for reuse. */
  get idle() {
    return this.#available.length;
  }
}
