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
 * set as attributes). Returns the element; callers set textContent/children
 * as needed.
 */
export function el(tag, attrs = {}, parent = null) {
  const node = (parent?.ownerDocument ?? document).createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else {
      node.setAttribute(key, value);
    }
  }
  parent?.appendChild(node);
  return node;
}

/**
 * Icon-button building block: a type=button element with a class, title and
 * optional icon child. Returns the button for event wiring.
 */
export function button({ class: cls = "", title = "", "aria-label": ariaLabel = "", icon = null }, parent = null) {
  const node = el("button", {
    type: "button",
    ...(cls ? { class: cls } : {}),
    ...(title ? { title } : {}),
    ...(ariaLabel ? { "aria-label": ariaLabel } : {})
  }, parent);
  if (icon) {
    node.appendChild(icon);
  }
  return node;
}
