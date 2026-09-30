/**
 * Shared timing constants — single source of truth for the animation easing
 * curves and durations that JS hands to the compositor.
 *
 * Only the values the WAAPI path actually consumes live here: the flash
 * accent (shell/chrome/animate.js) and the video-transform snap
 * (shell/inputs/actions.js). CSS-transition timing is owned by styles.css.
 *
 * The WAAPI option bags that used to live here (EASE, EASE_BOUNCE, EASE_OUT,
 * EASE_*_WAAPI, FLASH_WAAPI and their curve/duration sources) had no
 * references anywhere in the tree and were removed as leftovers.
 */

/* ── Curve strings (WAAPI `easing`, CSS `animation-timing-function`) ──────── */

/** Tight/fast snap for video-transform compositor animations. */
export const EASE_SNAPPY_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Linear ease for flash background animation. */
export const FLASH_EASING = "ease-out";

/* ── Duration constants (milliseconds) ────────────────────────────────────── */

/** Tight snap duration for video-transform animations. */
export const EASE_SNAPPY_MS = 120;

/** Accent flash duration. */
export const FLASH_MS = 400;
