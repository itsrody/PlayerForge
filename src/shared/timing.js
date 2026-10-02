/**
 * Shared timing constants — single source of truth for the animation
 * durations and easing curves used by JS consumers.
 *
 * CSS tokens in styles.css mirror these values; this module exists so JS
 * consumers never hardcode timing that drifts from the stylesheet. Values
 * that exist only as CSS are deliberately absent — the stylesheet is their
 * single source, and a JS twin that nothing reads is a drift trap.
 */

/* ── Curve strings (WAAPI `easing` param, CSS `animation-timing-function`) ── */

/** Tight/fast snap for video-transform compositor animations. */
export const EASE_SNAPPY_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Linear ease for flash background animation. */
export const FLASH_EASING = "ease-out";

/* ── Duration constants (milliseconds) ────────────────────────────────────── */

/** Tight snap duration for video-transform animations. */
export const EASE_SNAPPY_MS = 120;

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
