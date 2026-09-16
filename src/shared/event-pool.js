/**
 * Pooled CustomEvent bus.
 *
 * Reuses Event objects by name so gesture-boundary dispatches never allocate
 * on the hot path. Each event name maps to one lazy-constructed Event that
 * is re-created when the constructor changes (realm switch) or when the
 * detail is a new object reference.
 *
 * Contract: dispatchEvent runs listeners synchronously and every consumer
 * reads the detail payload before the next dispatch re-mutates it, so a
 * re-dispatched instance is safe — nothing retains the object past the
 * caller that last read it.
 *
 * Lazy `globalThis.CustomEvent` resolution keeps the pool realm-safe
 * across jsdom's realm bridging in tests and identical to the page realm
 * in the browser.
 */
export class PooledEventBus {
  /** @type {Map<string, {Ctor: typeof CustomEvent, event: CustomEvent, lastDetail: any}>} */
  #pool = new Map();

  /**
   * Dispatch a pooled CustomEvent on the given target. The event is
   * lazily constructed on first use for each name, then mutated in place.
   *
   * @param {EventTarget} target - The element to dispatch on.
   * @param {string} name - The CustomEvent name.
   * @param {any} detail - The event detail payload.
   */
  dispatch(target, name, detail) {
    const Ctor = globalThis.CustomEvent;
    const entry = this.#pool.get(name);
    if (entry && entry.Ctor === Ctor && entry.lastDetail === detail) {
      target.dispatchEvent(entry.event);
      return;
    }
    // Re-create the event: either first use, realm switch, or a new detail
    // object. jsdom's CustomEvent does not support reassigning `detail` after
    // construction, so we must create a fresh Event each time the detail ref
    // changes. On the browser hot path, the same detail object is reused per
    // scrub frame (mutated in place by the caller), so this branch is rarely
    // taken after the first dispatch.
    const event = new Ctor(name, { detail, bubbles: false, composed: false });
    this.#pool.set(name, { Ctor, event, lastDetail: detail });
    target.dispatchEvent(event);
  }

  /**
   * Clear all cached events. Called on destroy to release references.
   */
  clear() {
    this.#pool.clear();
  }
}
