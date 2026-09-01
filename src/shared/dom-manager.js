/**
 * Per-shell DOM lifecycle manager.
 *
 * Tracks every DOM artifact a shell creates — event listeners, mutation
 * observers, elements, and inline style/attribute rollbacks — and tears
 * them all down in one call. Prevents the most common class of leak in
 * complex component trees: forgetting to remove one observer or listener
 * in a rarely-tested code path.
 *
 * Hot-path code (scrub, cue rendering) stays on direct DOM access; the
 * manager only wraps lifecycle-bound operations that need cleanup.
 */
export class DOMManager {
  /** [target, event, handler, opts] triples for automatic removeEventListener. */
  #listeners = [];
  /** [observer] MutationObserver instances for automatic disconnect. */
  #observers = [];
  /** [observer] ResizeObserver instances for automatic disconnect. */
  #resizeObservers = [];
  /** [element] Created elements for automatic remove(). */
  #elements = [];
  /** [el, attr, value, original] triples for attribute rollback on destroy. */
  #attrRollbacks = [];
  /** [el, prop, value, original] triples for style rollback on destroy. */
  #styleRollbacks = [];
  /** [fn] External cleanup callbacks (e.g. dom-watch unsubscribe handles). */
  #cleanups = [];
  #destroyed = false;

  /**
   * Add an event listener that is automatically removed on destroy.
   * Returns the handler for call-site reference (e.g. passing to removeEventListener
   * before destroy is called).
   */
  listen(target, event, handler, opts) {
    if (this.#destroyed) return handler;
    target.addEventListener(event, handler, opts);
    this.#listeners.push([target, event, handler, opts]);
    return handler;
  }

  /**
   * Create a MutationObserver that is automatically disconnected on destroy.
   * Returns the observer for manual use between creation and destroy.
   */
  observeMutations(target, opts, callback) {
    if (this.#destroyed) return null;
    const observer = new MutationObserver(callback);
    observer.observe(target, opts);
    this.#observers.push(observer);
    return observer;
  }

  /**
   * Create a ResizeObserver that is automatically disconnected on destroy.
   * Returns the observer for manual use between creation and destroy.
   */
  observeResize(target, callback) {
    if (this.#destroyed) return null;
    const observer = new ResizeObserver(callback);
    observer.observe(target);
    this.#resizeObservers.push(observer);
    return observer;
  }

  /**
   * Create an element and append it to a parent. The element is automatically
   * removed from the DOM on destroy.
   */
  createElement(tag, attrs, parent) {
    if (this.#destroyed) return null;
    const doc = parent?.ownerDocument ?? document;
    const node = doc.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") {
          node.className = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(node.style, value);
        } else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2), value);
        } else {
          node.setAttribute(key, value);
        }
      }
    }
    parent?.appendChild(node);
    this.#elements.push(node);
    return node;
  }

  /**
   * Set an attribute on an element, recording the original value for
   * automatic restoration on destroy. If the element already has the
   * attribute, the original is preserved (first-write wins).
   */
  markAttribute(el, attr, value) {
    if (this.#destroyed) return;
    const existing = this.#attrRollbacks.find(([e, a]) => e === el && a === attr);
    if (!existing) {
      const original = el.getAttribute(attr);
      this.#attrRollbacks.push([el, attr, value, original]);
    }
    el.setAttribute(attr, value);
  }

  /**
   * Set an inline style property, recording the original value for
   * automatic restoration on destroy.
   */
  markStyle(el, prop, value) {
    if (this.#destroyed) return;
    const existing = this.#styleRollbacks.find(([e, p]) => e === el && p === prop);
    if (!existing) {
      const original = el.style.getPropertyValue(prop);
      this.#styleRollbacks.push([el, prop, value, original]);
    }
    el.style.setProperty(prop, value);
  }

  /**
   * Register an external cleanup callback (e.g. an unsubscribe handle from
   * dom-watch.js or a pool destroy). Called in reverse order on destroy.
   */
  onCleanup(fn) {
    if (this.#destroyed) {
      fn();
      return;
    }
    this.#cleanups.push(fn);
  }

  /**
   * Register an external AbortSignal whose abort triggers cleanup of the
   * given handler on the given target. Useful for wiring a parent scope's
   * signal to this manager's listener registry.
   */
  wireSignal(target, event, handler, opts, signal) {
    this.listen(target, event, handler, opts);
    signal?.addEventListener("abort", () => {
      target.removeEventListener(event, handler, opts);
    }, { once: true });
  }

  /**
   * Tear down every tracked artifact in reverse registration order.
   * Idempotent — safe to call multiple times.
   */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;

    // External cleanups first (may reference listeners/observers).
    for (let i = this.#cleanups.length - 1; i >= 0; i--) {
      try { this.#cleanups[i](); } catch {}
    }
    this.#cleanups.length = 0;

    // Attribute rollbacks (restore original values).
    for (const [el, attr, , original] of this.#attrRollbacks) {
      if (original == null) {
        el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, original);
      }
    }
    this.#attrRollbacks.length = 0;

    // Style rollbacks (restore original values).
    for (const [el, prop, , original] of this.#styleRollbacks) {
      if (original) {
        el.style.setProperty(prop, original);
      } else {
        el.style.removeProperty(prop);
      }
    }
    this.#styleRollbacks.length = 0;

    // Remove created elements.
    for (let i = this.#elements.length - 1; i >= 0; i--) {
      this.#elements[i].remove();
    }
    this.#elements.length = 0;

    // Disconnect observers.
    for (const observer of this.#resizeObservers) {
      observer.disconnect();
    }
    this.#resizeObservers.length = 0;
    for (const observer of this.#observers) {
      observer.disconnect();
    }
    this.#observers.length = 0;

    // Remove event listeners.
    for (const [target, event, handler, opts] of this.#listeners) {
      target.removeEventListener(event, handler, opts);
    }
    this.#listeners.length = 0;
  }
}
