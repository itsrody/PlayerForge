import { getSetting, onSettingsChanged, SETTING_KEYS } from "../chrome/config.js";
import { TUNING, clamp, formatTime, EASE_SNAPPY_CURVE, EASE_SNAPPY_MS } from "../../shared/core.js";
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
function gestureHaptic(type) {
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
 * Declarative input policy - the single source, gathered by FUNCTION.
 *
 * One record per user-facing action; each record's `inputs` array collects
 * every physical trigger that can fire it. The motivating case is hold-to-
 * speed: a held pointer press and a held Space key are the SAME function -
 * one boost rate, one toast, one haptic, one release story - so the row
 * defines the action (its `speed` parameter, the product fact the action
 * layer reads) and both triggers ride its `inputs`, instead of the old
 * split that shipped the pointer hold as a table row and the Space hold
 * as a hardcoded engine branch keyed on event.code. Adding a trigger to
 * hold-to-speed means adding one input to this row - no engine change.
 *
 * Input kinds:
 *   pointer - a gesture-registry family id (kernel/contract.js GESTURES);
 *             the engine's stroke machine owns recognition, and the
 *             setting/fs fields gate it the way the old per-family rows
 *             did.
 *   key     - a KeyboardEvent.code carrying either an `event` handle
 *             (one-shot: the semantic event fires on keydown) or
 *             `session: true` (keydown arms the action's hold window,
 *             keyup releases it - the key-session machine shared with the
 *             pointer hold). A session key names the FAMILY it belongs to
 *             and consults that family's pointer gate at arm time - the
 *             same allowsIntent read that arms the pointer hold - and it
 *             deliberately carries no `setting`, so the hotkeys toggle
 *             keeps never governing Space; `toggleOnTap` preserves the
 *             bare-tap play/pause the UA's space-activates-video behavior
 *             hands over.
 * Gates stay per input, so unifying the definition changed no behavior.
 */
const INPUT_ACTIONS = [
  {
    id: "hold-speed",
    speed: TUNING.controller.holdSpeed,
    inputs: [
      { kind: "pointer", family: "hold", setting: GESTURES.hold.setting, fs: false },
      { kind: "key", code: "Space", family: "hold", session: true, toggleOnTap: true, fs: false }
    ]
  },
  {
    id: "scrub",
    inputs: [{ kind: "pointer", family: "scrub", setting: GESTURES.scrub.setting, fs: true }]
  },
  {
    id: "swipe",
    inputs: [{ kind: "pointer", family: "swipe", setting: GESTURES.swipe.setting, fs: true }]
  },
  {
    id: "double-tap",
    inputs: [{ kind: "pointer", family: "dbltap", setting: GESTURES.dbltap.setting, fs: true }]
  },
  {
    id: "pinch-fill",
    inputs: [{ kind: "pointer", family: "pinch", setting: GESTURES.pinch.setting, fs: true }]
  },
  {
    id: "skip",
    inputs: [
      { kind: "key", code: "ArrowRight", event: GESTURE_EVENTS.skip, direction: "right", setting: SETTING_KEYS.hotkeys, fs: false },
      { kind: "key", code: "ArrowLeft", event: GESTURE_EVENTS.skip, direction: "left", setting: SETTING_KEYS.hotkeys, fs: false }
    ]
  },
  {
    id: "volume",
    inputs: [
      { kind: "key", code: "ArrowUp", event: GESTURE_EVENTS.volume, direction: "up", setting: SETTING_KEYS.hotkeys, fs: false },
      { kind: "key", code: "ArrowDown", event: GESTURE_EVENTS.volume, direction: "down", setting: SETTING_KEYS.hotkeys, fs: false }
    ]
  },
  {
    id: "mute",
    inputs: [{ kind: "key", code: "KeyM", event: GESTURE_EVENTS.mute, setting: SETTING_KEYS.hotkeys, fs: false }]
  },
  {
    id: "pip",
    inputs: [{ kind: "key", code: "KeyP", event: GESTURE_EVENTS.pip, setting: SETTING_KEYS.hotkeys, fs: false }]
  },
  {
    id: "panel",
    inputs: [{ kind: "key", code: "KeyS", event: GESTURE_EVENTS.panel, setting: SETTING_KEYS.hotkeys, fs: false, allowControlFocus: true }]
  }
];

// Table integrity, checked at import (the flaws gate's smoke catches it):
// every pointer family and every session key's family must live in the
// gesture registry - the registry stays the single vocabulary, and a
// hand-spelled family id here would otherwise silently arm nothing.
for (const action of INPUT_ACTIONS) {
  for (const input of action.inputs) {
    if (input.kind !== "key" && !GESTURES[input.family]) {
      throw new TypeError(`input action ${action.id}: family ${input.family} is not in the gesture registry`);
    }
  }
}

/** The pointer intent inputs, in table order - the IntentGates buckets. */
const POINTER_INTENTS = INPUT_ACTIONS.flatMap((action) =>
  action.inputs.filter((input) => input.kind === "pointer")
);

/** The key inputs, in table order - flat for the engine's keydown walk.
 *  Session rows (hold keys) ride the same list as one-shot rows; the
 *  engine distinguishes them by the `session` field. */
export const KEY_BINDINGS = INPUT_ACTIONS.flatMap((action) =>
  action.inputs.filter((input) => input.kind === "key")
);

/** The hold boost rate, read once from the action definition that owns it. */
const HOLD_SPEED =
  INPUT_ACTIONS.find((action) => action.id === "hold-speed")?.speed ??
  TUNING.controller.holdSpeed;

/** Whether an input row's gates are open right now. */
function gateOpen(input) {
  return (!input.setting || getSetting(input.setting)) &&
    (!input.fs || fs);
}

/**
 * The unified gate table. One class owns the whole gate dimension - settings
 * x fullscreen x gesture family - that used to live as module-level `let`s
 * and free functions:
 *   - the table buckets the actions' pointer inputs by gesture family
 *     natively (`Map.groupBy`, Chromium 117+), so decision-point scans skip
 *     the mass of unrelated rows; entries keep table order;
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
 * Key inputs stay live-sampled per keystroke (keyArmed) - once per keypress
 * is not a hot path.
 */
class IntentGates {
  /** The pointer inputs bucketed by family. */
  #families = Map.groupBy(POINTER_INTENTS, (input) => input.family);
  /** family -> any input armed. */
  #armed = new Map();
  /** Precomputed OR over GESTURE_IDS (all of which are pointer intents):
   *  the fixed cost of the `allowsAnyIntent` seam - one boolean read per
   *  press replaces the 5-entry `.some(allowsIntent)` scan the ownership
   *  decision used to run. */
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
    for (const [family, inputs] of this.#families) {
      let open = false;
      for (let i = 0; i < inputs.length; i++) {
        if (gateOpen(inputs[i])) {
          open = true;
          break;
        }
      }
      this.#armed.set(family, open);
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

  /** True when at least one input of the pointer-intent family is armed.
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

  /** Whether a key input's gates are open right now (live per read). */
  keyArmed(input) {
    return gateOpen(input);
  }
}

const gates = new IntentGates();

export function allowsIntent(gesture) {
  return gates.allows(gesture);
}

export function allowsAnyIntent() {
  return gates.anyPointer();
}

export function isKeyArmed(input) {
  return gates.keyArmed(input);
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
const SCRUB_SENSITIVITY =
  TUNING.controller.scrubSensitivity / TUNING.controller.scrubSensitivityAnchor;
/** Ignore cover-scale changes below this fraction of a scale step (sub-pixel). */
const FILL_SCALE_EPSILON = 0.001;

/**
 * Skip streak state for one shell. Same-direction skips accumulate up to the
 * streak cap and decay lazily by the reset window instead of a wake-up timer:
 * the skip command runs once per tap, so no timer can outlive the taps and
 * the common case (one tap) never schedules anything.
 *
 * This is the whole streak story - one class owns it, so the skip command in
 * ShellActions reads as math on a returned step rather than state juggling.
 */
class SkipStreak {
  #count = 0;
  #lastDirection = null;
  #resetAt = 0;

  /** Record one skip: lazily decay, then accumulate (or restart) the streak.
   *  Returns the step multiplier (1 = no streak). */
  record(direction, now) {
    if (now - this.#resetAt >= TUNING.gestures.streakResetMs) {
      this.#count = 0;
      this.#lastDirection = null;
    }
    if (direction === this.#lastDirection) {
      this.#count = Math.min(this.#count + 1, TUNING.controller.streakMax);
    } else {
      this.#count = 1;
      this.#lastDirection = direction;
    }
    this.#resetAt = now;
    return this.#count;
  }
}

/**
 * One activated scrub session's state machine (the seek half of the scrub
 * gesture - the recognition half lives in forge.js and arrives here as
 * semantic scrub events). Owns the latch, the velocity-proportional gain
 * setup, the display-clock commit loop, and the toast cadence, so
 * ShellActions only routes: scrub detail in, seek + display out.
 *
 * State notes:
 *   - Input and commit are decoupled by the native display clock. Pointer
 *     moves only translate into pending seconds; requestAnimationFrame -
 *     the compositor tick Chromium drives painting (and drains the pointer
 *     stream) by - commits one clamped seek per tick and advances the
 *     toast from the AUTHORED target. Seek truth beats frame truth here:
 *     the presented-frame readout this machine once kept ran 1-3 frames
 *     plus decode latency behind the finger, which is the visible lag the
 *     field pinned. The readout's contract is the destination, and
 *     presented-frame truth has its real home in resume.js, where a save
 *     position must be what is actually on screen.
 *   - The gains lock at latch time (duration + box width are frozen for the
 *     stroke) so each commit skips media's readiness gate + duration re-read.
 *   - The toast payload is one pooled object refilled in place: the toast
 *     manager destructures synchronously, so a 100ms display tick never
 *     allocates (same discipline as the gesture detail objects).
 */
class ScrubSession {
  #shell;
  /** Latch: active while a stroke runs (recognizer events keep routing here). */
  #active = false;
  #duration = 0;
  #slowGain = 0;
  #fastGain = 0;
  #sensitivity = 0;
  /** Signed display momentum (-1 left .. +1 right), first-order smoothed; picks
   *  the seek toast's icon from the stroke's average direction. */
  #momentum = 0;
  /** Sub-pixel residue from the dead zone's unapplied micro-travel, in px. */
  #residual = 0;
  /** Commit pipeline: uncommitted pending seconds since the last compositor
   *  tick, the loop handle (0 = disarmed), and the target time the last
   *  committed seek authored (the readout's truth). */
  #pendingDelta = 0;
  #rafId = 0;
  #authoredTarget = null;
  #lastToastAt = 0;
  #toastText = null;
  #toastSecDuration = NaN;
  #toastSecCurrent = NaN;
  #toast = { icon: "left-arrows", text: "", group: "scrub" };

  constructor(shell) {
    this.#shell = shell;
  }

  get active() {
    return this.#active;
  }

  /** Stop the commit loop; safe to call any time. Uncommitted travel flushes
   *  at end(); a scope abort (shell teardown) drops it instead - the video is
   *  going away. */
  stopCommitLoop() {
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
  }

  /** One compositor tick: commit the stroke's accrued travel as ONE clamped
   *  seek, then re-arm while the session lives. The anchor is the decoder's
   *  currentTime - the only writer between commits is this loop, and natural
   *  playback advance folds in through the same read, so pending scrub
   *  travel never double-counts it. */
  #tick() {
    if (!this.#active) {
      return;
    }
    this.#ensureCommitLoop();
    if (this.#pendingDelta === 0) {
      return;
    }
    const pending = this.#pendingDelta;
    this.#pendingDelta = 0;
    const shell = this.#shell;
    const t = clamp(shell.currentTime + pending, 0, this.#duration);
    // The latched-seek path: readiness was verified at latch, so the commit
    // skips media's readiness gate + duration re-read.
    shell.media.scrubToLatched(t, this.#duration);
    this.#authoredTarget = t;
  }

  /** Disarm if nothing armed, then arm one compositor tick. */
  #ensureCommitLoop() {
    if (this.#rafId) {
      return;
    }
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0;
      this.#tick();
    });
  }

  /** One scrub move: latches on the first (bails before the timeline exists),
   *  then seeks proportionally to real-time velocity and drives the toast. */
  scrub(detail) {
    const shell = this.#shell;
    // The producer stamps the real pointer event's DOMHighResTimeStamp on the
    // pooled detail (forge #advanceScrub), on the same timebase as
    // performance.now() and already read - reuse it instead of taking a second
    // clock reading per move. The fallback covers a synthetic producer that
    // left the field unset.
    const now = detail.timestamp || performance.now();
    if (!this.#active) {
      const duration = shell.duration;
      if (!duration || !Number.isFinite(duration)) {
        return;
      }
      // Velocity-proportional seek: gain (seconds per pixel) rises with the
      // finger's real-time speed. Width-normalized so the feel is independent
      // of container size; the fast ceiling scales with the playback DURATION
      // so a fast stroke traverses a fraction of the runtime on any length,
      // while the slow floor stays a deliberate ~1s. The reference is the
      // unified `shell.referenceBox` (fs -> fs element box, inline ->
      // container), so scrub always normalizes against the correct
      // contextual box.
      const width = shell.referenceBox.width || 640;
      const fastCeiling = duration * SCRUB_FAST_FULL_WIDTH_FRACTION;
      this.#active = true;
      this.#duration = duration;
      this.#slowGain = SCRUB_SLOW_FULL_WIDTH_SECONDS / width;
      this.#fastGain = fastCeiling / width;
      this.#sensitivity = SCRUB_SENSITIVITY;
      this.#momentum = 0;
      // Session-start hygiene: the previous stroke's commit backlog and toast
      // cadence must not read into this one - #pendingDelta would otherwise
      // seek off an unexpected offset, and #lastToastAt could swallow the
      // opening toast of a quickly repeated stroke.
      this.#pendingDelta = 0;
      this.#authoredTarget = null;
      this.#lastToastAt = 0;
      gestureHaptic("scrub");
    }

    // Sub-pixel dead zone with a residue accumulator: a holding finger's
    // jitter alternates sign and nets to ~zero, while a genuine slow
    // stroke's per-move travel is sub-pixel at pointer-stream rates (a
    // 24px/s drag is 0.4px per move at 60Hz) - per-event dropping would
    // starve exactly the slow scrub the velocity curve's 1s floor exists
    // for, so the residue accrues the micro-travel and applies it once a
    // dead zone's worth is real, at the same gain as any other travel.
    const dx = detail.dx + this.#residual;
    if (Math.abs(dx) < SCRUB_DEAD_ZONE_PX) {
      this.#residual = dx;
      return;
    }
    this.#residual = 0;

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
    const gain = this.#slowGain + (this.#fastGain - this.#slowGain) * t;
    const deltaSeconds = dx * gain * this.#sensitivity;
    // Accumulate, never write: the pointer event only translates into pending
    // travel, and the compositor tick (the loop armed below) commits one
    // seek per display refresh. The input side stays allocation-free and
    // independent of decode latency; the screen commits what the display clock
    // can show.
    this.#pendingDelta += deltaSeconds;
    this.#ensureCommitLoop();
    const instantDirection = dx > 1 ? 1 : dx < -1 ? -1 : 0;
    this.#momentum = this.#momentum * 0.6 + instantDirection * 0.4;

    if (now - this.#lastToastAt < 100) {
      return;
    }
    this.#lastToastAt = now;
    // Cache the formatted time string: rebuild only when the visible second
    // changes, not every 100ms tick - avoids 3 string allocations per display
    // tick during scrub. The readout is the authored target - the seek
    // destination the stroke intends, one commit behind at most. The decoder
    // read covers the pre-first-commit instant.
    const shownTime = this.#authoredTarget ?? shell.currentTime;
    const secDuration = Math.floor(this.#duration);
    const secCurrent = Math.floor(shownTime);
    if (secDuration !== this.#toastSecDuration || secCurrent !== this.#toastSecCurrent) {
      this.#toastText = `${formatTime(this.#duration)} / ${formatTime(shownTime)}`;
      this.#toastSecDuration = secDuration;
      this.#toastSecCurrent = secCurrent;
    }
    this.#toast.icon = this.#momentum >= 0 ? "right-arrows" : "left-arrows";
    this.#toast.text = this.#toastText;
    shell.toast(this.#toast);
  }

  /** End the stroke: the last accrued travel commits as one final seek (the
   *  committed shape owns the resting position), then everything below
   *  unwinds to the resting shape. Committing directly drives the same
   *  latched-seek path #tick uses; #active already reads false so any
   *  in-flight tick after this point drops out. */
  end() {
    const pending = this.#pendingDelta;
    const duration = this.#duration;
    this.#active = false;
    this.#pendingDelta = 0;
    this.#authoredTarget = null;
    this.stopCommitLoop();
    if (pending !== 0 && duration > 0) {
      this.#shell.media.scrubToLatched(clamp(this.#shell.currentTime + pending, 0, duration), duration);
    }
    this.#momentum = 0;
    this.#residual = 0;
    this.#duration = 0;
    this.#slowGain = 0;
    this.#fastGain = 0;
    this.#sensitivity = 0;
    this.#toastText = null;
    this.#toastSecDuration = NaN;
    this.#toastSecCurrent = NaN;
    this.#shell.hideToast("scrub");
  }
}

/**
 * Eased snap for inline video transforms: one curve, shared by fill-mode
 * exit, pinch fill, and swipe/pinch restore. A newer snap cancels the previous
 * in-flight animation so no cleanup can land mid-gesture.
 *
 * Where Element.animate (Web Animations API) is available -
 * Chromium 69+, i.e. this fork's floor guarantees it unconditionally - the
 * snap runs a WAAPI animation on the compositor: one deterministic
 * compositor animation with a real finish/cancel. The video is promoted to
 * its own compositor layer while a transform is live (fill-mode, swipe/pinch
 * restore) so Chromium composites the scale/translate instead of
 * re-rasterizing the media surface every frame; the layer is released once
 * the snap settles (or is cancelled).
 */

/**
 * The eased-snap engine: one per-module instance owns the in-flight cancel
 * handles for every video.
 */
class TransformEase {
  /**
   * One eased snap per video is the invariant; the in-flight cancel handle lives
   * in a WeakMap keyed by the video element rather than as an expando property so
   * the framework never mints new fields on native media elements (same posture
   * as barring video monkey-patches upstream).
   */
  #pending = new WeakMap();

  /** Release the video's compositor layer when this ease owns it. */
  #dropPromotion(video) {
    if (video.style.willChange === "transform") {
      video.style.willChange = "";
    }
  }

  /** Cancel any in-flight ease on `video` (used when the element is torn down). */
  cancel(video) {
    const prior = this.#pending.get(video);
    if (prior) {
      prior();
    }
  }

  to(video, transform) {
    // Cancel any previous snap so a newer one takes sole ownership of the video.
    this.cancel(video);
    if (transform) {
      video.style.willChange = "transform";
    }

    // One compositor animation from the current transform to the target.
    // WAAPI out-animates the will-change + CSS-transition + transitionend
    // puzzle it replaced (one owned cancel handle, real finish/cancel, no
    // transitionend race) - and the floor guarantees the API, so no
    // env-conditional arm lives next to it. On finish the final value is
    // committed to an inline style and the animation is cancelled so its
    // fill gives way; on cancel (via stop() or supersession) the layer is
    // dropped immediately.
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
    const pending = this.#pending;
    const stop = () => {
      if (pending.get(video) !== stop) {
        return;
      }
      pending.delete(video);
      animation.cancel();
    };
    pending.set(video, stop);
    animation.addEventListener("finish", () => {
      if (pending.get(video) !== stop) {
        return;
      }
      // Commit the final transform as inline style, then cancel the animation's
      // fill so the committed style owns the element from here on.
      video.style.transform = transform;
      animation.cancel();
      pending.delete(video);
      this.#dropPromotion(video);
    });
    animation.addEventListener("cancel", () => {
      if (pending.get(video) === stop) {
        pending.delete(video);
        this.#dropPromotion(video);
      }
    });
  }
}

const easer = new TransformEase();

/** Cancel any in-flight ease on `video` (used when the element is torn down). */
export function cancelEase(video) {
  easer.cancel(video);
}

export function easeTransformTo(video, transform) {
  easer.to(video, transform);
}

/**
 * Scale factor needed for the video to cover the given reference box.
 * Fill mode is fullscreen-only (pinch binding is fs-gated), and the reference
 * (passed from `shell.referenceBox`) is the fullscreen element's own box in
 * fs - the device screen incl. the safe area where cover merged on the frame. The scale models the element's content
 * letterboxed by its own ratio (object-fit: contain), which the fill binding
 * (not the embed's possibly-'fill' default) is responsible for setting before
 * applying this scale. No getBoundingClientRect (forced layout) is needed: the
 * fill scale is pure aspect-ratio math between the video's intrinsic ratio and
 * the reference box. Guards return 0 so the caller skips fill when the video
 * size or reference isn't known yet.
 */
function computeCoverScale(video, ref) {
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
 * The viewership transform for one shell: the fullscreen fill mode, the only
 * shape a PlayerForge shell writes into video.style.transform. The ownership
 * boundary is exact: gesture handlers (pinch/swipe in ShellActions) describe
 * INTENT, this class owns the state and every write.
 *
 * Fill is pure aspect math: the video normalizes to `object-fit: contain`
 * (computeCoverScale models the element content letterboxed by its own ratio)
 * and a frozen cover scale composes as `scale(s)` until the video's intrinsic
 * box or its surface changes.
 *
 * Subscriptions (fullscreen flips, intrinsic-size refills) ride the caller's
 * signal, so teardown is one abort.
 */
export class ViewershipTransform {
  #shell;
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

  get fillActive() {
    return this.#fillActive;
  }

  /**
   * Wire this transform's environment: fullscreen flips (fs exit releases
   * the fill) and intrinsic-size refills of a live fill. The forge's capture
   * handler already preventDefaults fullscreen wheels, so nothing here
   * cancels - passive listeners stay cheap.
   */
  attach(signal) {
    const shell = this.#shell;
    subscribeFullscreen((active) => {
      this.#fsExit();
      if (active) {
        this.#applyCompose();
      }
    }, signal);

    // Fill mode's scale is pure aspect math frozen at the moment of the pinch.
    // Late-arriving or changed intrinsic sizes re-derive it.
    shell.video?.addEventListener("resize", () => this.#refill(), { signal });
    shell.video?.addEventListener("loadedmetadata", () => this.#refill(), { signal });
  }

  /**
   * The composed shape: the fill cover scale as one `scale(s)` string.
   * Empty when at rest.
   */
  #composeTransform() {
    const totalScale = this.#fillActive ? this.#fillScale : 1;
    if (totalScale === 1) {
      return "";
    }
    return `scale(${totalScale})`;
  }

  /** Eased re-composition - every fill state change lands here. */
  #applyCompose() {
    const video = this.#shell.video;
    if (video) {
      easeTransformTo(video, this.#composeTransform());
    }
  }

  /**
   * Release pinch/fill scale: flips the fill state off, eases the transform
   * back to none (or snaps it, when `animate` is false - the instant path
   * also cancels any in-flight WAAPI ease and clears will-change), then hands
   * object-fit back to what the embed had before fill mode claimed it.
   * No-op when fill was never active.
   */
  exitFill(animate) {
    const shell = this.#shell;
    if (!this.#fillActive) {
      return;
    }
    this.#fillActive = false;
    const video = shell.video;
    if (video) {
      this.#fillScale = 1;
      const composed = this.#composeTransform();
      if (animate) {
        easeTransformTo(video, composed);
      } else {
        // Cancel any in-flight WAAPI ease first: its fill:'both' would otherwise
        // keep re-applying a scale after the inline style is cleared below.
        easer.cancel(video);
        video.style.transition = "none";
        video.style.transform = composed;
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

  /** Fullscreen exit releases the fill - the one cross-feature rule. */
  #fsExit() {
    if (this.#fillActive) {
      this.exitFill(false);
    }
  }

  /**
   * Pinch-out fill entry: normalize object-fit to 'contain' (computeCoverScale
   * models the element content letterboxed by its own ratio), freeze the cover
   * scale, compose. Returns false when the video needs no cover (0 scale), so
   * the caller's haptic/toast stay silent on a no-op.
   */
  beginFill(video, box) {
    const scale = computeCoverScale(video, box);
    if (scale <= 1) {
      return false;
    }
    this.#priorObjectFit = video.style.objectFit;
    video.style.objectFit = "contain";
    this.#fillActive = true;
    this.#fillScale = scale;
    this.#applyCompose();
    return true;
  }

  /**
   * Re-derive fill mode's frozen cover scale when the video's intrinsic size
   * arrives late (preload="none") or changes mid-fill (adaptive stream
   * switch): when the new ratio no longer needs cover, release fill entirely.
   * `resize` on a <video> is the native signal for an intrinsic-size change;
   * loadedmetadata catches the ratio becoming known.
   */
  #refill() {
    const shell = this.#shell;
    const video = shell.video;
    if (!video || !this.#fillActive) {
      return;
    }
    const scale = computeCoverScale(video, shell.referenceBox);
    if (!scale) {
      return;
    }
    if (scale <= 1) {
      this.exitFill(true);
      return;
    }
    if (Math.abs(scale - this.#fillScale) > FILL_SCALE_EPSILON) {
      this.#fillScale = scale;
      this.#applyCompose();
    }
  }
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
  /** Streak, scrub, and the viewership transform own themselves
   *  (SkipStreak / ScrubSession / shell.view); the fields below are the
   *  hold story only. */
  #streak = new SkipStreak();
  #scrubSess = null;
  #view = null;
  #activeHolds = new Set();
  #savedRate = 1;

  constructor(shell) {
    this.#shell = shell;
    this.#scrubSess = new ScrubSession(shell);
  }

  /**
   * Skip with the streak: same-direction hits accumulate up to the streak cap
   * and decay lazily by the reset window instead of a wake-up timer.
   */
  #skip(direction) {
    // The command plane no-ops a skip before the timeline exists; bail here too
    // so the streak state and the "Ns" readout don't advance for a dead command.
    const shell = this.#shell;
    if (!shell.media.ready) {
      return;
    }
    const step = getSetting(SETTING_KEYS.stepSeek) * this.#streak.record(direction, performance.now());
    shell.media.skip(direction === "right" ? step : -step);
    shell.toastFlash(direction === "right" ? "right-arrows" : "left-arrows", `${step}s`, "skip");
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
    const speed = HOLD_SPEED;
    this.#savedRate = shell.playbackRate;
    shell.media.beginBoost(speed);
    gestureHaptic("hold");
    shell.toast({ icon: "right-arrows", text: `${speed}x`, group: "hold" });
  }

  /**
   * A real pause any time after the boost began kills it. The hold arms on
   * "playing at threshold" - a decision that cannot know a mid-hold pause
   * (site ad breaks, resource end, OS pause) - and leaving the boosted rate
   * latched through that pause means the video resumes at 2x under a finger
   * whose boost-era decision is stale. This is the same teardown the release
   * path uses, applied to every source at once: the rate restores, the set
   * drains (so the trailing stray releases the engine still dispatches
   * no-op harmlessly), the readout drops.
   */
  #cancelHoldOnPause() {
    if (this.#activeHolds.size === 0) {
      return;
    }
    const shell = this.#shell;
    this.#activeHolds.clear();
    if (shell.video) {
      shell.media.endBoost(this.#savedRate);
    }
    shell.hideToast("hold");
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
    // Latch, proportional seek, and the toast cadence are the ScrubSession's
    // story.
    this.#scrubSess.scrub(detail);
  }

  #scrubEnd() {
    this.#scrubSess.end();
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
      this.#view.exitFill(false);
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
    if (detail.direction === "out") {
      if (!this.#view.fillActive && this.#view.beginFill(shell.video, shell.referenceBox)) {
        gestureHaptic("pinch");
        shell.toastFlash("fill-aspect", "Fill Mode", "pinch");
      }
    } else if (detail.direction === "in") {
      if (this.#view.fillActive) {
        this.#view.exitFill(true);
      }
    }
  }

  /**
   * Wire the shell-facing side of the bindings onto the shell host: semantic
   * events dispatched by the engine run the handlers above. All listeners
   * share the engine's AbortSignal, so destroying the engine tears the
   * actions down. The viewership transform's own environment (fullscreen,
   * intrinsic-size refills) arms first - it lives on the shell as shell.view
   * and survives across action re-attach.
   */
  attach(host, signal) {
    const shell = this.#shell;
    this.#view = shell.view;
    this.#view.attach(signal);

    host.addEventListener(GESTURE_EVENTS.hold, ({ detail }) => this.#hold(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.release, ({ detail }) => this.#release(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.scrub, ({ detail }) => this.#scrub(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.scrubEnd, () => this.#scrubEnd(), { signal });
    // Any real pause cancels a live boost (see #cancelHoldOnPause). One
    // permanent listener, signal-scoped; the hot path is one set-size check
    // per real pause, not a per-hold arm/cancel pair.
    shell.video?.addEventListener("pause", () => this.#cancelHoldOnPause(), { signal });
    // The commit loop's cancel rides the same signal-scoped teardown: a shell
    // teardown mid-stroke cannot leave a re-arming display-clock commit behind.
    signal.addEventListener("abort", () => this.#scrubSess.stopCommitLoop(), { once: true });

    host.addEventListener(GESTURE_EVENTS.swipeStart, ({ detail }) => this.#swipeStart(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.swipe, ({ detail }) => this.#swipe(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.dbltap, ({ detail }) => this.#dbltap(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.skip, ({ detail }) => this.#skip(detail.direction), { signal });
    host.addEventListener(GESTURE_EVENTS.volume, ({ detail }) => this.#volume(detail), { signal });
    host.addEventListener(GESTURE_EVENTS.mute, () => this.#mute(), { signal });
    host.addEventListener(GESTURE_EVENTS.pip, () => this.#pip(), { signal });
    host.addEventListener(GESTURE_EVENTS.pinch, ({ detail }) => this.#pinch(detail), { signal });
  }
}

/**
 * One ScrubSession per attach - scrub latch, seek gains, and toast cadence
 * all own themselves.
 */
export function attachInputActions(shell, host, signal) {
  new ShellActions(shell).attach(host, signal);
}
