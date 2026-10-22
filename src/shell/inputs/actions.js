import { getSetting, onSettingsChanged, SETTING_KEYS } from "../chrome/config.js";
import { TUNING, formatTime, EASE_SNAPPY_CURVE, EASE_SNAPPY_MS } from "../../shared/core.js";
import { fs, subscribeFullscreen } from "../../shared/dom.js";
import { GESTURE_EVENTS, GESTURES, GESTURE_IDS } from "../../kernel/contract.js";

export { GESTURE_EVENTS };

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
 *   - sticky-user-activation + hardware presence via feature detection (all
 *     `vibrate` returns on failure is false / a no-op).
 * Never throws.
 */

/** Distinct pulse shapes per gesture, in milliseconds (vibrate / pause / ...). */
const HAPTIC_PATTERNS = {
  /** Speed-up hold engaged. */
  hold: 12,
  /** Scrub session latched. */
  scrub: [10, 24, 10],
  /** Pinch-fill engaged or released. */
  pinch: [8, 14, 8, 14, 8],
  /** Fullscreen double-tap committed (skip/toggle). */
  dbltap: [14, 40, 14],
  /** Swipe gesture committed (exit fullscreen). */
  swipe: [10, 30, 10]
};

const canVibrate = typeof navigator?.vibrate === "function";

/** Fire the haptic pulse for `type` when armed (setting, motion, activation). */
export function gestureHaptic(type) {
  if (!canVibrate || !getSetting(SETTING_KEYS.haptics)) {
    return;
  }
  const pattern = HAPTIC_PATTERNS[type];
  if (pattern != null) {
    try {
      navigator.vibrate(pattern);
    } catch {}
  }
}

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
  { id: "hold-speed", gesture: "hold", setting: GESTURES.hold.setting, fs: false },
  { id: "drag-scrub", gesture: "scrub", setting: GESTURES.scrub.setting, fs: true },
  { id: "drag-swipe", gesture: "swipe", setting: GESTURES.swipe.setting, fs: true },
  { id: "double-tap", gesture: "dbltap", setting: GESTURES.dbltap.setting, fs: true },
  { id: "pinch-fill", gesture: "pinch", setting: GESTURES.pinch.setting, fs: true },

  // - Keyboard -
  {
    id: "key-skip-right", gesture: "key", code: "ArrowRight", emit: GESTURE_EVENTS.skip,
    direction: "right", setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-skip-left", gesture: "key", code: "ArrowLeft", emit: GESTURE_EVENTS.skip,
    direction: "left", setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-volume-up", gesture: "key", code: "ArrowUp", emit: GESTURE_EVENTS.volume,
    direction: "up", setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-volume-down", gesture: "key", code: "ArrowDown", emit: GESTURE_EVENTS.volume,
    direction: "down", setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-mute", gesture: "key", code: "KeyM", emit: GESTURE_EVENTS.mute,
    setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-pip", gesture: "key", code: "KeyP", emit: GESTURE_EVENTS.pip,
    setting: SETTING_KEYS.hotkeys, fs: false
  },
  {
    id: "key-panel", gesture: "key", code: "KeyS", emit: GESTURE_EVENTS.panel,
    setting: SETTING_KEYS.hotkeys, fs: false, allowControlFocus: true
  }
];

/** Whether a binding's gates are open right now. */
function gateOpen(binding) {
  return (!binding.setting || getSetting(binding.setting)) &&
    (!binding.fs || fs);
}

/**
 * The unified gate table. One class owns the whole gate dimension - settings
 * x fullscreen x gesture family - that used to live as module-level `let`s
 * and free functions:
 *   - the table buckets INPUT_BINDINGS by gesture family natively
 *     (`Map.groupBy`, Chromium 117+), so decision-point scans skip the mass
 *     of unrelated records; entries keep table order;
 *   - a per-family snapshot re-samples on the settings bus, so pointer-intent
 *     decision points read flat map entries instead of walking the binding
 *     tables at display rate. The two inputs gateOpen folds (a settings key
 *     and the fullscreen latch) only ever change on their buses (settings) or
 *     the shared fs binding (fullscreen), so sampling them at change time
 *     instead of at pointer-move time is exactly as fresh;
 *   - the snapshot revalidates against the live `fs` read on every query:
 *     the gate's initFullscreenGate rebind resyncs `fs` silently (no
 *     subscriber fan-out), and a snapshot that missed such a resync would arm
 *     fullscreen-only intents on an inline page.
 * Key bindings stay live-sampled per keystroke (keyArmed) - once per
 * keypress is not a hot path.
 */
