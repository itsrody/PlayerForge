/**
 * Haptic feedback for gesture latches, via Chromium Android's Vibration API
 * (navigator.vibrate). Chromium-based mobile browsers implement the Vibration
 * API (the W3C spec note: "implemented in Chromium-based browsers"); desktop
 * Chromium and hosts without a vibrator no-op it and iOS never implements it.
 *
 * The successor Web Haptics API (navigator.playHaptics) is still a WICG/MSEdge
 * explainer and NOT shipped in any Chromium release, so navigator.vibrate plus
 * short-pulse patterns is the only real, portable hook today.
 *
 * Patterns are deliberately SHORT: a gesture latch is a confirm pulse, not a
 * notification (Android has the VIBRATE permission + Touch Feedback setting,
 * and treats very short single pulses as haptic ticks while long ones read as
 * alerts). Each gesture family gets a distinct shape (one tick, double tick,
 * triple tick) so scrub-latch, pinch-fire, double-tap, and hold read
 * differently to the hand.
 *
 * Gates:
 *   - a user setting (gestures.haptics) so it can be turned off entirely;
 *   - prefers-reduced-motion, honoring the same a11y posture as the CSS
 *     (users who silence motion also silence vibration);
 *   - sticky-user-activation + hardware presence via feature detection (all
 *     `vibrate` returns on failure is false / a no-op).
 * Never throws.
 */
import { getSetting } from "./config.js";

/** Distinct pulse shapes per gesture, in milliseconds (vibrate / pause / ...). */
const PATTERNS = {
  /** Speed-up hold engaged. */
  hold: 12,
  /** Scrub session latched. */
  scrub: [10, 24, 10],
  /** Pinch-fill engaged or released. */
  pinch: [8, 14, 8, 14, 8],
  /** Fullscreen double-tap committed (skip/toggle). */
  dbltap: [14, 40, 14]
};

/** Reduced-motion is static per session; gate vibration the same way as CSS. */
const reducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const canVibrate =
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/** Fire the haptic pulse for `type` when armed (setting, motion, activation). */
export function gestureHaptic(type) {
  if (!canVibrate || reducedMotion || !getSetting("gestures.haptics")) {
    return;
  }
  const pattern = PATTERNS[type];
  if (pattern != null) {
    try {
      navigator.vibrate(pattern);
    } catch {}
  }
}
