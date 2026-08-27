import { allowsIntent, isKeyArmed, KEY_BINDINGS, GESTURE_EVENTS, easeTransformTo } from "./actions.js";
import { TUNING } from "../chrome/config.js";
import { SHELL_MARKER } from "../chrome/inject.js";
import { deepestActiveElement, isInsideShell } from "../../shared/shadow.js";

/**
 * Pointer handlers never preventDefault - native pan/scroll over the zone is
 * suppressed by the touch-action CSS set at construction - so every pointer
 * listener can be passive. Only two listeners cancel defaults: the wheel
 * pinch listener (subscribed only while fullscreen) and the click/dblclick
 * suppressors that swallow post-gesture activations.
 */
const PASSIVE_CAPTURE = { capture: true, passive: true };
const WHEEL_CAPTURE = { capture: true, passive: false };

// Gesture calibration hoisted to module consts. TUNING is static (read-only
// after load), so binding these at module scope lets WarpJIT treat them as
// invariant values and fold them, instead of re-running shape-guarded
// property loads on every high-frequency pointer/keyboard event.
const EDGE_ZONE_RATIO = TUNING.gestures.edgeZoneRatio;
const EDGE_ZONE_START = 1 - TUNING.gestures.edgeZoneRatio;
const HOLD_TIMEOUT_MS = TUNING.gestures.holdTimeoutMs;
const HOLD_CANCEL_MOVE_PX = TUNING.gestures.holdCancelMovePx;
const SCROLL_START_PX = TUNING.gestures.scrollStartPx;
const AXIS_DOMINANCE_RATIO = TUNING.gestures.axisDominanceRatio;
const PINCH_MIN_DISTANCE_PX = TUNING.gestures.pinchMinDistancePx;
const PINCH_SCALE_THRESHOLD = TUNING.gestures.pinchScaleThreshold;
const PINCH_BASELINE_DELAY_MS = TUNING.gestures.pinchBaselineDelayMs;
const TRACKPAD_COOLDOWN_MS = TUNING.gestures.trackpadCooldownMs;
const SUPPRESS_WINDOW_MS = TUNING.gestures.suppressWindowMs;
const DOUBLE_TAP_WINDOW_MS = TUNING.gestures.doubleTapWindowMs;
const SCRUB_VELOCITY_TAU_S = TUNING.scrub.velocityFilterMs / 1000;

/** All live input engines, used for keyboard focus arbitration. */
const activeForges = new Set();
let lastActiveForge = null;

/**
 * Reusable scratch for the first two live pointers. The pinch path runs on
 * every two-finger move, so reading the pair into this single object (instead
 * of [...values()].slice(0,2) - two array allocations per move) keeps the hot
 * loop allocation-free for the JIT. Mutated in place; callers must read it
 * immediately.
 */
const firstTwoPointers = { x0: 0, y0: 0, x1: 0, y1: 0 };

function captureFirstTwo(pointers, out) {
  let n = 0;
  for (const point of pointers.values()) {
    if (n === 0) {
      out.x0 = point.x;
      out.y0 = point.y;
    } else {
      out.x1 = point.x;
      out.y1 = point.y;
      return true;
    }
    n = 1;
  }
  return false;
}

/**
 * InputForge engine: pure recognition transport. Turns pointer/keyboard/
 * wheel physics into semantic GESTURE_EVENTS on the shell host; every policy
 * decision (settings gates, fullscreen requirement) is delegated to the
 * declarative INPUT_BINDINGS list, sampled live at each decision point.
 *
 * Gecko 154+ native by design: one AbortSignal owns the entire listener
 * lifetime (destroy() === scope.abort()), all pointer listeners are passive,
 * scrub sampling consumes getCoalescedEvents(), and fullscreen truth is read
 * straight off document.fullscreenElement.
 */
export class InputForge {
  #video;
  #zone;
  #eventTarget;

  #scope = new AbortController();
  #destroyed = false;
  #savedTouchAction;
  #originalPlay;
  #originalPause;

  // Keyboard Space-hold interception.
  #spaceHoldIntercepting = false;

