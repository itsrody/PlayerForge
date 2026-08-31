import { getSetting, TUNING } from "../chrome/config.js";
import { formatTime } from "../../shared/time.js";
import { fs, subscribeFullscreen } from "../../shared/shadow.js";
import { GESTURE_EVENTS } from "../../kernel/contract.js";
import { gestureHaptic } from "../chrome/haptics.js";

export { GESTURE_EVENTS };

/**
 * Declarative input bindings - the single source of input policy.
 *
 * Every gesture the shell understands is one record here: what triggers it,
 * which settings toggle arms it, whether it demands fullscreen, and what it
 * does. The InputForge engine owns recognition and consults this list for
 * every decision; action implementations live beside the table so trigger
 * and behavior stay reviewable in one place.
 *
 * Binding schema:
 *   id      - stable label for logging/tests.
 *   gesture - intent family ("scrub", "swipe", "dbltap", "hold", "pinch",
 *             or "key").
 *   setting - optional settings key gating this binding.
 *   fs      - when true, fires only while the document is fullscreen.
 *   Matcher fields (per family): zone/direction for swipes and taps,
 *   code/direction/emit for keys, allowControlFocus for keys that must win
 *   even when a control element holds focus.
 */

export const INPUT_BINDINGS = [
  // - Pointer intents -
  { id: "hold-speed", gesture: "hold", setting: "gestures.hold", fs: false },
  { id: "drag-scrub", gesture: "scrub", setting: "gestures.scrub", fs: true },
  { id: "drag-swipe", gesture: "swipe", setting: "gestures.swipe", fs: true },
  { id: "double-tap", gesture: "dbltap", setting: "gestures.dbltap", fs: true },
  { id: "pinch-fill", gesture: "pinch", setting: "gestures.pinch", fs: true },

  // - Keyboard -
  {
    id: "key-skip-right", gesture: "key", code: "ArrowRight", emit: GESTURE_EVENTS.skip,
    direction: "right", setting: "gestures.hotkeys", fs: false
  },
  {
    id: "key-skip-left", gesture: "key", code: "ArrowLeft", emit: GESTURE_EVENTS.skip,
    direction: "left", setting: "gestures.hotkeys", fs: false
  },
  {
    id: "key-volume-up", gesture: "key", code: "ArrowUp", emit: GESTURE_EVENTS.volume,
    direction: "up", setting: "gestures.hotkeys", fs: false
  },
  {
    id: "key-volume-down", gesture: "key", code: "ArrowDown", emit: GESTURE_EVENTS.volume,
    direction: "down", setting: "gestures.hotkeys", fs: false
  },
  {
    id: "key-mute", gesture: "key", code: "KeyM", emit: GESTURE_EVENTS.mute,
    setting: "gestures.hotkeys", fs: false
  },
  {
    id: "key-panel", gesture: "key", code: "KeyS", emit: GESTURE_EVENTS.panel,
    setting: "gestures.hotkeys", fs: false, allowControlFocus: true
  }
];

/** Whether a binding's gates are open right now. */
function gateOpen(binding) {
  return (!binding.setting || getSetting(binding.setting)) &&
    (!binding.fs || fs);
}

/** Bindings pre-bucketed by gesture so decision-point scans skip the mass of
 *  unrelated records. Keys stay in table order. Gate sampling stays live. */
const BY_GESTURE = new Map();
for (const binding of INPUT_BINDINGS) {
  let list = BY_GESTURE.get(binding.gesture);
  if (!list) {
    list = [];
    BY_GESTURE.set(binding.gesture, list);
  }
  list.push(binding);
}

/**
 * True when at least one binding for the pointer-intent family is armed.
 * Sampled live at every decision point so toggles apply mid-session.
 */
export function allowsIntent(gesture) {
  const bindings = BY_GESTURE.get(gesture);
  if (!bindings) {
    return false;
  }
  return bindings.some(gateOpen);
}

/** Armed key bindings, in table order - sampled live per keystroke. */
export const KEY_BINDINGS = BY_GESTURE.get("key");

/** Whether a key binding's gates are open right now (live per read). */
export function isKeyArmed(binding) {
  return gateOpen(binding);
}

