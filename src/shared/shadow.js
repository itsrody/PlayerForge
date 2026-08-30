/**
 * Shadow DOM traversal helpers. PlayerForge injects its HUD into an open
 * shadow root for style encapsulation, but several DOM APIs
 * (`document.activeElement`, `contains()`, `closest()`) stop at shadow
 * boundaries. These two primitives bridge every gap.
 */

/**
 * The deepest active element, piercing open shadow boundaries.
 * When `host` has a shadow root, the shadow tracks the real focused
 * element; otherwise falls back to `document.activeElement` (light DOM
 * or test environments like JSDOM).
 */
export function deepestActiveElement(host) {
  let el = host?.shadowRoot?.activeElement ?? document.activeElement;
  while (el?.shadowRoot) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

/**
 * True when `node` is a descendant of `host`'s shadow root
 * (or is the host itself). Falls back to light-DOM `contains()` when
 * no shadow root exists (e.g. JSDOM tests).
 */
export function isInsideShell(host, node) {
  return node === host || (host.shadowRoot?.contains(node) ?? host.contains(node));
}

/**
 * SOL - the single fullscreen gate across PlayerForge. A boolean, not a DOM
 * reference: `true` means ALLOW every fs-gated feature, `false` means BLOCK
 * them. It is maintained exclusively by initFullscreenGate() off the native
 * `fullscreenchange` event, and every fs-conditioned path in the codebase
 * (gesture intents, input binding gates, shell state, pinch wiring) reads
 * this one boolean - nothing else touches fullscreen directly.
 *
 * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
 * fullscreen: latching `!!document.fullscreenElement` at the transition is the
 * single source of truth, regardless of which actor entered it. Module-level
 * so it represents document-wide truth and survives shell create/destroy.
 */
export let fs = false;

/** Subscribers notified on a fullscreen state transition (subscribed from a
 *  single underlying native listener; see initFullscreenGate). */
const fsSubscribers = new Set();

/**
 * Build the `fs` gate off the native fullscreen event and fan out transitions.
 * Call once at startup. `doc` is injectable for jsdom tests so they drive the
 * real mechanism.
 *
 * This is the ONLY place that touches fullscreen: it owns the `fs` value AND
 * the single underlying `fullscreenchange` listener. Every other fs-conditioned
 * path reads `fs` directly or subscribes to transitions via subscribeFullscreen,
 * so there is one gate and one transition source regardless of shell count.
 */
export function initFullscreenGate(doc = document) {
  fs = !!doc.fullscreenElement;
  const update = () => {
    const next = !!doc.fullscreenElement;
    if (next === fs) {
      return;
    }
    fs = next;
    for (const cb of fsSubscribers) {
      cb(next);
    }
  };
  doc.addEventListener("fullscreenchange", update);
}

/**
 * Subscribe to fullscreen state transitions (fires only on an actual flip,
 * before the gates' consumers observe the new `fs`). Returns an unsubscribe
 * function; pass `signal` to have it torn down automatically.
 */
export function subscribeFullscreen(cb, signal) {
  fsSubscribers.add(cb);
  if (signal) {
    signal.addEventListener("abort", () => fsSubscribers.delete(cb), { once: true });
  }
  return () => fsSubscribers.delete(cb);
}
