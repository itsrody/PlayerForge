/**
 * Clamp a value into [lo, hi]. A single monomorphic shape that Warp inlines
 * cleanly across the codebase; replaces the repeated
 * Math.max(lo, Math.min(hi, v)) idiom at 7+ call sites (volume, seek targets,
 * filter saturation, panel steppers).
 */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