/*
 * Scrub tuning hoisted to module scope. The velocity-curve seek runs once
 * per coalesced pointer move (up to display rate), so the deep TUNING lookups
 * below would otherwise resolve several property chains per frame. Freezing
 * the curve shape, the dead zone, and the sensitivity multiplier as plain
 * constants keeps the hot path to flat scalar reads - matching the forge's
 * adaptive-refresh treatment of the gesture table.
 */
const SCRUB_KNEE_PX_PER_S = TUNING.scrub.velocity.kneeVelocityPxS;
const SCRUB_EXPONENT = TUNING.scrub.velocity.exponent;
const SCRUB_DEAD_ZONE_PX = TUNING.scrub.deadZonePx;
const SCRUB_SLOW_FULL_WIDTH_SECONDS = TUNING.scrub.velocity.slowFullWidthSeconds;
const SCRUB_FAST_FULL_WIDTH_FRACTION = TUNING.scrub.velocity.fastFullWidthFraction;
const SCRUB_SENSITIVITY = TUNING.controller.scrubSensitivity / 150;

/* - Per-shell action state - */

const stateFor = (() => {
  const states = new WeakMap();
  return (shell) => {
    let state = states.get(shell);
    if (!state) {
      state = {
        savedRate: 1,
        activeHolds: new Set(),
        scrubbing: false,
        scrubDuration: 0,
        scrubSlowGain: 0,
        scrubFastGain: 0,
        scrubSensitivity: 0,
        scrubDirectionMomentum: 0,
        lastScrubToastAt: 0,
        streakCount: 0,
        lastSkipDirection: null,
        streakResetTimer: null,
        fillActive: false
      };
      states.set(shell, state);
    }
    return state;
  };
})();

function performSkip(shell, state, direction) {
  const streakMax = TUNING.controller.streakMax;
  if (direction === state.lastSkipDirection) {
    state.streakCount = Math.min(state.streakCount + 1, streakMax);
  } else {
    state.streakCount = 1;
    state.lastSkipDirection = direction;
  }
  clearTimeout(state.streakResetTimer);
  state.streakResetTimer = setTimeout(() => {
    state.streakCount = 0;
    state.lastSkipDirection = null;
  }, TUNING.gestures.streakResetMs);

  const step = getSetting("controller.stepSeek") * state.streakCount;
  shell.media.skip(direction === "right" ? step : -step);
  shell.toast({
    icon: direction === "right" ? "right-arrows" : "left-arrows",
    text: `${step}s`,
    duration: TUNING.toast.flashMs,
    group: "skip"
  });
}

/**
 * Eased snap for inline video transforms: one curve, shared by fill-mode
 * exit, pinch fill, and swipe/pinch restore. A newer snap cancels the previous
 * in-flight animation so no cleanup can land mid-gesture.
 *
 * Where Element.animate (Web Animations API) is available -
 * Chromium 69+, i.e. this fork's baseline - the snap runs a WAAPI animation
 * on the compositor: one deterministic compositor animation with a real
 * finish/cancel, replacing the will-change + CSS-transition + transitionend
 * listener puzzle that could race when the transition shorthand was flipped
 * off. The video is promoted to its own compositor layer while a transform is
 * live (fill-mode, swipe/pinch restore) so Chromium composites the
 * scale/translate instead of re-rasterizing the media surface every frame;
 * the layer is released once the snap settles (or is cancelled).
 *
 * `prefers-reduced-motion` is honored: the transform lands instantly instead
 * of animating. On hosts without WAAPI (jsdom), the current element is re-
 * snapped via the CSS transition fallback, preserving observable behavior.
 */
const EASE_STYLE = "cubic-bezier(0.2, 0, 0, 1)";
const EASE_MS = 150;

/** Reduced-motion check is hoisted once (module const) - static per session. */
const reducedMotion = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One eased snap per video is the invariant; the in-flight cancel handle lives
 * in a WeakMap keyed by the video element rather than as an expando property so
 * the framework never mints new fields on native media elements (same posture
 * as barring video monkey-patches upstream).
 */
const pendingEase = new WeakMap();

/** Cancel any in-flight ease on `video` (used when the element is torn down). */
export function cancelEase(video) {
  const prior = pendingEase.get(video);
  if (prior) {
    prior();
  }
}