class IntentGates {
  #bindings = Map.groupBy(INPUT_BINDINGS, (binding) => binding.gesture);
  /** gesture family -> any binding armed. */
  #armed = new Map();
  /** Precomputed OR over GESTURE_IDS (all of which are pointer intents):
   *  pointerdown ownership checked this via a 5-entry `.some(allowsIntent)`
   *  scan per press (and again from #dominatesPress); one boolean read
   *  replaces both. */
  #anyPointer = false;
  /** Fullscreen value the snapshot was taken against. */
  #fsStamp = false;

  constructor() {
    this.#recompute();
    onSettingsChanged(() => this.#recompute());
  }

  /** Re-sample every family's gate snapshot against live settings + fs. */
  #recompute() {
    let anyPointer = false;
    for (const [gesture, bindings] of this.#bindings) {
      let open = false;
      for (let i = 0; i < bindings.length; i++) {
        if (gateOpen(bindings[i])) {
          open = true;
          break;
        }
      }
      this.#armed.set(gesture, open);
    }
    for (let i = 0; i < GESTURE_IDS.length; i++) {
      if (this.#armed.get(GESTURE_IDS[i]) === true) {
        anyPointer = true;
        break;
      }
    }
    this.#anyPointer = anyPointer;
    this.#fsStamp = fs;
  }

  /** Key bindings for a family, in table order. */
  forGesture(gesture) {
    return this.#bindings.get(gesture);
  }

  /** True when at least one binding for the pointer-intent family is armed.
   *  Mid-session toggles still apply at the next decision via the fs-validity
   *  recheck. */
  allows(gesture) {
    if (fs !== this.#fsStamp) {
      this.#recompute();
    }
    return this.#armed.get(gesture) === true;
  }

  /** Any pointer-intent family member armed - the press-ownership gate. Same
   *  snapshot revalidation as allows(), without the per-call scan. */
  anyPointer() {
    if (fs !== this.#fsStamp) {
      this.#recompute();
    }
    return this.#anyPointer;
  }

  /** Whether a key binding's gates are open right now (live per read). */
  keyArmed(binding) {
    return gateOpen(binding);
  }
}

const gates = new IntentGates();

/** Armed key bindings, in table order - sampled live per keystroke. */
export const KEY_BINDINGS = gates.forGesture("key");

export function allowsIntent(gesture) {
  return gates.allows(gesture);
}

export function allowsAnyIntent() {
  return gates.anyPointer();
}

