/**
 * Value vocabulary.
 *
 * Pure constants and predicates with zero imports - the leaf of the shared
 * layer that every other module reads. Six sections:
 *   1. Clamping        - one monomorphic clamp
 *   2. Tuning          - every behavior constant in the codebase
 *   3. Timing          - animation values JS reads
 *   4. Formatting      - unit-formatters for stepper/toast text
 *   5. Error policy    - benign media-error classification
 *   6. Capability      - first-available fallback chains
 */

/* - 1. Clamping - */

/**
 * Clamp a value into [lo, hi]. A single monomorphic shape that V8 inlines
 * cleanly across the codebase; replaces the repeated
 * Math.max(lo, Math.min(hi, v)) idiom at 7+ call sites (volume, seek targets,
 * filter saturation, panel steppers).
 */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/* - 2. Tuning - */
/**
 * Engineering calibration - every tunable value in the codebase lives here.
 * These are behavior constants, not user preferences: no panel controls, no
 * storage. Grouped by subsystem, units embedded.
 */
export const TUNING = {
  gestures: {
    /** Hold-to-speed-up: press must stay still and last this long. */
    holdTimeoutMs: 300,
    holdCancelMovePx: 10,
    doubleTapWindowMs: 300,
    /** Swipe-exit hot zones as a viewport fraction. */
    edgeZoneRatio: 0.15,
    scrollStartPx: 15,
    axisDominanceRatio: 2,
    pinchMinDistancePx: 50,
    pinchScaleThreshold: 0.2,
    trackpadCooldownMs: 500,
    /** Click/dblclick suppression window after a consumed gesture. */
    suppressWindowMs: 600,
    /** Horizontal travel that dismisses the HUD. */
    swipeExitMinPx: 100,
    /** Idle time that resets the double-tap skip streak. */
    streakResetMs: 600
  },
  controller: {
    holdSpeed: 2,
    streakMax: 10,
    /** Stored raw around the 150 anchor; effective multiplier = value / 150. */
    scrubSensitivity: 100
  },
  scrub: {
    /**
     * Velocity-proportional scrub. The amount of time moved per pixel is a
     * monotonic saturating function of the finger's real-time speed (measured
     * px/s by the forge at move granularity and updated live): a slow stroke
     * moves ~slowFullWidthSeconds across the container width, a fast stroke
     * covers fastFullWidthFraction of the playback DURATION. The curve rises
     * smoothly past the knee, then saturates so high-speed scrubbing stays
     * stable (scrubTo clamps to [0, duration]). Because it follows the hand's
     * current velocity rather than hold time, and scales the ceiling with the
     * runtime, the seek amount is proportional to velocity in real time and
     * traverses any content length uniformly - signed by drag direction.
     */
    velocity: {
      /** Full-width stroke at near-zero speed: the "1s" deliberate floor. */
      slowFullWidthSeconds: 1,
      /** Fraction of the PLAYBACK DURATION a full-width fast stroke can cover.
       *  The fast ceiling scales with content length so the same gesture
       *  traverses a short clip or a long movie proportionally (regular-player
       *  feel) - 0.5 = up to half the runtime per full-width fast stroke. */
      fastFullWidthFraction: 0.5,
      /** Velocity (px/s) at which the gain sits ~halfway between slow and fast. */
      kneeVelocityPxS: 400,
      /** Curve shape; >1 rises later and punchier, <1 hurries to the ceiling. */
      exponent: 1.5
    },
    /** Sub-pixel moves are ignored so a holding finger doesn't micro-shimmer. */
    deadZonePx: 0.5,
    /**
     * Time constant (ms) of the velocity low-pass filter in the forge:
     * alpha = 1 - exp(-dt/tau). Because alpha derives from real elapsed time
     * rather than event count, the smoothing window is the same absolute time
     * at any display rate - adaptive-refresh correct - and the small tau keeps
     * the signal responsive enough to track speed changes mid-stroke.
     */
    velocityFilterMs: 60
  },
  resume: {
    /** Dynamic checkpoint span: an incremental persist lands once the playhead
     *  has advanced this fraction of the resource duration, clamped so short
     *  clips do not churn GM storage and long films still checkpoint within a
     *  bounded media gap. Content-relative, so playbackRate and buffering never
     *  distort the cadence (no wall clock). */
    checkpointRatio: 0.01,
    minCheckpointSeconds: 10,
    maxCheckpointSeconds: 60,
    /** Progress at/after which the entry resets so the video restarts next time. */
    completionRatio: 0.95,
    /** Ignore tiny drifts between saves. */
    saveEpsilonSeconds: 3,
    durationFuzz: 2,
    /** Only auto-seek when the saved position is meaningful. */
    minPosition: 5,
    staleDays: 14,
    /** Hard ceiling for stored entries regardless of age pruning. */
    maxEntries: 1000
  },
  filter: {
    /** Trailing flush for color steppers: preview is instant, storage waits. */
    persistDebounceMs: 300
  },
  subtitles: {
    syncDebounceMs: 150
  },
  toast: {
    /** Completed-action feedback: skip, volume, fullscreen exit, fill. */
    flashMs: 800,
    /** Plain status messages. */
    infoMs: 2500,
    /** Toasts carrying a clickable button - extra reading time. */
    actionMs: 4000,
    /** Onboarding hints. */
    hintMs: 5000
  }
};
/* - 3. Timing - */
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
/* - 4. Formatting - */
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
/* - 5. Error policy - */
/**
 * Rejections from `play()`, `requestPictureInPicture()`, and friends that are
 * ordinary browser policy, not application bugs: AbortError = the request was
 * superseded (new load / pause race), NotAllowedError = autoplay or
 * user-gesture policy. Callers rethrow (or surface) anything else.
 */
export function isBenignMediaPolicyError(err) {
  return err?.name === "AbortError" || err?.name === "NotAllowedError";
}