  // Pointer session state.
  #primaryPointerId = null;
  #startX = 0;
  #startY = 0;
  #startTime = 0;
  #holdTimer = null;
  #holding = false;
  /** -Infinity so the very first tap can never match against boot time. */
  #lastTapTime = -Infinity;
  #gestureZone = null;

  // Click/dblclick suppression after gestures.
  #suppressClickPending = false;
  #suppressDblclickPending = false;
  #clickSuppressTimer = null;

  // Scrub state.
  #scrubbing = false;
  #scrubLastX = 0;
  #scrubLastTime = 0;
  #scrubVelocity = 0;

  // Swipe state.
  #swiping = false;
  #swipeDirection = null;
  #swipeBaseTransform = "";

  // Pinch state.
  #pointers = new Map();
  #pinchStartDistance = 0;
  #pinchFired = false;
  #pinchZone = null;
  #pinchInitTimer = null;

  // Keyboard hold state.
  #keyboardHoldTimer = null;
  #keyboardHolding = false;
  #keyboardHoldStart = 0;

  // Trackpad ctrl+wheel pinch cooldown.
  #trackpadPinchCooldown = false;
  /** Whether the (non-passive) wheel pinch listener is currently attached. */
  #trackpadPinchSubscribed = false;
  /** Stable reference so the scoped wheel listener can be removed again. */
  #wheelHandler = null;

