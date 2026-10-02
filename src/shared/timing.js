/**
 * Shared timing constants — single source of truth for the animation values JS
 * reads, so JS consumers never hardcode timing that drifts from the stylesheet.
 *
 * The stylesheet owns the mirrored values as CSS custom properties; this module
 * carries the ones JS must read numerically (a duration to hand Element.animate,
 * a curve for an inline style). Everything here is used — this file previously
 * exported 13 more constants (the full curve/duration set, the composed
 * `transition` shorthand strings, and four WAAPI option bags) that no consumer
 * referenced, which made "single source of truth" read as a live contract when
 * the values had in practice moved into CSS.
 */

/* ── Curve / duration values JS reads ────────────────────────────────────── */

/** Tight/fast snap for video-transform compositor animations. */
export const EASE_SNAPPY_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Tight snap duration for video-transform animations. */
export const EASE_SNAPPY_MS = 120;

/** Linear ease for flash background animation. */
export const FLASH_EASING = "ease-out";

/** Accent flash duration. */
export const FLASH_MS = 400;

/* ── Motion preference ────────────────────────────────────────────────────── */

/**
 * Live `prefers-reduced-motion` query. Re-read `.matches` at call time (the
 * OS setting can flip while a shell is up), and null-guarded for non-DOM
 * harnesses. Consumers use it to skip decorative motion while keeping the
 * identical end state.
 */
export const REDUCED_MOTION = typeof matchMedia === "function"
  ? matchMedia("(prefers-reduced-motion: reduce)")
  : null;