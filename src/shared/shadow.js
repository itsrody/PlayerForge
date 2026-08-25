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