  constructor(video, zone, eventTarget) {
    this.#video = video;
    this.#zone = zone;
    this.#eventTarget = eventTarget;
    const { signal } = this.#scope;
    this.#savedTouchAction = zone.style.touchAction;
    zone.style.touchAction = "none";

    this.#originalPlay = video.play.bind(video);
    this.#originalPause = video.pause.bind(video);
    video.play = () => this.#spaceHoldIntercepting ? Promise.resolve() : this.#originalPlay();
    video.pause = () => {
      if (!this.#spaceHoldIntercepting) {
        return this.#originalPause();
      }
    };

    const options = { capture: true, passive: true, signal };
    zone.addEventListener("pointerdown", (event) => this.#handlePointerDown(event), options);
    zone.addEventListener("pointermove", (event) => this.#handlePointerMove(event), options);
    zone.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
    zone.addEventListener("pointercancel", (event) => this.#handlePointerUp(event), options);
    zone.addEventListener("click", (event) => this.#handleClickCapture(event), { capture: true, signal });
    zone.addEventListener("dblclick", (event) => this.#handleDblClickCapture(event), { capture: true, signal });
    window.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
    window.addEventListener("pointercancel", (event) => this.#handlePointerUp(event), options);
    document.addEventListener("keydown", (event) => this.#handleKeydown(event), { capture: true, signal });
    document.addEventListener("keyup", (event) => this.#handleKeyup(event), { capture: true, signal });
    // A window blur can swallow the matching Space keyup; finish the hold
    // through the normal release path so playback rate never stays boosted.
    window.addEventListener("blur", () => this.#finishKeyboardHold(false), { signal });

    document.addEventListener("fullscreenchange", () => {
      this.setTrackpadPinchEnabled(this.#isFullscreen());
    }, { signal });

    activeForges.add(this);
  }

  /** Engine lifetime signal - action wiring shares it and dies with it. */
  get signal() {
    return this.#scope.signal;
  }

  #isFullscreen() {
    return !!document.fullscreenElement;
  }

  /**
   * Subscribe/unsubscribe the trackpad pinch wheel listener. It is the only
   * non-passive listener here besides the activation suppressors, so it lives
   * only while its feature can fire (fullscreen). Driven natively by
   * fullscreenchange; exposed for explicit scoping in tests.
   */
  setTrackpadPinchEnabled(enabled) {
    if (this.#destroyed || enabled === this.#trackpadPinchSubscribed) {
      return;
    }
    if (enabled) {
      this.#trackpadPinchSubscribed = true;
      this.#wheelHandler = (event) => this.#handleWheelCapture(event);
      this.#zone.addEventListener("wheel", this.#wheelHandler, WHEEL_CAPTURE);
    } else {
      this.#detachTrackpadPinch();
    }
  }

  #detachTrackpadPinch() {
    if (!this.#trackpadPinchSubscribed) {
      return;
    }
    this.#trackpadPinchSubscribed = false;
    if (this.#wheelHandler) {
      // Managed manually: live scoping needs add/remove symmetry outside the
      // shared AbortSignal.
      this.#zone.removeEventListener("wheel", this.#wheelHandler, true);
      this.#wheelHandler = null;
    }
  }

  /** Snap any inline transform back with a short transition. */
  #restoreTransform() {
    easeTransformTo(this.#video, this.#swipeBaseTransform || "");
  }

  destroy() {
    if (!this.#destroyed) {
      this.#detachTrackpadPinch();
      this.#endPointerSession();
      this.#destroyed = true;
      clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
      clearTimeout(this.#keyboardHoldTimer);
      this.#keyboardHoldTimer = null;
      clearTimeout(this.#pinchInitTimer);
      this.#pinchInitTimer = null;
      clearTimeout(this.#clickSuppressTimer);
      this.#clickSuppressTimer = null;
      this.#pointers.clear();
      this.#spaceHoldIntercepting = false;
      this.#video.style.transition = "";
      this.#video.style.transform = "";
      this.#zone.style.touchAction = this.#savedTouchAction;
      this.#video.play = this.#originalPlay;
      this.#video.pause = this.#originalPause;

      activeForges.delete(this);
      if (lastActiveForge === this) {
        lastActiveForge = null;
      }
      this.#resetKeyboardHold();
      this.#scope.abort();
    }
  }

  /** Suppress the click/dblclick that follows an interactive gesture. */
  #suppressNextActivations() {
    this.#suppressClickPending = true;
    this.#suppressDblclickPending = true;
    clearTimeout(this.#clickSuppressTimer);
    this.#clickSuppressTimer = setTimeout(() => {
      this.#clickSuppressTimer = null;
      this.#suppressClickPending = false;
      this.#suppressDblclickPending = false;
    }, SUPPRESS_WINDOW_MS);
  }

  #resetKeyboardHold() {
    this.#spaceHoldIntercepting = false;
    this.#keyboardHolding = false;
    clearTimeout(this.#keyboardHoldTimer);
    this.#keyboardHoldTimer = null;
  }

  #hitTestVideo(pointerEvent) {
    const rect = this.#video.getBoundingClientRect();
    return pointerEvent.clientX >= rect.left && pointerEvent.clientX <= rect.right &&
      pointerEvent.clientY >= rect.top && pointerEvent.clientY <= rect.bottom;
  }

  #zoneForPoint(pointerEvent) {
    // Edge zones only steer fullscreen gestures (dbltap edge-skip, swipe-down
    // exit - both fs-gated), so the reference is the physical display. screen
    // also sidesteps innerWidth's scrollbar-inclusive quirk on Gecko. Guard to
    // the window when the screen reports no size (headless/test environs).
    const screenWidth =
      typeof screen !== "undefined" && screen.width > 0
        ? screen.width
        : window.innerWidth;
    if (pointerEvent.clientX < screenWidth * EDGE_ZONE_RATIO) {
      return "left-edge";
    } else if (pointerEvent.clientX > screenWidth * EDGE_ZONE_START) {
      return "right-edge";
    } else {
      return "screen";
    }
  }

  /** End the current pointer interaction: fire release/scrub-end/swipe-cancel. */
  #endPointerSession() {
    this.#clearHoldTimer();
    if (this.#holding) {
      this.#holding = false;
      this.#dispatch(GESTURE_EVENTS.release, {
        zone: this.#gestureZone,
        method: "pointer",
        duration: performance.now() - this.#startTime
      });
    }
    if (this.#scrubbing) {
      this.#scrubbing = false;
      this.#dispatch(GESTURE_EVENTS.scrubEnd, {
        zone: this.#gestureZone || "screen",
        method: "pointer"
      });
    }
    if (this.#swiping) {
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#restoreTransform();
    }
    this.#suppressNextActivations();
  }

  #clearHoldTimer() {
    clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
  }

  #beginPinchTracking() {
    this.#endPointerSession();
    this.#primaryPointerId = null;
    for (const pointerId of this.#pointers.keys()) {
      this.#releasePointerCaptureSafe(pointerId);
    }
    this.#pinchStartDistance = 0;
    this.#pinchFired = false;
    this.#pinchZone = this.#gestureZone || "screen";
    clearTimeout(this.#pinchInitTimer);
    this.#pinchInitTimer = setTimeout(() => {
      this.#pinchInitTimer = null;
      if (this.#destroyed || this.#pointers.size < 2) {
        return;
      }
      captureFirstTwo(this.#pointers, firstTwoPointers);
      this.#pinchStartDistance =
        Math.hypot(firstTwoPointers.x1 - firstTwoPointers.x0, firstTwoPointers.y1 - firstTwoPointers.y0);
    }, PINCH_BASELINE_DELAY_MS);
  }

