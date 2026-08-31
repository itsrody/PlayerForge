/**
 * Shared timing constants — single source of truth for animation durations
 * and easing curves used across CSS (transition shorthand), WAAPI
 * (Element.animate options bag), and JS transition strings.
 *
 * CSS tokens in styles.css mirror these values; this module exists so JS
 * consumers never hardcode timing that drifts from the stylesheet.
 */

/* ── Curve strings (WAAPI `easing` param, CSS `animation-timing-function`) ── */

/** Standard HUD chrome transition curve. */
export const EASE_CURVE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Tight/fast snap for video-transform compositor animations. */
export const EASE_SNAPPY_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Overshoot bounce (checkbox knob, view-transition entry). */
export const EASE_BOUNCE_CURVE = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Deceleration-only (view-transition exit). */
export const EASE_OUT_CURVE = "cubic-bezier(0.4, 0, 1, 1)";

/** Linear ease for flash background animation. */
export const FLASH_EASING = "ease-out";

/* ── Duration constants (milliseconds) ────────────────────────────────────── */

/** Standard HUD transition duration. */
export const EASE_MS = 180;

/** Tight snap duration for video-transform animations. */
export const EASE_SNAPPY_MS = 120;

/** View-transition entry / exit durations. */
export const EASE_BOUNCE_MS = 250;
export const EASE_OUT_MS = 200;

/** Accent flash duration. */
export const FLASH_MS = 400;

/* ── Combined CSS shorthand strings (for `transition` property) ──────────── */

/** Standard: `0.18s cubic-bezier(0.22, 1, 0.36, 1)` */
export const EASE = `${EASE_MS}ms ${EASE_CURVE}`;

/** Bounce: `0.25s cubic-bezier(0.34, 1.56, 0.64, 1)` */
export const EASE_BOUNCE = `${EASE_BOUNCE_MS}ms ${EASE_BOUNCE_CURVE}`;

/** Deceleration: `0.2s cubic-bezier(0.4, 0, 1, 1)` */
export const EASE_OUT = `${EASE_OUT_MS}ms ${EASE_OUT_CURVE}`;

/* ── WAAPI-ready option bags ──────────────────────────────────────────────── */

/** `{ duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }` */
export const EASE_WAAPI = { duration: EASE_MS, easing: EASE_CURVE };

/** `{ duration: 120, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }` */
export const EASE_SNAPPY_WAAPI = { duration: EASE_SNAPPY_MS, easing: EASE_SNAPPY_CURVE };

/** `{ duration: 250, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }` */
export const EASE_BOUNCE_WAAPI = { duration: EASE_BOUNCE_MS, easing: EASE_BOUNCE_CURVE };

/** `{ duration: 400, easing: "ease-out" }` */
export const FLASH_WAAPI = { duration: FLASH_MS, easing: FLASH_EASING };
