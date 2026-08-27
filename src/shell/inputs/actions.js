import { getSetting, TUNING } from "../chrome/config.js";
import { formatTime } from "../../shared/time.js";

/**
 * The gesture event contract: semantic CustomEvents dispatched by the
 * InputForge engine onto the shell host, consumed by these bindings (and by
 * the settings panel for its open/close request).
 */
export const GESTURE_EVENTS = {
  hold: "pf:gesture-hold",
  release: "pf:gesture-release",
  scrub: "pf:gesture-scrub",
  scrubEnd: "pf:gesture-scrub-end",
  swipeStart: "pf:gesture-swipe-start",
  swipe: "pf:gesture-swipe",
  dbltap: "pf:gesture-dbltap",
  skip: "pf:gesture-skip",
  volume: "pf:gesture-volume",
  mute: "pf:gesture-mute",
  panel: "pf:gesture-panel",
  pinch: "pf:gesture-pinch"
};

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
    (!binding.fs || !!document.fullscreenElement);
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
  for (const binding of bindings) {
    if (gateOpen(binding)) {
      return true;
    }
  }
  return false;
}

/** Armed key bindings, in table order - sampled live per keystroke. */
export const KEY_BINDINGS = BY_GESTURE.get("key");

/** Whether a key binding's gates are open right now (live per read). */
export function isKeyArmed(binding) {
  return gateOpen(binding);
}

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
  shell.skip(direction === "right" ? step : -step);
  shell.toast({
    icon: direction === "right" ? "right-arrows" : "left-arrows",
    text: `${step}s`,
    duration: TUNING.toast.flashMs,
    group: "skip"
  });
}

/**
 * Eased snap for inline video transforms: one curve, shared by fill-mode
 * exit, pinch fill, and swipe/pinch restore. The eased style is stripped by
 * the transition's own end/cancel event - never by a timer - and a newer
 * snap invalidates the previous waiter so no cleanup lands mid-gesture.
 */
const pendingEase = new WeakMap();

export function easeTransformTo(video, transform) {
  pendingEase.get(video)?.();
  const stop = () => {
    video.removeEventListener("transitionend", onEnd);
    video.removeEventListener("transitioncancel", onCancel);
    if (pendingEase.get(video) === stop) {
      pendingEase.delete(video);
      video.style.transition = "";
    }
  };
  const onEnd = (event) => {
    if (event.propertyName === "transform") {
      stop();
    }
  };
  const onCancel = () => stop();
  // Listeners first, styles second: no completion event can slip past us.
  video.addEventListener("transitionend", onEnd);
  video.addEventListener("transitioncancel", onCancel);
  pendingEase.set(video, stop);

  video.style.transition = "transform 0.15s cubic-bezier(0.2, 0, 0, 1)";
  video.style.transform = transform;
}

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
      video.style.transition = "none";
      video.style.transform = "";
      video.style.transition = "";
    }
  }
}

/** Scale factor needed for the video's rendered box to cover the visual viewport. */
function computeCoverScale(video) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) {
    return 0;
  }
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  if (!viewportWidth || !viewportHeight) {
    return 0;
  }
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return 0;
  }
  const aspect = videoWidth / videoHeight;
  const fittedWidth = Math.min(rect.width, rect.height * aspect);
  const fittedHeight = Math.min(rect.height, rect.width / aspect);
  return Math.max(viewportWidth / fittedWidth, viewportHeight / fittedHeight);
}

function volumeIcon(volume, muted) {
  return muted ? "muted"
    : volume > 0.7 ? "volume-1"
    : volume > 0.4 ? "volume-2" : "volume-3";
}

/**
 * Wire the shell-facing side of the bindings onto the shell host: semantic
 * events dispatched by the engine run these handlers. All listeners share
 * the engine's AbortSignal, so destroying the engine tears the actions down.
 */
export function attachInputActions(shell, host, signal) {
  /** Fullscreen exit also collapses fill mode - the one cross-feature rule. */
  shell.bus.addEventListener("pf:shell-fullscreen-change", (event) => {
    const { shellId, fullscreen } = event.detail;
    if (shellId === shell.id && !fullscreen) {
      const state = stateFor(shell);
      if (state.fillActive) {
        clearFillMode(shell, state, false);
      }
    }
  }, { signal });

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
      // finger's real-time speed. Both are normalized by container width so
      // the "1s slow" / "minutes fast" feels are width-independent.
      const width = shell.container?.clientWidth || shell.video?.clientWidth || 640;
      state.scrubbing = true;
      state.scrubDuration = duration;
      state.scrubSlowGain =
        TUNING.scrub.velocity.slowFullWidthSeconds / width;
      state.scrubFastGain =
        TUNING.scrub.velocity.fastFullWidthSeconds / width;
      state.scrubSensitivity = TUNING.controller.scrubSensitivity / 150;
      state.scrubDirectionMomentum = 0;
    }

    if (Math.abs(detail.dx) < TUNING.scrub.deadZonePx) {
      return;
    }

    // Proportional velocity curve: t in [0,1] as |velocity| rises past the
    // knee, so slow scrubbing stays near the 1s floor while fast scrubbing
    // eases toward the minutes ceiling. Sampled live each move, the seek
    // amount tracks the hand's current velocity in real time.
    const v = Math.abs(detail.velocity);
    const t = Math.min(1, (v / TUNING.scrub.velocity.kneeVelocityPxS) ** TUNING.scrub.velocity.exponent);
    const gain = state.scrubSlowGain + (state.scrubFastGain - state.scrubSlowGain) * t;
    const deltaSeconds = detail.dx * gain * state.scrubSensitivity;
    shell.scrubTo(shell.currentTime + deltaSeconds);
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
    if (detail.zone === "left-edge" || detail.zone === "right-edge") {
      performSkip(shell, stateFor(shell), detail.zone === "left-edge" ? "left" : "right");
    } else if (detail.zone === "screen") {
      shell.togglePlay();
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
      text: `${Math.round(shell.volume * 100)}%`,
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
      text: shell.muted ? "Muted" : `${Math.round(shell.volume * 100)}%`,
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
      const scale = computeCoverScale(video);
      if (scale <= 1) {
        return;
      }
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
