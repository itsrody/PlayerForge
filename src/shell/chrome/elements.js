import { applyAttrs } from "../../shared/dom-manager.js";

/**
 * Shell-owned DOM construction helpers. Every HUD/settings/subtitle element is
 * built through these so createElement + attribute + append never repeats
 * across chrome/subtitles. App-local (not shared/) since the framework never
 * constructs UI: shared/ stays limited to modules framework and app use
 * together.
 */

/**
 * Create an element, apply attribute map, and append to `parent` in one call.
 * `style` values given as objects are merged into the element's style (not
 * set as attributes), `on*` entries become listeners. Attribute handling is
 * shared/dom-manager.js's applyAttrs so this factory and the lifecycle-tracked
 * DOMManager.createElement cannot drift into different rules; no signal is
 * passed here, so `on*` listeners live and die with their node. Returns the
 * element; callers set textContent/children as needed.
 */
export function el(tag, attrs = {}, parent = null) {
  const node = (parent?.ownerDocument ?? document).createElement(tag);
  applyAttrs(node, attrs);
  parent?.appendChild(node);
  return node;
}

/**
 * Icon-button building block: a type=button element with a class, title and
 * optional icon child. Returns the button for event wiring. Any extra
 * attributes (`data-action`, off, disabled, ...) in the option map are
 * forwarded verbatim - the icon buttons only destructure the presentation
 * keys so the contract (data-action selectors) never silently drops.
 */
export function button({ class: cls = "", title = "", "aria-label": ariaLabel = "", icon = null, ...rest }, parent = null) {
  // One attrs object built by mutation: the conditional-spread form allocated
  // up to four throwaway objects (present/absent variants) per button.
  const attrs = { type: "button" };
  if (cls) {
    attrs.class = cls;
  }
  if (title) {
    attrs.title = title;
  }
  if (ariaLabel) {
    attrs["aria-label"] = ariaLabel;
  }
  Object.assign(attrs, rest);
  const node = el("button", attrs, parent);
  if (icon) {
    node.appendChild(icon);
  }
  return node;
}
