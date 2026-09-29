/**
 * Shared leaf helpers: pure, dependency-free formatting and numeric
 * primitives used across the tree. Kept in one module so the tree carries a
 * single import target for these one-liners instead of a file each.
 */

/**
 * Clamp a value into [lo, hi]. A single monomorphic shape that the JIT inlines
 * cleanly across the codebase; replaces the repeated
 * Math.max(lo, Math.min(hi, v)) idiom at 7+ call sites (volume, seek targets,
 * filter saturation, panel steppers).
 */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* - Stepper unit formatting - */

export const fmtPercent = (v) => `${v}%`;
export const fmtEm = (v) => `${v}em`;
export const fmtSeconds = (v) => `${v}s`;

/**
 * Seconds -> "M:SS" (or "H:MM:SS" past the hour). Shared by toast text,
 * resume prompts, and scrub hints.
 *
 * Integer arithmetic + direct string coercion instead of Math.max/Math.floor
 * modulo chains and padStart (which allocates an intermediate string): runs on
 * toast and scrub-hint churn and stays allocation-lean on the hot path.
 */
export function formatTime(seconds) {
  if (!(seconds > 0)) {
    return "0:00";
  }
  seconds = Math.floor(seconds);
  const h = (seconds / 3600) | 0;
  const m = ((seconds % 3600) / 60) | 0;
  const s = seconds % 60;
  const mm = m < 10 ? "0" + m : "" + m;
  const ss = s < 10 ? "0" + s : "" + s;
  return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
}

/**
 * Rejections from `play()` and friends that are ordinary browser policy, not
 * application bugs: AbortError = the request was superseded (new load / pause
 * race), NotAllowedError = autoplay or user-gesture policy. Callers rethrow
 * (or surface) anything else.
 */
export function isBenignMediaPolicyError(err) {
  return err?.name === "AbortError" || err?.name === "NotAllowedError";
}
