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
    pinchBaselineDelayMs: 2,
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
    /** Minimum wall-clock time between incremental persists (timeupdate-driven). */
    saveIntervalMs: 60000,
    metadataWaitMs: 10000,
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
