/** Shared unit-format functions for stepper display. */
export const fmtPercent = (v) => `${v}%`;
export const fmtEm = (v) => `${v}em`;
export const fmtSeconds = (v) => `${v}s`;
export const fmtPercentOrOff = (v) => v ? `${v}%` : "Off";
export const fmtSigned = (v) => `${v > 0 ? "+" : ""}${v}`;
export const signedSeconds = (v) => v === 0 ? "0s" : `${v > 0 ? "+" : ""}${v}s`;

/** Seconds -> "M:SS" (or "H:MM:SS" past the hour). Shared by toast text,
 *  resume prompts, and scrub hints.
 *
 *  Integer arithmetic + direct string coercion instead of Math.max/Math.floor
 *  modulo chains and padStart (which allocates an intermediate string): runs on
 *  toast and scrub-hint churn and stays allocation-lean on the hot path.
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
