import { Scope } from "./scope.js";

/**
 * Per-shell DOM lifecycle manager.
 *
 * Tracks every DOM artifact a shell creates — observers, elements, and
 * inline style/attribute rollbacks — and tears them all down in one call.
 * Prevents the most common class of leak in complex component trees:
 * forgetting to remove one observer or listener in a rarely-tested code
 * path.
 *
 * Event listeners are NOT tracked in a registry: `listen()` hands the
 * manager's own AbortSignal to `addEventListener`, so removal is the
 * platform's job on dispose — no [target, event, handler, opts] tuples to
 * retain, no manual removeEventListener sweep, and the target's listener
 * list drops the entry at abort instead of waiting for GC.
 *
 * Hot-path code (scrub, cue rendering) stays on direct DOM access; the
 * manager only wraps lifecycle-bound operations that need cleanup.
 */
export class DOMManager {
  /** [element] Created elements for automatic remove(). */
  #elements = [];
  /** [el, attr, value, original] triples for attribute rollback on destroy. */
  #attrRollbacks = [];
  /** [el, prop, value, original] triples for style rollback on destroy. */
  #styleRollbacks = [];
  /** [fn] External cleanup callbacks (e.g. dom-watch unsubscribe handles). */
  #cleanups = [];
  #scope = new Scope();

  /**
   * Add an event listener that is automatically removed when the manager is
   * destroyed. Returns the handler for call-site reference (e.g. passing to
   * removeEventListener before destroy is called).
   */
  listen(target, event, handler, opts) {
    // Normalize the boolean shorthand so `{ signal }` never drops `capture`.
    const options = typeof opts === "boolean" ? { capture: opts } : { ...opts };
    options.signal = this.#scope.signal;
    target.addEventListener(event, handler, options);
    return handler;
  }

  /**
   * Create a ResizeObserver that is automatically disconnected on destroy.
   * Returns the observer for manual use between creation and destroy.
   */
  observeResize(target, callback) {
    if (this.#scope.disposed) return null;
    const observer = new ResizeObserver(callback);
    observer.observe(target);
    this.#scope.onDispose(() => observer.disconnect());
    return observer;
  }

  /**
   * Create an element and append it to a parent. The element is automatically
   * removed from the DOM on destroy.
   */
  createElement(tag, attrs, parent) {
    if (this.#scope.disposed) return null;
    const doc = parent?.ownerDocument ?? document;
    const node = doc.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") {
          node.className = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(node.style, value);
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
    if (this.#scope.disposed) return;
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
    if (this.#scope.disposed) return;
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
    if (this.#scope.disposed) {
      fn();
      return;
    }
    this.#cleanups.push(fn);
  }

  /**
   * Tear down every tracked artifact. Idempotent — safe to call multiple
   * times: Scope.dispose() flips `disposed` before it aborts, so re-entrant
   * calls no-op from the first line on.
   */
  destroy() {
    if (this.#scope.disposed) return;

    // Mark disposed + abort the signal FIRST: every signal-bound listener
    // and observer disconnect registered above is released by the platform
    // here (onDispose runs observer disconnects), and cleanup callbacks
    // below can no longer register new tracked artifacts.
    this.#scope.dispose();

    // External cleanups (may reference elements being removed next).
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
  }
}