export function isKeyArmed(binding) {
  return gates.keyArmed(binding);
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
/** Ignore cover-scale changes below this fraction of a scale step (sub-pixel). */
const FILL_SCALE_EPSILON = 0.001;

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
 */

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

  // WAAPI path (Chromium baseline): one compositor animation from the current
  // transform to the target. On finish the final value is committed to an
  // inline style and the animation is cancelled so its fill gives way; on
  // cancel (via stop() or supersession) the layer is dropped immediately.
  if (typeof video.animate === "function") {
    // Start frame: the inline style is already the committed truth after any
    // of our own commits (and the swipe stroke's direct writes), so the
    // computed-style read only pays off for videos a host stylesheet
    // transforms. Prior cancellation above guarantees the inline value is
    // the live visual even when an animation was in flight.
    const animation = video.animate(
      [
        { transform: video.style.transform || getComputedStyle(video).transform || "none" },
        { transform: transform || "none" }
      ],
      { duration: EASE_SNAPPY_MS, easing: EASE_SNAPPY_CURVE, fill: "both" }
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
  video.style.transition = `transform ${EASE_SNAPPY_MS}ms ${EASE_SNAPPY_CURVE}`;
  video.style.transform = transform;
}

/**
 * Scale factor needed for the video to cover the given reference box.
 * Fill mode is fullscreen-only (pinch binding is fs-gated), and the reference
 * (passed from `shell.referenceBox`) is the device screen in fs - the video's
 * rendered box is simply the screen. The scale models the element's content
 * letterboxed by its own ratio (object-fit: contain), which the fill binding
 * (not the embed's possibly-'fill' default) is responsible for setting before
 * applying this scale. No getBoundingClientRect (forced layout) is needed: the
 * fill scale is pure aspect-ratio math between the video's intrinsic ratio and
 * the reference box. Guards return 0 so the caller skips fill when the video
 * size or reference isn't known yet.
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
 * Per-shell action machine. The old `stateFor` WeakMap-of-literal factory
 * plus free functions taking `(shell, state, ...)` became one class: every
 * piece of per-shell action state is a private field (declared ONCE, in the
 * same order the literal used, so the shape never morphs to a second hidden
 * class), and every semantic gesture event runs one method on the instance.
 */
class ShellActions {
  #shell;
  #savedRate = 1;
  #activeHolds = new Set();
  #scrubbing = false;
  #scrubDuration = 0;
  #scrubSlowGain = 0;
  #scrubFastGain = 0;
  #scrubSensitivity = 0;
  #scrubDirectionMomentum = 0;
  #lastScrubToastAt = 0;
  #scrubToastText = null;
  #scrubToastSecDuration = NaN;
  #scrubToastSecCurrent = NaN;
  // rVFC-backed readout: mediaTime of the last frame actually presented
  // this scrub (decoder currentTime can lead/lag the display - same
  // rationale as resume.js's pause flush), the video the loop was armed
  // on (SPA swap guard), and the pending callback handle.
  #scrubPresentedTime = null;
  #scrubRvfcVideo = null;
  #scrubRvfcId = 0;
  // Pooled payload for the 100ms scrub tick: the toast manager
  // destructures it synchronously (it never retains the object), so the
  // same 3-field object is refilled in place instead of re-allocated
  // every tick of a drag - same mutate-in-place discipline as the
  // gesture detail objects.
  #scrubToast = { icon: "left-arrows", text: "", group: "scrub" };
  #streakCount = 0;
  #lastSkipDirection = null;
  #streakResetAt = 0;
  #fillActive = false;
  // Cover scale currently applied to the video (1 = none). Re-derives
  // the fill transform when the video's intrinsic size changes mid-fill.
  #fillScale = 1;
  // Captured on fill entry: the element box is handed back to the embed's
  // original object-fit once the transform is released.
  #priorObjectFit = "";

  constructor(shell) {
    this.#shell = shell;
  }

  /** Cancel the scrub's frame loop if one is armed; safe to call any time. */
  #cancelScrubFrameLoop() {
    if (this.#scrubRvfcVideo) {
      this.#scrubRvfcVideo.cancelVideoFrameCallback?.(this.#scrubRvfcId);
      this.#scrubRvfcVideo = null;
      this.#scrubRvfcId = 0;
    }
    this.#scrubPresentedTime = null;
  }

  /**
   * Skip with the streak: same-direction hits accumulate up to the streak cap
   * and decay lazily by the reset window instead of a wake-up timer.
   */
  #skip(direction) {
    // The command plane no-ops a skip before the timeline exists; bail here too
    // so the streak state and the "Ns" readout don't advance for a dead command.
    if (!this.#shell.media.ready) {
      return;
    }
    const now = performance.now();
    const streakMax = TUNING.controller.streakMax;
    // A streak decays lazily by its reset window instead of a wake-up timer.
    if (now - this.#streakResetAt >= TUNING.gestures.streakResetMs) {
      this.#streakCount = 0;
      this.#lastSkipDirection = null;
    }
    if (direction === this.#lastSkipDirection) {
      this.#streakCount = Math.min(this.#streakCount + 1, streakMax);
    } else {
      this.#streakCount = 1;
      this.#lastSkipDirection = direction;
    }
    this.#streakResetAt = now;

    const step = getSetting(SETTING_KEYS.stepSeek) * this.#streakCount;
    this.#shell.media.skip(direction === "right" ? step : -step);
    this.#shell.toastFlash(
      direction === "right" ? "right-arrows" : "left-arrows",
      `${step}s`,
      "skip"
    );
  }

  /**
   * Release pinch/fill scale: flips the fill state off, eases the transform
   * back to none (or snaps it, when `animate` is false - the instant path
   * also cancels any in-flight WAAPI ease and clears will-change), then hands
   * object-fit back to what the embed had before fill mode claimed it. No-op
   * when fill was never active.
   */
  #clearFillMode(animate) {
    const shell = this.#shell;
    if (!this.#fillActive) {
      return;
    }
    this.#fillActive = false;
    const video = shell.video;
    if (video) {
      this.#fillScale = 1;
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
      // Owned on fill entry (see the pinch handler below): hand the element
      // box back to the embed's original object-fit once the transform is
      // released.
      video.style.objectFit = this.#priorObjectFit || "";
      this.#priorObjectFit = "";
    }
  }

  /** Fullscreen exit also collapses fill mode - the one cross-feature rule. */
  #fsExit() {
    if (this.#fillActive) {
      this.#clearFillMode(false);
    }
  }

  /** Hold the pointer/keyboard boost: first source wins, later arrivals add
   *  nothing until the first releases. */
  #hold(detail) {
    const shell = this.#shell;
    if (!shell.media.ready) {
      return;
    }
    const source = detail.method || "pointer";
    if (this.#activeHolds.has(source) || (this.#activeHolds.add(source), this.#activeHolds.size > 1)) {
      return;
    }
    const speed = TUNING.controller.holdSpeed;
    this.#savedRate = shell.playbackRate;
    shell.media.beginBoost(speed);
    gestureHaptic("hold");
    shell.toast({ icon: "right-arrows", text: `${speed}x`, group: "hold" });
  }

  #release(detail) {
    const shell = this.#shell;
    const source = detail.method || "pointer";
    if (!this.#activeHolds.delete(source) || this.#activeHolds.size > 0) {
      return;
    }
    if (shell.video) {
      shell.media.endBoost(this.#savedRate);
    }
    shell.hideToast("hold");
  }

  #scrub(detail) {
    const shell = this.#shell;
    if (!shell.video) {
      return;
    }
    // The producer stamps the real pointer event's DOMHighResTimeStamp on the
    // pooled detail (forge #advanceScrub), on the same timebase as
    // performance.now() and already read - reuse it instead of taking a second
    // clock reading per move. The fallback covers a synthetic producer that
    // left the field unset.
    const now = detail.timestamp || performance.now();
    if (!this.#scrubbing) {
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
      this.#scrubbing = true;
      this.#scrubDuration = duration;
      this.#scrubSlowGain = SCRUB_SLOW_FULL_WIDTH_SECONDS / width;
      this.#scrubFastGain = fastCeiling / width;
      this.#scrubSensitivity = SCRUB_SENSITIVITY;
      this.#scrubDirectionMomentum = 0;
      gestureHaptic("scrub");
      // Frame-accurate readout for this scrub: a short-lived rVFC loop tracks
      // the frame the user actually SAW (post-seek frames fire even while
      // paused), falling back to currentTime until the first one lands.
      this.#cancelScrubFrameLoop();
      const scrubVideo = shell.video;
      if (typeof scrubVideo.requestVideoFrameCallback === "function") {
        this.#scrubRvfcVideo = scrubVideo;
        const onFrame = (_now, metadata) => {
          if (!this.#scrubbing || this.#scrubRvfcVideo !== scrubVideo) {
            return;
          }
          this.#scrubPresentedTime = metadata.mediaTime;
          this.#scrubRvfcId = scrubVideo.requestVideoFrameCallback(onFrame);
        };
        this.#scrubRvfcId = scrubVideo.requestVideoFrameCallback(onFrame);
      }
    }

    if (Math.abs(detail.dx) < SCRUB_DEAD_ZONE_PX) {
      return;
    }

    // Proportional velocity curve: t in [0,1] as |velocity| rises past the
    // knee, so slow scrubbing stays near the 1s floor while fast scrubbing
    // eases toward the duration-scaled ceiling (a fraction of the runtime).
    // Sampled live each move, the seek amount tracks the hand's current
    // velocity in real time and scales with content length.
    //
    // The configured exponent is 1.5, for which x**1.5 == x*sqrt(x); the
    // sqrt form measures ~1.6x faster than the generic pow (4.12 vs 6.60
    // ns/op). The two disagree by 1 ULP on roughly a quarter of inputs -
    // orders of magnitude below the pixel/seek resolution t feeds - so the
    // fast path is gated on the exact exponent and any other config value
    // falls through to pow untouched.
    const v = Math.abs(detail.velocity);
    const ratio = v / SCRUB_KNEE_PX_PER_S;
    const t = Math.min(1, SCRUB_EXPONENT === 1.5 ? ratio * Math.sqrt(ratio) : ratio ** SCRUB_EXPONENT);
    const gain = this.#scrubSlowGain + (this.#scrubFastGain - this.#scrubSlowGain) * t;
    const deltaSeconds = detail.dx * gain * this.#scrubSensitivity;
    // The stroke latched above, so duration is stable - use the latched-seek
    // path so each move skips media's readiness gate + duration re-read.
    shell.media.scrubToLatched(shell.currentTime + deltaSeconds, this.#scrubDuration);
    const instantDirection = detail.dx > 1 ? 1 : detail.dx < -1 ? -1 : 0;
    this.#scrubDirectionMomentum = this.#scrubDirectionMomentum * 0.6 + instantDirection * 0.4;

    if (now - this.#lastScrubToastAt < 100) {
      return;
    }
    this.#lastScrubToastAt = now;
    // Cache the formatted time string: rebuild only when the visible second
    // changes, not every 100ms tick — avoids 3 string allocations per display
    // tick during scrub. Value prefers the presented-frame mediaTime (screen
    // truth); decoder currentTime only until the first post-seek frame lands
    // or when an SPA swap replaced the element mid-scrub.
    const shownTime = (this.#scrubRvfcVideo === shell.video ? this.#scrubPresentedTime : null)
      ?? shell.video.currentTime;
    const secDuration = Math.floor(this.#scrubDuration);
    const secCurrent = Math.floor(shownTime);
    if (secDuration !== this.#scrubToastSecDuration || secCurrent !== this.#scrubToastSecCurrent) {
      this.#scrubToastText = `${formatTime(this.#scrubDuration)} / ${formatTime(shownTime)}`;
      this.#scrubToastSecDuration = secDuration;
      this.#scrubToastSecCurrent = secCurrent;
    }
    const toast = this.#scrubToast;
    toast.icon = this.#scrubDirectionMomentum >= 0 ? "right-arrows" : "left-arrows";
    toast.text = this.#scrubToastText;
    shell.toast(toast);
  }

  #scrubEnd() {
    if (!this.#scrubbing) {
      return;
    }
    this.#scrubbing = false;
    this.#cancelScrubFrameLoop();
    this.#scrubDirectionMomentum = 0;
    this.#scrubDuration = 0;
    this.#scrubSlowGain = 0;
    this.#scrubFastGain = 0;
    this.#scrubSensitivity = 0;
    this.#scrubToastText = null;
    this.#scrubToastSecDuration = NaN;
    this.#scrubToastSecCurrent = NaN;
    this.#shell.hideToast("scrub");
  }

  #swipeStart(detail) {
    if (detail.direction === "down") {
      this.#shell.toast({
        icon: "fs-exiting",
        text: "Exiting Fullscreen",
        group: "fs"
      });
    }
  }

  #swipe(detail) {
    const shell = this.#shell;
    if (detail.direction !== "down") {
      return;
    }
    if (detail.distance > TUNING.gestures.swipeExitMinPx) {
      gestureHaptic("swipe");
      this.#clearFillMode(false);
      shell.toastFlash("fs-exit", "Fullscreen Exited", "fs");
      shell.exitFullscreen();
    } else {
      shell.hideToast("fs");
    }
  }

  /**
   * Fullscreen-only double-tap semantics: edges skip, center toggles
   * playback. Inline double-taps belong to the browser/player natively.
   */
  #dbltap(detail) {
    // Both edge-skip and center-play are inert before the timeline exists; gate
    // the shared haptic too so an unready double-tap is fully silent.
    if (!this.#shell.media.ready) {
      return;
    }
    gestureHaptic("dbltap");
    if (detail.zone === "left-edge" || detail.zone === "right-edge") {
      this.#skip(detail.zone === "left-edge" ? "left" : "right");
    } else if (detail.zone === "screen") {
      this.#shell.media.togglePlay();
    }
  }

  #volume(detail) {
    const shell = this.#shell;
    if (!shell.media.ready) {
      return;
    }
    shell.media.nudgeVolume(detail.direction);
    shell.toastFlash(volumeIcon(shell.volume, false), volumePercent(shell.volume), "volume");
  }

  #mute() {
    const shell = this.#shell;
    if (!shell.media.ready) {
      return;
    }
    shell.media.toggleMute();
    shell.toastFlash(volumeIcon(shell.volume, shell.muted), shell.muted ? "Muted" : volumePercent(shell.volume), "volume");
  }

  // Picture-in-Picture: native always-on-top surface. The browser owns the
  // window lifecycle; we only flip the toggle. Unsupported hosts get a hint
  // instead of a silent no-op, mirroring the fs-block pattern.
  #pip() {
    const shell = this.#shell;
    if (!shell.media.ready) {
      return;
    }
    if (!shell.media.pictureInPictureSupported()) {
      shell.toastInfo("pip", "Picture-in-Picture not supported", "pip");
      return;
    }
    shell.media.togglePictureInPicture().then((active) => {
      shell.toastFlash("pip", active ? "Picture-in-Picture" : "Exited Picture-in-Picture", "pip");
    }).catch(() => {
      shell.toastInfo("pip", "Picture-in-Picture unavailable", "pip");
    });
  }

  #pinch(detail) {
    const shell = this.#shell;
    if (!shell.video) {
      return;
    }
    const video = shell.video;
    if (detail.direction === "out" && !this.#fillActive) {
      const scale = computeCoverScale(video, shell.referenceBox);
      if (scale <= 1) {
        return;
      }
      gestureHaptic("pinch");
      // Own object-fit: computeCoverScale models the element content letterboxed
      // by its own ratio (contain). The embed may use the UA default 'fill', so
      // normalize to 'contain' here; #clearFillMode restores the prior value.
      this.#priorObjectFit = video.style.objectFit;
      video.style.objectFit = "contain";
      easeTransformTo(video, `scale(${scale})`);
      this.#fillActive = true;
      this.#fillScale = scale;
      shell.toastFlash("fill-aspect", "Fill Mode", "pinch");
    } else if (detail.direction === "in" && this.#fillActive) {
      this.#clearFillMode(true);
    }
  }

  /**
   * Re-derive fill mode's frozen cover scale when the video's intrinsic size
   * arrives late (preload="none") or changes mid-fill (adaptive stream
   * switch): when the new ratio no longer needs cover, release fill entirely.
   * `resize` on a <video> is the native signal for an intrinsic-size change;
   * loadedmetadata catches the ratio becoming known.
   */
  #refill() {
    const video = this.#shell.video;
    if (!video || !this.#fillActive) {
      return;
    }
    const scale = computeCoverScale(video, this.#shell.referenceBox);
    if (!scale) {
      return;
    }
    if (scale <= 1) {
      this.#clearFillMode(true);
      return;
    }
    if (Math.abs(scale - this.#fillScale) > FILL_SCALE_EPSILON) {
      this.#fillScale = scale;
      easeTransformTo(video, `scale(${scale})`);
    }
  }

  /**
   * Wire the shell-facing side of the bindings onto the shell host: semantic
   * events dispatched by the engine run the handlers above. All listeners
   * share the engine's AbortSignal, so destroying the engine tears the
   * actions down.
   */
  attach(host, signal) {
    const shell = this.#shell;

    subscribeFullscreen(() => this.#fsExit(), signal);

    host.addEventListener(GESTURE_EVENTS.hold, ({ detail }) => this.#hold(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.release, ({ detail }) => this.#release(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.scrub, ({ detail }) => this.#scrub(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.scrubEnd, () => this.#scrubEnd(), { signal });

    // rVFC ids aren't AbortSignal-cancellable: drop any live scrub frame loop
    // with the same scope signal these listeners die on (shell teardown can
    // land mid-scrub, and the re-arming callback would otherwise outlive us).
    signal.addEventListener("abort", () => this.#cancelScrubFrameLoop(), { once: true });

    host.addEventListener(GESTURE_EVENTS.swipeStart, ({ detail }) => this.#swipeStart(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.swipe, ({ detail }) => this.#swipe(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.dbltap, ({ detail }) => this.#dbltap(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.skip, ({ detail }) => this.#skip(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.volume, ({ detail }) => this.#volume(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.mute, () => this.#mute(), { signal });
    host.addEventListener(GESTURE_EVENTS.pip, () => this.#pip(), { signal });
    host.addEventListener(GESTURE_EVENTS.pinch, ({ detail }) => this.#pinch(detail), { signal });

    // Fill mode's scale is pure aspect math frozen at the moment of the pinch.
    // Late-arriving or changed intrinsic sizes re-derive it (#refill above).
    shell.video?.addEventListener("resize", () => this.#refill(), { signal });
    shell.video?.addEventListener("loadedmetadata", () => this.#refill(), { signal });
  }
}

/**
 * Wire the shell-facing side of the bindings onto the shell host. One
 * ShellActions instance per attach call owns the shell's action state.
 */
export function attachInputActions(shell, host, signal) {
  new ShellActions(shell).attach(host, signal);
}
