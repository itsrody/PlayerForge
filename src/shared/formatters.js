/** Shared unit-format functions for stepper display. */
export const fmtPercent = (v) => `${v}%`;
export const fmtEm = (v) => `${v}em`;
export const fmtSeconds = (v) => `${v}s`;
export const fmtPercentOrOff = (v) => v ? `${v}%` : "Off";
export const fmtSigned = (v) => `${v > 0 ? "+" : ""}${v}`;
export const signedSeconds = (v) => v === 0 ? "0s" : `${v > 0 ? "+" : ""}${v}s`;
