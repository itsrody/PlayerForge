import { logger } from "../shared/logger.js";

/**
 * Minimal event bus with on/once/off semantics, listener counting so empty
 * events stay cheap, and an opt-in debug mode (`#debug`) that traces emits.
 */
export class EventBus {
  #listeners = new Map();
  #onceListeners = new Map();
  #counts = new Map();
  #debug = false;

  set debug(value) {
    this.#debug = value;
  }

  on(event, handler) {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const size = set.size;
    set.add(handler);
    if (set.size !== size) {
      this.#adjustCount(event, 1);
    }
    return () => this.off(event, handler);
  }

  once(event, handler) {
    let set = this.#onceListeners.get(event);
    if (!set) {
      set = new Set();
      this.#onceListeners.set(event, set);
    }
    const size = set.size;
    set.add(handler);
    if (set.size !== size) {
      this.#adjustCount(event, 1);
    }
  }

  off(event, handler) {
    const persistent = this.#listeners.get(event);
    const oneShot = this.#onceListeners.get(event);
    let removed = 0;
    if (persistent?.delete(handler)) {
      removed++;
    }
    if (oneShot?.delete(handler)) {
      removed++;
    }
    if (removed) {
      this.#adjustCount(event, -removed);
    }
  }

  emit(event, payload) {
    if (!this.hasListeners(event)) {
      return;
    }
    if (this.#debug) {
      logger.log("bus", `emit: ${event}`, payload);
    }
    const persistent = this.#listeners.get(event);
    if (persistent) {
      for (const handler of persistent) {
        try {
          handler(payload);
        } catch (err) {
          logger.error("bus", `Error in listener for "${event}":`, err);
        }
      }
    }
    const oneShot = this.#onceListeners.get(event);
    if (oneShot) {
      for (const handler of oneShot) {
        try {
          handler(payload);
        } catch (err) {
          logger.error("bus", `Error in once-listener for "${event}":`, err);
        }
      }
      this.#onceListeners.delete(event);
      this.#adjustCount(event, -oneShot.size);
    }
  }

  clear() {
    this.#listeners.clear();
    this.#onceListeners.clear();
    this.#counts.clear();
  }

  hasListeners(event) {
    return (this.#counts.get(event) || 0) > 0;
  }

  listenerCount(event) {
    return this.#counts.get(event) || 0;
  }

  #adjustCount(event, delta) {
    const count = (this.#counts.get(event) || 0) + delta;
    if (count <= 0) {
      this.#counts.delete(event);
    } else {
      this.#counts.set(event, count);
    }
  }
}
