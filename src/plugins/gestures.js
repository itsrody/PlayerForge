import { getSetting } from "../shared/config.js";
import { GESTURE_EVENTS } from "../shared/events.js";

// Tuning constants (ms / px / ratios).
const HOLD_TIMEOUT_MS = 300;
const DOUBLE_TAP_WINDOW_MS = 300;
const EDGE_ZONE_RATIO = 0.15;
const SCROLL_START_PX = 15;
const AXIS_DOMINANCE_RATIO = 2;
const PINCH_MIN_DISTANCE_PX = 50;
const PINCH_SCALE_THRESHOLD = 0.2;
const SUPPRESS_WINDOW_MS = 600;

/** All live gesture controllers, used for focus arbitration between players. */
const activeControllers = new Set();
let lastActiveController = null;

/**
 * Pointer/keyboard/wheel gesture recognizer attached to a player container.
 * Emits pf:gesture-* CustomEvents on the shell host; intercepts the video
 * element's play/pause while a keyboard Space hold is in progress.
 */
export class GestureController {
  #video;
  #zone;
  #eventTarget;
  #isFullscreenFn;

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
  #lastTapTime = 0;
  #gestureZone = null;

  // Click/dblclick suppression after gestures.
  #suppressClickPending = false;
  #suppressDblclickPending = false;
  #clickSuppressTimer = null;

  // Intent flags sampled at pointerdown.
  #wantScrub = false;
  #wantSwipe = false;

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

  // Bound handlers.
  #onPointerDown;
  #onPointerMove;
  #onPointerUp;
  #onClickCapture;
  #onDblClickCapture;
  #onWheelCapture;
  #onKeydown;
  #onKeyup;
  #onBlur;

