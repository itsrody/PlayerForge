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

/**
 * Build the `fs` gate off the native fullscreen event. Call once at startup.
 * `doc` is injectable for jsdom tests so they drive the real mechanism.
 */
export function initFullscreenGate(doc = document) {
  const update = () => {
    fs = !!doc.fullscreenElement;
  };
  doc.addEventListener("fullscreenchange", update);
  update();
}
