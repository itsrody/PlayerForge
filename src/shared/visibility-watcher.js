/**
 * Standardized document visibility watcher.
 *
 * Replaces the 3 independent visibilitychange implementations across the
 * codebase (dom-watch.js, context.js bridge retry, shell.js wake lock re-acquire)
 * with one reusable class.
 *
 * The watcher tracks `document.visibilityState` and notifies subscribers
 * when the document transitions between visible/hidden. It also exposes
 * a synchronous `isVisible` getter so hot paths can skip work without
 * registering a listener.
 *
 * @example
 * const vis = new VisibilityWatcher(signal);
 * vis.onVisible(() => resumeRetries());
 * if (vis.isVisible) { ... }
 */
export class VisibilityWatcher {
  /** @type {Set<Function>} */
  #visibleListeners = new Set();
  /** @type {Set<Function>} */
  #hiddenListeners = new Set();
  #destroyed = false;

  /**
   * @param {AbortSignal} signal - Lifecycle signal; abort removes all listeners.
   */
  constructor(signal) {
    const onChange = () => {
      if (this.#destroyed) return;
      if (document.visibilityState === "visible") {
        this.#fire(this.#visibleListeners);
      } else {
        this.#fire(this.#hiddenListeners);
      }
    };
    document.addEventListener("visibilitychange", onChange, { signal });
    signal.addEventListener("abort", () => {
      this.#destroyed = true;
      this.#visibleListeners.clear();
      this.#hiddenListeners.clear();
    }, { once: true });
  }

  /** True when the document is currently visible. */
  get isVisible() {
    return document.visibilityState === "visible";
  }

  /** Subscribe to the document becoming visible. */
  onVisible(cb) {
    if (this.#destroyed) return () => {};
    this.#visibleListeners.add(cb);
    return () => this.#visibleListeners.delete(cb);
  }

  /** Subscribe to the document becoming hidden. */
  onHidden(cb) {
    if (this.#destroyed) return () => {};
    this.#hiddenListeners.add(cb);
    return () => this.#hiddenListeners.delete(cb);
  }

  #fire(set) {
    for (const cb of set) {
      try { cb(); } catch {}
    }
  }
}