  constructor(video, zone, eventTarget, isFullscreenFn = null) {
    this.#video = video;
    this.#zone = zone;
    this.#eventTarget = eventTarget;
    this.#isFullscreenFn = isFullscreenFn;
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

    this.#onPointerDown = this.#handlePointerDown.bind(this);
    this.#onPointerMove = this.#handlePointerMove.bind(this);
    this.#onPointerUp = this.#handlePointerUp.bind(this);
    this.#onClickCapture = this.#handleClickCapture.bind(this);
    this.#onDblClickCapture = this.#handleDblClickCapture.bind(this);
    this.#onWheelCapture = this.#handleWheelCapture.bind(this);
    this.#onKeydown = this.#handleKeydown.bind(this);
    this.#onKeyup = this.#handleKeyup.bind(this);
    this.#onBlur = this.#resetKeyboardHold.bind(this);

    zone.addEventListener("pointerdown", this.#onPointerDown, true);
    zone.addEventListener("pointermove", this.#onPointerMove, true);
    zone.addEventListener("pointerup", this.#onPointerUp, true);
    zone.addEventListener("pointercancel", this.#onPointerUp, true);
    zone.addEventListener("click", this.#onClickCapture, true);
    zone.addEventListener("dblclick", this.#onDblClickCapture, true);
    window.addEventListener("pointerup", this.#onPointerUp, true);
    window.addEventListener("pointercancel", this.#onPointerUp, true);
    zone.addEventListener("wheel", this.#onWheelCapture, { capture: true, passive: false });
    document.addEventListener("keydown", this.#onKeydown, true);
    document.addEventListener("keyup", this.#onKeyup, true);
    window.addEventListener("blur", this.#onBlur);

    activeControllers.add(this);
  }

  /** Snap any inline transform back with a short transition. */
  #restoreTransform() {
    const video = this.#video;
    video.style.transition = "transform 0.15s cubic-bezier(0.2, 0, 0, 1)";
    video.style.transform = this.#swipeBaseTransform || "";
    setTimeout(() => {
      video.style.transition = "";
    }, 200);
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#clearHoldTimer();
      this.#clearKeyboardHoldTimer();
      this.#clearPinchTimer();
      this.#clearClickSuppressTimer();
      this.#pointers.clear();
      this.#spaceHoldIntercepting = false;
      this.#video.style.transition = "";
      this.#video.style.transform = "";
      this.#zone.style.touchAction = this.#savedTouchAction;
      this.#video.play = this.#originalPlay;
      this.#video.pause = this.#originalPause;

      this.#zone.removeEventListener("pointerdown", this.#onPointerDown, true);
      this.#zone.removeEventListener("pointermove", this.#onPointerMove, true);
      this.#zone.removeEventListener("pointerup", this.#onPointerUp, true);
      this.#zone.removeEventListener("pointercancel", this.#onPointerUp, true);
      this.#zone.removeEventListener("click", this.#onClickCapture, true);
      this.#zone.removeEventListener("dblclick", this.#onDblClickCapture, true);
      this.#zone.removeEventListener("wheel", this.#onWheelCapture, true);
      window.removeEventListener("pointerup", this.#onPointerUp, true);
      window.removeEventListener("pointercancel", this.#onPointerUp, true);
      document.removeEventListener("keydown", this.#onKeydown, true);
      document.removeEventListener("keyup", this.#onKeyup, true);
      window.removeEventListener("blur", this.#onBlur);

      activeControllers.delete(this);
      if (lastActiveController === this) {
        lastActiveController = null;
      }
      this.#resetKeyboardHold();
    }
  }

  #clearHoldTimer() {
    if (this.#holdTimer) {
      clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
    }
  }

  #clearKeyboardHoldTimer() {
    if (this.#keyboardHoldTimer) {
      clearTimeout(this.#keyboardHoldTimer);
      this.#keyboardHoldTimer = null;
    }
  }

  #clearPinchTimer() {
    if (this.#pinchInitTimer) {
      clearTimeout(this.#pinchInitTimer);
      this.#pinchInitTimer = null;
    }
  }

  #clearClickSuppressTimer() {
    if (this.#clickSuppressTimer) {
      clearTimeout(this.#clickSuppressTimer);
      this.#clickSuppressTimer = null;
    }
  }

  /** Suppress the click/dblclick that follows an interactive gesture. */
  #suppressNextActivations() {
    this.#suppressClickPending = true;
    this.#suppressDblclickPending = true;
    this.#clearClickSuppressTimer();
    this.#clickSuppressTimer = setTimeout(() => {
      this.#clickSuppressTimer = null;
      this.#suppressClickPending = false;
      this.#suppressDblclickPending = false;
    }, SUPPRESS_WINDOW_MS);
  }

  #resetKeyboardHold() {
    this.#spaceHoldIntercepting = false;
    this.#keyboardHolding = false;
    this.#clearKeyboardHoldTimer();
  }

  #hitTestVideo(pointerEvent) {
    const rect = this.#video.getBoundingClientRect();
    return pointerEvent.clientX >= rect.left && pointerEvent.clientX <= rect.right &&
      pointerEvent.clientY >= rect.top && pointerEvent.clientY <= rect.bottom;
  }

  #zoneForPoint(pointerEvent) {
    const viewportWidth = window.innerWidth;
    if (pointerEvent.clientX < viewportWidth * EDGE_ZONE_RATIO) {
      return "left-edge";
    } else if (pointerEvent.clientX > viewportWidth * (1 - EDGE_ZONE_RATIO)) {
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
      this.#scrubVelocity = 0;
      this.#dispatch(GESTURE_EVENTS.scrubEnd, {
        zone: "screen",
        method: "pointer",
        velocity: 0
      });
    }
    if (this.#swiping) {
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#restoreTransform();
    }
    this.#suppressNextActivations();
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
    this.#clearPinchTimer();
    this.#pinchInitTimer = setTimeout(() => {
      this.#pinchInitTimer = null;
      if (this.#destroyed || this.#pointers.size < 2) {
        return;
      }
      const points = [...this.#pointers.values()];
      this.#pinchStartDistance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    }, 2);
  }

  #checkPinch() {
    if (!this.#isFullscreen() || this.#pinchFired || this.#pinchStartDistance < PINCH_MIN_DISTANCE_PX) {
      return;
    }
    const points = [...this.#pointers.values()];
    if (points.length < 2) {
      return;
    }
    const scaleDelta =
      (Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) - this.#pinchStartDistance) /
      this.#pinchStartDistance;
    if (scaleDelta > PINCH_SCALE_THRESHOLD) {
      this.#pinchFired = true;
      this.#suppressNextActivations();
      this.#dispatch(GESTURE_EVENTS.pinch, { zone: this.#pinchZone, method: "pointer", direction: "out" });
    } else if (scaleDelta < -PINCH_SCALE_THRESHOLD) {
      this.#pinchFired = true;
      this.#suppressNextActivations();
      this.#dispatch(GESTURE_EVENTS.pinch, { zone: this.#pinchZone, method: "pointer", direction: "in" });
    }
  }

  /**
   * Decide whether keyboard shortcuts should apply: yes when focus is inside
   * the container on non-interactive elements (unless `allowSettings` is set),
   * or when focus is page-level and this controller owns playback.
   */
  #shouldHandleKeys(allowSettings = false) {
    const activeElement = document.activeElement;
    if (!this.#zone) {
      return false;
    }
    if (this.#zone.contains(activeElement)) {
      if (this.#isTextEntryTarget(activeElement) || activeElement.closest("a[href]")) {
        return false;
      }
      const tag = activeElement.tagName;
      return !!allowSettings || tag !== "BUTTON" && tag !== "SELECT" && tag !== "OPTION" && tag !== "INPUT";
    }
    if (activeElement === document.body || activeElement === document.documentElement || activeElement === null) {
      if (this.#video.readyState <= 0 || this.#video.ended) {
        return false;
      }
      let candidates = 0;
      let includesThis = false;
      for (const controller of activeControllers) {
        if (!controller.#destroyed && !(controller.#video.readyState <= 0) && !controller.#video.ended) {
          candidates++;
          if (controller === this) {
            includesThis = true;
          }
        }
      }
      if (candidates === 1) {
        return includesThis;
      } else if (candidates > 1) {
        return lastActiveController === this;
      } else {
        return false;
      }
    }
    return false;
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
      return type !== "checkbox" && type !== "radio" && type !== "range" &&
        type !== "button" && type !== "submit" && type !== "reset" && type !== "color";
    }
    return false;
  }

  #isFullscreen() {
    if (this.#isFullscreenFn) {
      return !!this.#isFullscreenFn();
    } else {
      return false;
    }
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
      this.#eventTarget && this.#eventTarget.contains(event.target) ||
      this.#pointers.size === 0 && !this.#hitTestVideo(event)
    ) {
      return;
    }
    lastActiveController = this;
    const existing = this.#pointers.get(event.pointerId);
    if (existing) {
      existing.x = event.clientX;
      existing.y = event.clientY;
    } else {
      this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (this.#pointers.size === 2) {
      if (getSetting("gestures.pinch")) {
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
      this.#clearClickSuppressTimer();
      this.#gestureZone = this.#zoneForPoint(event);
      this.#wantScrub = getSetting("gestures.scrub");
      this.#wantSwipe = getSetting("gestures.swipe");
      this.#scrubbing = false;
      this.#scrubLastX = event.clientX;
      this.#scrubLastTime = this.#startTime;
      this.#scrubVelocity = 0;
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#clearHoldTimer();

      this.#holdTimer = setTimeout(() => {
        if (this.#primaryPointerId !== null && !this.#video.paused) {
          if (getSetting("gestures.hold")) {
            this.#holding = true;
            this.#capturePointerSafe(this.#primaryPointerId);
            this.#dispatch(GESTURE_EVENTS.hold, {
              zone: this.#gestureZone,
              method: "pointer",
              duration: performance.now() - this.#startTime
            });
          }
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

    if (dx > 10 || dy > 10) {
      this.#clearHoldTimer();
    }

    if (this.#gestureZone === "screen" && this.#isFullscreen() && !this.#holding) {
      if (!this.#scrubbing && !this.#swiping) {
        if (this.#wantScrub && dx > SCROLL_START_PX && dx > dy * AXIS_DOMINANCE_RATIO) {
          this.#scrubbing = true;
          this.#capturePointerSafe(this.#primaryPointerId);
          this.#scrubLastX = x;
          this.#scrubLastTime = now;
          this.#scrubVelocity = 0;
        } else if (this.#wantSwipe && dy > SCROLL_START_PX && dy > dx * AXIS_DOMINANCE_RATIO) {
          this.#swiping = true;
          this.#swipeDirection = y > this.#startY ? "down" : "up";
          this.#swipeBaseTransform = this.#video.style.transform || "";
          this.#capturePointerSafe(this.#primaryPointerId);
          this.#suppressNextActivations();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.swipeStart, {
            zone: "screen",
            method: "pointer",
            direction: this.#swipeDirection
          });
        }
      }
      if (this.#scrubbing) {
        event.stopImmediatePropagation();
        const dt = (now - this.#scrubLastTime) / 1000;
        const step = x - this.#scrubLastX;
        const instantVelocity = dt > 0.001 ? step / dt : 0;
        this.#scrubVelocity = this.#scrubVelocity * 0.7 + instantVelocity * 0.3;
        this.#scrubLastX = x;
        this.#scrubLastTime = now;
        this.#dispatch(GESTURE_EVENTS.scrub, {
          zone: "screen",
          method: "pointer",
          dx: step,
          velocity: this.#scrubVelocity
        });
      }
      if (this.#swiping && this.#swipeDirection === "down") {
        event.stopImmediatePropagation();
        const drag = y - this.#startY;
        this.#video.style.transform = `${this.#swipeBaseTransform} translateY(${drag}px)`;
      }
    }
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
      const finalVelocity = this.#scrubVelocity;
      this.#scrubVelocity = 0;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#dispatch(GESTURE_EVENTS.scrubEnd, {
        zone: "screen",
        method: "pointer",
        velocity: finalVelocity
      });
    } else if (this.#swiping) {
      this.#swiping = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#restoreTransform();
      this.#dispatch(GESTURE_EVENTS.swipe, {
        zone: "screen",
        method: "pointer",
        direction: this.#swipeDirection,
        distance
      });
      this.#swipeDirection = null;
    } else if (elapsed < HOLD_TIMEOUT_MS && this.#gestureZone !== null && getSetting("gestures.dbltap")) {
      const now = performance.now();
      if (now - this.#lastTapTime < DOUBLE_TAP_WINDOW_MS) {
        this.#lastTapTime = 0;
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
      this.#clearClickSuppressTimer();
    }
  }

  #handleDblClickCapture(event) {
    if (this.#suppressDblclickPending) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.#suppressDblclickPending = false;
      this.#clearClickSuppressTimer();
    }
  }

  #handleWheelCapture(event) {
    if (
      this.#destroyed ||
      !event.ctrlKey ||
      event.momentum ||
      !this.#isFullscreen() ||
      !getSetting("gestures.pinch") ||
      (event.preventDefault(), event.stopImmediatePropagation(), this.#trackpadPinchCooldown)
    ) {
      return;
    }
    this.#trackpadPinchCooldown = true;
    setTimeout(() => {
      this.#trackpadPinchCooldown = false;
    }, 500);
    const direction = event.deltaY < 0 ? "out" : "in";
    this.#suppressNextActivations();
    this.#dispatch(GESTURE_EVENTS.pinch, {
      zone: "screen",
      method: "trackpad",
      direction
    });
  }

  #handleKeydown(event) {
    if (!event.repeat && this.#shouldHandleKeys(event.code === "KeyS")) {
      lastActiveController = this;
      switch (event.code) {
        case "ArrowRight":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.skip, { direction: "right", method: "keyboard" });
          return;
        case "ArrowLeft":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.skip, { direction: "left", method: "keyboard" });
          return;
        case "ArrowUp":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.volume, { direction: "up", method: "keyboard" });
          return;
        case "ArrowDown":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.volume, { direction: "down", method: "keyboard" });
          return;
        case "KeyM":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.mute, { method: "keyboard" });
          return;
        case "KeyS":
          if (!getSetting("gestures.hotkeys")) {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#dispatch(GESTURE_EVENTS.panel, { method: "keyboard" });
          return;
        case "Space": {
          event.preventDefault();
          this.#spaceHoldIntercepting = true;
          this.#keyboardHoldStart = performance.now();
          this.#keyboardHolding = false;
          this.#clearKeyboardHoldTimer();
          this.#keyboardHoldTimer = setTimeout(() => {
            if (!this.#video.paused) {
              if (getSetting("gestures.hold")) {
                this.#keyboardHolding = true;
                this.#dispatch(GESTURE_EVENTS.hold, {
                  zone: "screen",
                  method: "keyboard",
                  duration: performance.now() - this.#keyboardHoldStart
                });
              }
            }
          }, HOLD_TIMEOUT_MS);
          return;
        }
      }
    }
  }

  #handleKeyup(event) {
    if (event.code !== "Space") {
      return;
    }
    const wasHolding = this.#keyboardHolding;
    const shouldToggle = this.#shouldHandleKeys();
    this.#clearKeyboardHoldTimer();
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