  #checkPinch() {
    if (!this.#isFullscreen() || this.#pinchFired || this.#pinchStartDistance < PINCH_MIN_DISTANCE_PX) {
      return;
    }
    if (!captureFirstTwo(this.#pointers, firstTwoPointers)) {
      return;
    }
    const scaleDelta =
      (Math.hypot(firstTwoPointers.x1 - firstTwoPointers.x0, firstTwoPointers.y1 - firstTwoPointers.y0) -
        this.#pinchStartDistance) /
      this.#pinchStartDistance;
    if (scaleDelta > PINCH_SCALE_THRESHOLD || scaleDelta < -PINCH_SCALE_THRESHOLD) {
      this.#pinchFired = true;
      this.#suppressNextActivations();
      this.#dispatch(GESTURE_EVENTS.pinch, {
        zone: this.#pinchZone,
        method: "pointer",
        direction: scaleDelta > 0 ? "out" : "in"
      });
    }
  }

    /**
     * Decide whether keyboard shortcuts should apply: yes when focus sits
     * on a target that cannot consume the keystroke itself - inside the
     * container, or at page level (SPA roots park focus on app wrappers,
     * not body) while this engine owns playback.
     */
  #shouldHandleKeys(allowControlFocus = false) {
    const activeElement = deepestActiveElement(this.#eventTarget);
    if (!this.#zone) {
      return false;
    }
    if (!this.#keysAllowedForTarget(activeElement, allowControlFocus)) {
      return false;
    }
    if (isInsideShell(this.#eventTarget, activeElement)) {
      return true;
    }
    if (!this.#isActive(this)) {
      return false;
    }
    let candidates = 0;
    let includesThis = false;
    for (const forge of activeForges) {
      if (this.#isActive(forge)) {
        candidates++;
        includesThis ||= forge === this;
      }
    }
    if (candidates === 1) {
      return includesThis;
    } else if (candidates > 1) {
      return lastActiveForge === this;
    }
    return false;
  }

  /**
   * Whether a focused element must keep its keystrokes (playback keys yield).
   * Text entry, links, selects/options and inputs always win. Buttons only
   * win when they belong to PlayerForge's own chrome - clicking a NATIVE
   * player control must never silence hotkeys (desktop-player parity), while
   * pf stepper/select controls genuinely consume arrows.
   */
  #keysAllowedForTarget(el, allowControlFocus) {
    if (!el || el === document.body || el === document.documentElement) {
      return true;
    }
    if (this.#isTextEntryTarget(el) || el.closest?.("a[href]")) {
      return false;
    }
    const tag = el.tagName;
    if (tag === "SELECT" || tag === "OPTION" || tag === "INPUT") {
      return !!allowControlFocus;
    }
    if (tag === "BUTTON") {
      return !!allowControlFocus || !isInsideShell(this.#eventTarget, el);
    }
    return true;
  }

  #isTextEntryTarget(el) {
    if (!el) {
      return false;
    }
    if (el.isContentEditable || el.tagName === "TEXTAREA") {
      return true;
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type !== "checkbox" && type !== "radio" &&
        type !== "button" && type !== "submit" && type !== "reset" && type !== "color";
    }
    return false;
  }

  /** An engine can own playback when its video is loaded and not finished. */
  #isActive(forge) {
    return !forge.#destroyed && forge.#video.readyState > 0 && !forge.#video.ended;
  }

  #dispatch(eventName, detail) {
    if (!this.#destroyed && !!this.#eventTarget) {
      this.#eventTarget.dispatchEvent(new CustomEvent(eventName, {
        detail,
        bubbles: false,
        composed: false
      }));
    }
  }

  #capturePointerSafe(pointerId) {
    if (pointerId != null) {
      try {
        this.#zone.setPointerCapture(pointerId);
      } catch {}
    }
  }

  #releasePointerCaptureSafe(pointerId) {
    if (pointerId != null) {
      try {
        this.#zone.releasePointerCapture(pointerId);
      } catch {}
    }
  }

  #handlePointerDown(event) {
    if (
      event.button !== 0 ||
      this.#eventTarget && event.composedPath().includes(this.#eventTarget) ||
      this.#pointers.size === 0 && !this.#hitTestVideo(event)
    ) {
      return;
    }
    lastActiveForge = this;
    const existing = this.#pointers.get(event.pointerId);
    if (existing) {
      existing.x = event.clientX;
      existing.y = event.clientY;
    } else {
      this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (this.#pointers.size === 2) {
      if (allowsIntent("pinch")) {
        this.#beginPinchTracking();
      }
      return;
    }
    if (!(this.#pointers.size > 2)) {
      this.#primaryPointerId = event.pointerId;
      this.#startX = event.clientX;
      this.#startY = event.clientY;
      this.#startTime = performance.now();
      this.#holding = false;
      this.#suppressClickPending = false;
      clearTimeout(this.#clickSuppressTimer);
      this.#clickSuppressTimer = null;
      this.#gestureZone = this.#zoneForPoint(event);
      this.#scrubbing = false;
      this.#scrubLastX = event.clientX;
      this.#scrubLastTime = this.#startTime;
      this.#scrubVelocity = 0;
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#clearHoldTimer();

      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = null;
        if (this.#primaryPointerId !== null && !this.#video.paused && allowsIntent("hold")) {
          this.#holding = true;
          this.#capturePointerSafe(this.#primaryPointerId);
          this.#dispatch(GESTURE_EVENTS.hold, {
            zone: this.#gestureZone,
            method: "pointer",
            duration: performance.now() - this.#startTime
          });
        }
      }, HOLD_TIMEOUT_MS);
    }
  }

  #handlePointerMove(event) {
    const x = event.clientX;
    const y = event.clientY;
    const pointer = this.#pointers.get(event.pointerId);
    if (pointer) {
      pointer.x = x;
      pointer.y = y;
    }
    if (this.#pointers.size === 2 && this.#pinchStartDistance > 0) {
      this.#checkPinch();
      return;
    }
    if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
      return;
    }

    const now = performance.now();
    const dx = Math.abs(x - this.#startX);
    const dy = Math.abs(y - this.#startY);

    if (dx > HOLD_CANCEL_MOVE_PX || dy > HOLD_CANCEL_MOVE_PX) {
      this.#clearHoldTimer();
    }

    if (this.#isFullscreen() && !this.#holding) {
      if (!this.#scrubbing && !this.#swiping) {
        // Intent gates are sampled live: toggling a setting mid-session
        // applies to the very next move.
        if (allowsIntent("scrub") && dx > SCROLL_START_PX && dx > dy * AXIS_DOMINANCE_RATIO) {
          this.#scrubbing = true;
          this.#capturePointerSafe(this.#primaryPointerId);
          this.#scrubLastX = x;
          this.#scrubLastTime = now;
          this.#scrubVelocity = 0;
        } else if (allowsIntent("swipe") && dy > SCROLL_START_PX && dy > dx * AXIS_DOMINANCE_RATIO) {
          this.#swiping = true;
          this.#swipeDirection = y > this.#startY ? "down" : "up";
          this.#swipeBaseTransform = this.#video.style.transform || "";
          this.#capturePointerSafe(this.#primaryPointerId);
          this.#suppressNextActivations();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.swipeStart, {
            zone: this.#gestureZone || "screen",
            method: "pointer",
            direction: this.#swipeDirection
          });
        }
      }
      if (this.#scrubbing) {
        event.stopImmediatePropagation();
        this.#advanceScrub(event);
      }
      if (this.#swiping && this.#swipeDirection === "down") {
        event.stopImmediatePropagation();
        const drag = y - this.#startY;
        this.#video.style.transform = `${this.#swipeBaseTransform} translateY(${drag}px)`;
      }
    }
  }

  /**
   * Consume every coalesced sample of the move so high-rate Gecko pointer
   * streams scrub at full fidelity; one semantic event is emitted per move.
   *
   * Real-time velocity is measured at move granularity from true event
   * timestamps (the live event's own DOMHighResTimeStamp, same epoch as
   * performance.now()) and smoothed with a first-order time-based filter,
   * alpha = 1 - exp(-dt/tau). Because alpha derives from the real interval
   * between moves, the smoothing window is the same absolute time at any
   * display rate - adaptive-refresh correct - while the small tau keeps the
   * signal responsive enough to track speed changes mid-stroke, so the seek
   * amount stays proportional to the hand in real time.
   */
  #advanceScrub(event) {
    let totalStep = 0;
    const hasCoalesced = typeof event.getCoalescedEvents === "function";
    const samples = hasCoalesced ? event.getCoalescedEvents() : null;
    // Coalesced samples then the live event, without materializing a combined
    // array: high-rate Gecko pointer streams land here every move, so a
    // [[...samples, event]] spread per frame would allocate needlessly.
    if (samples) {
      const count = samples.length + 1;
      let lastX = this.#scrubLastX;
      for (let i = 0; i < count; i++) {
        const sample = i < samples.length ? samples[i] : event;
        totalStep += sample.clientX - lastX;
        lastX = sample.clientX;
      }
      this.#scrubLastX = lastX;
    } else {
      totalStep = event.clientX - this.#scrubLastX;
      this.#scrubLastX = event.clientX;
    }

    const now = event.timeStamp;
    const dt = (now - this.#scrubLastTime) / 1000;
    this.#scrubLastTime = now;
    const instantVelocity = dt > 0.001 ? totalStep / dt : 0;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / SCRUB_VELOCITY_TAU_S) : 0;
    this.#scrubVelocity += alpha * (instantVelocity - this.#scrubVelocity);
    this.#dispatch(GESTURE_EVENTS.scrub, {
      zone: this.#gestureZone || "screen",
      method: "pointer",
      dx: totalStep,
      velocity: this.#scrubVelocity,
      timestamp: now
    });
  }

  #handlePointerUp(event) {
    this.#pointers.delete(event.pointerId);
    if (this.#pinchStartDistance > 0 && this.#pointers.size < 2) {
      this.#pinchStartDistance = 0;
      this.#pinchFired = false;
      this.#pinchZone = null;
    }
    if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
      return;
    }
    this.#clearHoldTimer();
    const elapsed = performance.now() - this.#startTime;
    const dx = event.clientX - this.#startX;
    const dy = event.clientY - this.#startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (this.#holding) {
      this.#holding = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#dispatch(GESTURE_EVENTS.release, {
        zone: this.#gestureZone,
        method: "pointer",
        duration: elapsed
      });
    } else if (this.#scrubbing) {
      this.#scrubbing = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#dispatch(GESTURE_EVENTS.scrubEnd, {
        zone: this.#gestureZone || "screen",
        method: "pointer"
      });
    } else if (this.#swiping) {
      this.#swiping = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#restoreTransform();
      this.#dispatch(GESTURE_EVENTS.swipe, {
        zone: this.#gestureZone || "screen",
        method: "pointer",
        direction: this.#swipeDirection,
        distance
      });
      this.#swipeDirection = null;
    } else if (
      elapsed < HOLD_TIMEOUT_MS &&
      this.#gestureZone !== null &&
      allowsIntent("dbltap")
    ) {
      const now = performance.now();
      if (now - this.#lastTapTime < DOUBLE_TAP_WINDOW_MS) {
        this.#lastTapTime = -Infinity;
        this.#suppressNextActivations();
        this.#dispatch(GESTURE_EVENTS.dbltap, { zone: this.#gestureZone, method: "pointer" });
      } else {
        this.#lastTapTime = now;
      }
    }
    this.#primaryPointerId = null;
    this.#gestureZone = null;
  }

  #handleClickCapture(event) {
    if (this.#suppressClickPending) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.#suppressClickPending = false;
      clearTimeout(this.#clickSuppressTimer);
      this.#clickSuppressTimer = null;
      this.#suppressDblclickPending = false;
    }
  }

  #handleDblClickCapture(event) {
    if (this.#suppressDblclickPending) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.#suppressDblclickPending = false;
      clearTimeout(this.#clickSuppressTimer);
      this.#clickSuppressTimer = null;
      this.#suppressClickPending = false;
    }
  }

  #handleWheelCapture(event) {
    if (this.#isFullscreen() && event.ctrlKey && !event.momentum && allowsIntent("pinch")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!this.#trackpadPinchCooldown) {
        this.#trackpadPinchCooldown = true;
        setTimeout(() => {
          this.#trackpadPinchCooldown = false;
        }, TRACKPAD_COOLDOWN_MS);
        this.#suppressNextActivations();
        this.#dispatch(GESTURE_EVENTS.pinch, {
          zone: "screen",
          method: "trackpad",
          direction: event.deltaY < 0 ? "out" : "in"
        });
      }
    }
  }

  /**
   * Space is absent from the binding table on purpose: it carries hold-to-
   * speed semantics and intentionally ignores the hotkeys toggle. While a
   * Space hold is in progress the video's play/pause are intercepted so the
   * browser's own Space-activates-video default cannot fight the hold.
   */
  #handleKeydown(event) {
    if (event.repeat) {
      return;
    }
    if (event.code === "Space") {
      if (this.#shouldHandleKeys(false)) {
        lastActiveForge = this;
        event.preventDefault();
        this.#spaceHoldIntercepting = true;
        this.#keyboardHoldStart = performance.now();
        this.#keyboardHolding = false;
        clearTimeout(this.#keyboardHoldTimer);
        this.#keyboardHoldTimer = setTimeout(() => {
          this.#keyboardHoldTimer = null;
          if (!this.#video.paused && allowsIntent("hold")) {
            this.#keyboardHolding = true;
            this.#dispatch(GESTURE_EVENTS.hold, {
              zone: "screen",
              method: "keyboard",
              duration: performance.now() - this.#keyboardHoldStart
            });
          }
        }, HOLD_TIMEOUT_MS);
      }
      return;
    }
    for (const binding of KEY_BINDINGS) {
      if (binding.code !== event.code) {
        continue;
      }
      if (!isKeyArmed(binding)) {
        continue;
      }
      if (!this.#shouldHandleKeys(!!binding.allowControlFocus)) {
        continue;
      }
      lastActiveForge = this;
      event.preventDefault();
      event.stopImmediatePropagation();
      const detail = { method: "keyboard" };
      if (binding.direction) {
        detail.direction = binding.direction;
      }
      this.#dispatch(binding.emit, detail);
      return;
    }
  }

  #handleKeyup(event) {
    if (event.code !== "Space") {
      return;
    }
    this.#finishKeyboardHold(true);
  }

  /**
   * End a Space session: an active hold always releases (restoring playback
   * rate via the action layer), a bare tap toggles play/pause - but only on
   * a real keyup. Blur finishes silently-with-release and never toggles.
   */
  #finishKeyboardHold(allowToggle) {
    const wasHolding = this.#keyboardHolding;
    const shouldToggle = allowToggle && !wasHolding && this.#shouldHandleKeys();
    clearTimeout(this.#keyboardHoldTimer);
    this.#keyboardHoldTimer = null;
    this.#keyboardHolding = false;
    this.#spaceHoldIntercepting = false;
    if (wasHolding) {
      this.#dispatch(GESTURE_EVENTS.release, {
        zone: "screen",
        method: "keyboard",
        duration: performance.now() - this.#keyboardHoldStart
      });
    } else if (shouldToggle) {
      if (this.#video.paused) {
        this.#originalPlay().catch(() => {});
      } else {
        this.#originalPause();
      }
    }
  }
}