/** Release the video's compositor layer when this ease owns it. */
function dropPromotion(video) {
  if (video.style.willChange === "transform") {
    video.style.willChange = "";
  }
}

export function easeTransformTo(video, transform) {
  // Cancel any previous snap so a newer one takes sole ownership of the video.
  const prior = pendingEase.get(video);
  if (prior) {
    prior();
  }
  if (transform) {
    video.style.willChange = "transform";
  }

  // Reduced motion: land instantly, no animation, no layer churn.
  if (reducedMotion) {
    video.style.transition = "none";
    video.style.transform = transform;
    dropPromotion(video);
    return;
  }

  // WAAPI path (Chromium baseline): one compositor animation from the current
  // computed transform to the target. On finish the final value is committed
  // to an inline style and the animation is cancelled so its fill gives way;
  // on cancel (via stop() or supersession) the layer is dropped immediately.
  if (typeof video.animate === "function") {
    const animation = video.animate(
      [
        { transform: getComputedStyle(video).transform || "none" },
        { transform: transform || "none" }
      ],
      { duration: EASE_MS, easing: EASE_STYLE, fill: "both" }
    );
    const stop = () => {
      if (pendingEase.get(video) !== stop) {
        return;
      }
      pendingEase.delete(video);
      video.style.transition = "";
      animation.cancel();
    };
    pendingEase.set(video, stop);
    animation.addEventListener("finish", () => {
      if (pendingEase.get(video) !== stop) {
        return;
      }
      // Commit the final transform as inline style, then cancel the animation's
      // fill so the committed style owns the element from here on.
      video.style.transition = "";
      video.style.transform = transform;
      animation.cancel();
      pendingEase.delete(video);
      dropPromotion(video);
    });
    animation.addEventListener("cancel", () => {
      if (pendingEase.get(video) === stop) {
        pendingEase.delete(video);
        dropPromotion(video);
      }
    });
    return;
  }

  // CSS transition fallback (hosts without WAAPI, e.g. jsdom): the eased style
  // is stripped by the transition's own end/cancel event - never by a timer.
  const pendingStop = () => {
    video.removeEventListener("transitionend", onEnd);
    video.removeEventListener("transitioncancel", onCancel);
    if (pendingEase.get(video) === pendingStop) {
      pendingEase.delete(video);
      dropPromotion(video);
    }
  };
  const onEnd = (event) => {
    if (event.propertyName === "transform") {
      pendingStop();
    }
  };
  const onCancel = () => pendingStop();
  pendingEase.set(video, pendingStop);
  // Listeners first, styles second: no completion event can slip past us.
  video.addEventListener("transitionend", onEnd);
  video.addEventListener("transitioncancel", onCancel);
  video.style.transition = `transform ${EASE_MS}ms ${EASE_STYLE}`;
  video.style.transform = transform;
}

/**
 * Smoothly lerp a <video>'s volume from -> to over `duration` ms, cancelable.
 * Runs on the rAF beat with true timestamps so the fade is framerate-
 * independent, and lands exactly on `to`. Returns a stop() that cancels the
 * fade (leaving volume where it is) so an interrupting action can take over.
 */
function clearFillMode(shell, state, animate = true) {
  if (!state.fillActive) {
    return;
  }
  state.fillActive = false;
  const video = shell.video;
  if (video) {
    if (animate) {
      easeTransformTo(video, "");
    } else {
      // Cancel any in-flight WAAPI ease first: its fill:'both' would otherwise
      // keep re-applying a scale after the inline style is cleared below.
      const prior = pendingEase.get(video);
      if (prior) {
        prior();
      }
      video.style.transition = "none";
      video.style.transform = "";
      video.style.willChange = "";
      video.style.transition = "";
    }
  }
}

/**
 * Scale factor needed for the video to cover the given reference box.
 * Fill mode is fullscreen-only (pinch binding is fs-gated), and the reference
 * (passed from `shell.referenceBox`) is the device screen in fs - the video's
 * rendered box is simply the screen. No getBoundingClientRect (forced layout)
 * is needed: the fill scale is pure aspect-ratio math between the video's
 * intrinsic ratio and the reference box. Guards return 0 so the caller skips
 * fill when the video size or reference isn't known yet.
 */
export function computeCoverScale(video, ref) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) {
    return 0;
  }
  const refWidth = ref?.width;
  const refHeight = ref?.height;
  if (!refWidth || !refHeight) {
    return 0;
  }
  const aspect = videoWidth / videoHeight;
  const fittedWidth = Math.min(refWidth, refHeight * aspect);
  const fittedHeight = Math.min(refHeight, refWidth / aspect);
  return Math.max(refWidth / fittedWidth, refHeight / fittedHeight);
}

function volumeIcon(volume, muted) {
  return muted ? "muted"
    : volume > 0.7 ? "volume-1"
    : volume > 0.4 ? "volume-2" : "volume-3";
}

/** Percentage text for a 0..1 volume value (e.g. "42%"). */
function volumePercent(volume) {
  return `${Math.round(volume * 100)}%`;
}

/**
 * Wire the shell-facing side of the bindings onto the shell host: semantic
 * events dispatched by the engine run these handlers. All listeners share
 * the engine's AbortSignal, so destroying the engine tears the actions down.
 */
export function attachInputActions(shell, host, signal) {
  /** Fullscreen exit also collapses fill mode - the one cross-feature rule. */
  subscribeFullscreen((active) => {
    if (!active) {
      const state = stateFor(shell);
      if (state.fillActive) {
        clearFillMode(shell, state, false);
      }
    }
  }, signal);

  host.addEventListener(GESTURE_EVENTS.hold, ({ detail }) => {
    if (!shell.video) {
      return;
    }
    const state = stateFor(shell);
    const source = detail.method || "pointer";
    if (state.activeHolds.has(source) || (state.activeHolds.add(source), state.activeHolds.size > 1)) {
      return;
    }
    const speed = TUNING.controller.holdSpeed;
    state.savedRate = shell.playbackRate;
    shell.media.beginBoost(speed);
    gestureHaptic("hold");
    shell.toast({ icon: "right-arrows", text: `${speed}x`, group: "hold" });
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.release, ({ detail }) => {
    const state = stateFor(shell);
    const source = detail.method || "pointer";
    if (!state.activeHolds.delete(source) || state.activeHolds.size > 0) {
      return;
    }
    if (shell.video) {
      shell.media.endBoost(state.savedRate);
    }
    shell.hideToast("hold");
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.scrub, ({ detail }) => {
    if (!shell.video) {
      return;
    }
    const state = stateFor(shell);
    const now = performance.now();
    if (!state.scrubbing) {
      const duration = shell.duration;
      if (!duration || !Number.isFinite(duration)) {
        return;
      }
      // Velocity-proportional seek: gain (seconds per pixel) rises with the
      // finger's real-time speed. Width-normalized so the feel is independent
      // of container size; the fast ceiling scales with the playback DURATION
      // so a fast stroke traverses a fraction of the runtime on any length,
      // while the slow floor stays a deliberate ~1s. The reference is the
      // unified `shell.referenceBox` (fs -> screen, inline -> container), so
      // scrub always normalizes against the correct contextual box.
      const width = shell.referenceBox.width || 640;
      const fastCeiling = duration * SCRUB_FAST_FULL_WIDTH_FRACTION;
      state.scrubbing = true;
      state.scrubDuration = duration;
      state.scrubSlowGain = SCRUB_SLOW_FULL_WIDTH_SECONDS / width;
      state.scrubFastGain = fastCeiling / width;
      state.scrubSensitivity = SCRUB_SENSITIVITY;
      state.scrubDirectionMomentum = 0;
      gestureHaptic("scrub");
    }

    if (Math.abs(detail.dx) < SCRUB_DEAD_ZONE_PX) {
      return;
    }

    // Proportional velocity curve: t in [0,1] as |velocity| rises past the
    // knee, so slow scrubbing stays near the 1s floor while fast scrubbing
    // eases toward the duration-scaled ceiling (a fraction of the runtime).
    // Sampled live each move, the seek amount tracks the hand's current
    // velocity in real time and scales with content length.
    const v = Math.abs(detail.velocity);
    const t = Math.min(1, (v / SCRUB_KNEE_PX_PER_S) ** SCRUB_EXPONENT);
    const gain = state.scrubSlowGain + (state.scrubFastGain - state.scrubSlowGain) * t;
    const deltaSeconds = detail.dx * gain * state.scrubSensitivity;
    // The stroke latched above, so duration is stable - use the latched-seek
    // path so each move skips media's readiness gate + duration re-read.
    shell.media.scrubToLatched(shell.currentTime + deltaSeconds, state.scrubDuration);
    const instantDirection = detail.dx > 1 ? 1 : detail.dx < -1 ? -1 : 0;
    state.scrubDirectionMomentum = state.scrubDirectionMomentum * 0.6 + instantDirection * 0.4;

    if (now - state.lastScrubToastAt < 100) {
      return;
    }
    state.lastScrubToastAt = now;
    shell.toast({
      icon: state.scrubDirectionMomentum >= 0 ? "right-arrows" : "left-arrows",
      text: `${formatTime(state.scrubDuration)} / ${formatTime(shell.video.currentTime)}`,
      group: "scrub"
    });
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.scrubEnd, () => {
    const state = stateFor(shell);
    if (!state.scrubbing) {
      return;
    }
    state.scrubbing = false;
    state.scrubDirectionMomentum = 0;
    state.scrubDuration = 0;
    state.scrubSlowGain = 0;
    state.scrubFastGain = 0;
    state.scrubSensitivity = 0;
    shell.hideToast("scrub");
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.swipeStart, ({ detail }) => {
    if (detail.direction === "down") {
      shell.toast({
        icon: "fs-exiting",
        text: "Exiting Fullscreen",
        group: "fs"
      });
    }
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.swipe, ({ detail }) => {
    const state = stateFor(shell);
    if (detail.direction !== "down") {
      return;
    }
    if (detail.distance > TUNING.gestures.swipeExitMinPx) {
      clearFillMode(shell, state, false);
      shell.toast({
        icon: "fs-exit",
        text: "Fullscreen Exited",
        duration: TUNING.toast.flashMs,
        group: "fs"
      });
      shell.exitFullscreen();
    } else {
      shell.hideToast("fs");
    }
  }, { signal });

  /**
   * Fullscreen-only double-tap semantics: edges skip, center toggles
   * playback. Inline double-taps belong to the browser/player natively.
   */
  host.addEventListener(GESTURE_EVENTS.dbltap, ({ detail }) => {
    gestureHaptic("dbltap");
    if (detail.zone === "left-edge" || detail.zone === "right-edge") {
      performSkip(shell, stateFor(shell), detail.zone === "left-edge" ? "left" : "right");
    } else if (detail.zone === "screen") {
      shell.media.togglePlay();
    }
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.skip, ({ detail }) => {
    performSkip(shell, stateFor(shell), detail.direction);
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.volume, ({ detail }) => {
    if (!shell.video) {
      return;
    }
    shell.media.nudgeVolume(detail.direction);
    shell.toast({
      icon: volumeIcon(shell.volume, false),
      text: volumePercent(shell.volume),
      duration: TUNING.toast.flashMs,
      group: "volume"
    });
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.mute, () => {
    if (!shell.video) {
      return;
    }
    shell.media.toggleMute();
    shell.toast({
      icon: volumeIcon(shell.volume, shell.muted),
      text: shell.muted ? "Muted" : volumePercent(shell.volume),
      duration: TUNING.toast.flashMs,
      group: "volume"
    });
  }, { signal });

  host.addEventListener(GESTURE_EVENTS.pinch, ({ detail }) => {
    if (!shell.video) {
      return;
    }
    const state = stateFor(shell);
    const video = shell.video;
    if (detail.direction === "out" && !state.fillActive) {
      const scale = computeCoverScale(video, shell.referenceBox);
      if (scale <= 1) {
        return;
      }
      gestureHaptic("pinch");
      easeTransformTo(video, `scale(${scale})`);
      state.fillActive = true;
      shell.toast({
        icon: "fill-aspect",
        text: "Fill Mode",
        duration: TUNING.toast.flashMs,
        group: "pinch"
      });
    } else if (detail.direction === "in" && state.fillActive) {
      clearFillMode(shell, state);
    }
  }, { signal });
}
