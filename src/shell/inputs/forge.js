import { allowsIntent, allowsAnyIntent, isKeyArmed, KEY_BINDINGS, GESTURE_EVENTS, easeTransformTo, cancelEase } from "./actions.js";
import { TUNING } from "../../shared/tuning.js";
import { deepestActiveElement, isInsideShell, fs, subscribeFullscreen } from "../../shared/shadow.js";
import { DOMManager } from "../../shared/dom-manager.js";
import { logger } from "../../shared/logger.js";
import { isBenignMediaPolicyError } from "../../shared/errors.js";
import { Scope } from "../../shared/scope.js";

/**
 * Pointer handlers never preventDefault - native pan/scroll over the zone is
 * suppressed by the touch-action CSS set at construction - so every pointer
 * listener can be passive. Only two listeners cancel defaults: the wheel
 * pinch listener (subscribed only while fullscreen) and the click/dblclick
 * suppressors that swallow post-gesture activations.
 */
const WHEEL_CAPTURE = { capture: true, passive: false };

// Gesture calibration hoisted to module consts. TUNING is static (read-only
// after load), so binding these at module scope lets V8 treat them as
// invariant values and fold them - Maglev/TurboFan raise constants to load,
// instead of re-running shape-guarded property loads on every high-frequency
// pointer/keyboard event.
const EDGE_ZONE_RATIO = TUNING.gestures.edgeZoneRatio;
const EDGE_ZONE_START = 1 - TUNING.gestures.edgeZoneRatio;
const HOLD_TIMEOUT_MS = TUNING.gestures.holdTimeoutMs;
const HOLD_CANCEL_MOVE_PX = TUNING.gestures.holdCancelMovePx;
const SCROLL_START_PX = TUNING.gestures.scrollStartPx;
const AXIS_DOMINANCE_RATIO = TUNING.gestures.axisDominanceRatio;
const PINCH_MIN_DISTANCE_PX = TUNING.gestures.pinchMinDistancePx;
const PINCH_SCALE_THRESHOLD = TUNING.gestures.pinchScaleThreshold;
const TRACKPAD_COOLDOWN_MS = TUNING.gestures.trackpadCooldownMs;
const SUPPRESS_WINDOW_MS = TUNING.gestures.suppressWindowMs;
const DOUBLE_TAP_WINDOW_MS = TUNING.gestures.doubleTapWindowMs;
const SCRUB_VELOCITY_TAU_S = TUNING.scrub.velocityFilterMs / 1000;

/** Synthetic single-tap replays this engine dispatched - lets the capture
 *  click handler recognize its own stand-in events and pass them through. */
const replayedClicks = new WeakSet();

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

/**
 * Pooled per-family event payloads mirroring scrubDetail: every #dispatch site
 * mutates one fixed-shape object in place and re-dispatches one pooled Event,
 * so the gesture boundary allocates nothing per event. Same synchronous-read
 * contract - consumers read detail.* inside dispatchEvent and never retain the
 * object, so each dispatch site must rewrite EVERY field it owns (no stale
 * carries between events).
 */
const releaseDetail = { zone: "", method: "pointer", duration: 0 };
const holdDetail = { zone: "", method: "pointer", duration: 0 };
const scrubEndDetail = { zone: "", method: "pointer" };
const pinchDetail = { zone: "", method: "pointer", direction: "" };
const swipeStartDetail = { zone: "", method: "pointer", direction: "" };
const swipeDetail = { zone: "", method: "pointer", direction: "", distance: 0 };
const dbltapDetail = { zone: "", method: "pointer" };
const keyDetail = { method: "keyboard", direction: undefined };

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
 * Pooled scrub event + detail payload. Scrub fires once per coalesced pointer
 * move (up to display rate), so allocating a fresh CustomEvent plus a fresh
 * detail object per move - the old #dispatch shape - churns the young
 * generation for the whole drag. Same philosophy as firstTwoPointers: mutate
 * one fixed-shape detail in place and re-dispatch one reused Event.
 * dispatchEvent runs listeners synchronously and every consumer (actions.js
 * reads detail.dx/velocity within the scrub handler) observes the payload
 * before the next move re-mutates it, so a re-dispatched instance is safe -
 * nothing retains the object past the caller that last read it.
 *
 * The pooled Event is built lazily (not at module load) so it is constructed
 * in the same realm as the surface it is dispatched onto: the bare
 * `globalThis.CustomEvent` is resolved at first use, which keeps it valid
 * across jsdom's realm bridging in tests and identical to the page realm in
 * the browser. One pool services the whole engine; only a single scrub can be
 * in flight at a time, so sharing is safe.
 */
const scrubDetail = { zone: "", method: "pointer", dx: 0, velocity: 0, timestamp: 0 };
let scrubPool = null;
function pooledScrubEvent() {
  const Ctor = globalThis.CustomEvent;
  if (scrubPool && scrubPool.Ctor === Ctor) {
    return scrubPool.event;
  }
  scrubPool = {
    Ctor,
    event: new Ctor(GESTURE_EVENTS.scrub, {
      detail: scrubDetail,
      bubbles: false,
      composed: false
    })
  };
  return scrubPool.event;
}

/**
 * Pooled per-name CustomEvents so the gesture boundary never allocates. Each
 * instance gets a fresh own `detail` assigned before every dispatch (own
 * properties shadow the prototype getter), and the consumers read it
 * synchronously without retaining it - same contract as the scrub pool above.
 * Lazy `globalThis.CustomEvent` resolution keeps the pool realm-safe.
 */
const dispatchPool = new Map();
function pooledDispatchEvent(name, detail) {
  const Ctor = globalThis.CustomEvent;
  const stale = dispatchPool.get(name);
  if (stale && stale.Ctor === Ctor) {
    // CustomEvent.detail is a prototype getter over an internal slot on
    // spec engines (jsdom and Chromium alike) - plain assignment throws in
    // strict mode and never updates the slot, which silently killed every
    // gesture dispatch after the first per name. Callers pass one pooled
    // detail object per name, so the usual path is the reference compare
    // below (no write at all); a genuinely fresh object re-owns the
    // property via defineProperty, whose own data property shadows the
    // prototype getter on every engine.
    if (stale.event.detail !== detail) {
      Object.defineProperty(stale.event, "detail", { value: detail, configurable: true, writable: true });
    }
    return stale.event;
  }
  const event = new Ctor(name, { detail, bubbles: false, composed: false });
  dispatchPool.set(name, { Ctor, event });
  return event;
}

/** Deadline checks run on the performance.now() timebase the suppress
 *  window is armed with. event.timeStamp is deliberately ignored: jsdom and
 *  other host realms stamp epoch-based values, which would silently never
 *  match a performance-based deadline (and in production the synchronous
 *  capture handler makes the two readings equivalent anyway). */
function clickTime() {
  return performance.now();
}

/**
 * InputForge engine: pure recognition transport. Turns pointer/keyboard/
 * wheel physics into semantic GESTURE_EVENTS on the shell host; every policy
 * decision (settings gates, fullscreen requirement) is delegated to the
 * declarative INPUT_BINDINGS list, sampled live at each decision point.
 *
 * Chromium 154+ native by design: one AbortSignal owns the entire listener
 * lifetime (destroy() === scope.abort()), all pointer listeners are passive,
 * scrub sampling consumes getCoalescedEvents(), and fullscreen truth is the
 * single shared `fs` gate (shadow.js), built on the native fullscreen event.
 */
export class InputForge {
  #video;
  #zone;
  #eventTarget;

  /** DOM lifecycle manager: listeners, observers, style rollbacks. */
  #dom = new DOMManager();
  /** Lifecycle scope: signal exposed via getter for action wiring; the
   *  disposed flag guards dispatch + destroy. */
  #scope = new Scope();

  // Cached <video> box for hit-testing, invalidated on resize/fullscreen so
  // pointerdown never forces a synchronous layout flush with getBoundingClientRect.
  #videoRect = null;

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

  // Click/dblclick suppression after gestures: a deadline (time-based, not
  // one-shot) that every activation inside the window is swallowed by - the
  // window stays armed for its full span so click AND dblclick both die.
  #suppressClickUntil = 0;

  // SDK-domination state. #pointerOwned: the current press was gesture-
  // eligible, so zone-capture stops its pointer/mouse/touch stream. #awaitClick:
  // latched at pointerup to swallow the compat mouseup before the click
  // decision; it clears on the arriving click, on cancel, or on the next
  // pointerdown - no timer needed. #tapReplay*: a first tap held back (a
  // dbltap may still form) that expires into a synthetic click for the SDK.
  #pointerOwned = false;
  #awaitClick = false;
  #tapReplayTarget = null;
  #tapReplayTimer = null;
  #tapReplayX = 0;
  #tapReplayY = 0;

  // Scrub state.
  #scrubbing = false;
  #scrubLastX = 0;
  #scrubLastTime = 0;
  #scrubVelocity = 0;

  // Swipe state.
  #swiping = false;
  #swipeDirection = null;
  #swipeBaseTransform = "";
  #lastSwipeDrag = NaN;
  #lastSwipeTransform = "";

  /**
   * Once a scrub/swipe session latches, the gesture already started fullscreen
   * (both intents are fs-gated), so this flag replaces the per-move `fs` gate
   * read and the live intent-gate scans - the session keeps running even if
   * the page loses fullscreen mid-stroke, which matches the pre-existing
   * behavior. Reset at the session's end.
   */
  #gestureFsActive = false;

  // Pinch state. #pinchStartDistance is captured from the two pointerdown
  // coords the moment the second pointer lands - no settle delay needed, and
  // #pinchZone non-null is the tracking flag.
  #pointers = new Map();
  #pinchStartDistance = 0;
  #pinchFired = false;
  #pinchZone = null;
  // Pointer ids whose capture we released on purpose (the pinch transition
  // drops capture so both fingers stream freely); a matching
  // lostpointercapture must not be mistaken for the browser stealing the
  // pointer. Cleared per fresh press so recycled ids stay honest.
  #releasedCapture = new Set();

  // Keyboard hold state.
  #keyboardHoldTimer = null;
  #keyboardHolding = false;
  #keyboardHoldStart = 0;
  /** Whether the CURRENT Space press was captured by us. The keydown decision
   *  (shouldHandleKeys) is latched here so keyup never toggles playback for a
   *  press we did not own (focus moved between down and up), and always
   *  releases a hold we did. */
  #keyboardOwn = false;
  /** Event.code values whose CURRENT press we own end-to-end: the first press
   *  took preventDefault + stopImmediatePropagation, so its auto-repeats must
   *  be shielded identically - otherwise the page's own handlers (platform
   *  Space shortcut, arrow scroll/seek) fire at repeat rate throughout a hold
   *  we are simultaneously driving. Latched per owned press, released per
   *  keyup/blur/reset; never latches a press the page owned. */
  #ownedKeyCodes = new Set();

  // Trackpad ctrl+wheel pinch cooldown: a lazy deadline avoids per-gesture timers.
  #trackpadPinchCooldownUntil = -Infinity;
  /** Whether the (non-passive) wheel pinch listener is currently attached. */
  #trackpadPinchSubscribed = false;
  /** Stable reference so the scoped wheel listener can be removed again. */
  #wheelHandler = null;

  constructor(video, zone, eventTarget) {
    this.#video = video;
    this.#zone = zone;
    this.#eventTarget = eventTarget;
    const { signal } = this.#scope;
    // Track touch-action (kills scroll/pinch takeover) and user-select (kills
    // native selection highlight + its hit-testing while scrubbing over page
    // text) for automatic rollback on destroy.
    this.#dom.markStyle(zone, "touch-action", "none");
    this.#dom.markStyle(zone, "user-select", "none");

    // NOTE: the native video element is deliberately NEVER patched (no
    // own-property rewrite of play/pause). Assigning JS functions as own
    // properties onto HTMLMediaElement mutates the instance's V8 map/expando
    // shape and would swallow play()/pause() calls from the media command
    // plane, page autoplay code, and other plugins during a Space hold. The
    // UA's own Space-activates-video default is cancelled by preventDefault on
    // the capture-phase keydown handler, so no interception shim is needed;
    // the bare-tap toggle below calls the native methods directly.

    const options = { capture: true, passive: true, signal };
    zone.addEventListener("pointerdown", (event) => this.#handlePointerDown(event), options);
    zone.addEventListener("pointermove", (event) => this.#handlePointerMove(event), options);
    zone.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
    zone.addEventListener("pointercancel", (event) => this.#handlePointerCancel(event), options);
    // Capture loss without a pointerup/cancel pair (element removed, hit-test
    // takeover) would strand an owned session; treat it as cancellation.
    zone.addEventListener("lostpointercapture", (event) => this.#handleLostCapture(event), options);
    zone.addEventListener("click", (event) => this.#handleClickCapture(event), { capture: true, signal });
    zone.addEventListener("dblclick", (event) => this.#handleDblClickCapture(event), { capture: true, signal });
    // SDK stream dominance: the compat mouse/touch streams mirror the pointer
    // stream, so while a press is owned they stop at this capture as well -
    // the SDK never observes a partial sequence. touchstart/mousedown can
    // precede (or arrive without) a tracked pointerdown, so they also probe
    // prospective eligibility directly. Plain hover input (#pointerOwned
    // false, no session) always passes through untouched.
    const swallowOwned = (event) => {
      if (this.#pointerOwned) {
        event.stopImmediatePropagation();
      }
    };
    zone.addEventListener("mousedown", (event) => {
      if ((event.button === 0 && this.#pointerOwned) || this.#dominatesPress(event)) {
        event.stopImmediatePropagation();
      }
    }, options);
    zone.addEventListener("mousemove", swallowOwned, options);
    zone.addEventListener("mouseup", (event) => {
      if (event.button === 0 && (this.#pointerOwned || this.#awaitClick)) {
        event.stopImmediatePropagation();
      }
    }, options);
    zone.addEventListener("touchstart", (event) => {
      if (this.#pointerOwned || this.#dominatesPress(event)) {
        event.stopImmediatePropagation();
      }
    }, options);
    zone.addEventListener("touchmove", swallowOwned, options);
    zone.addEventListener("touchend", (event) => {
      if (this.#pointerOwned || this.#awaitClick) {
        event.stopImmediatePropagation();
      }
    }, options);
    zone.addEventListener("touchcancel", (event) => {
      if (this.#pointerOwned || this.#awaitClick) {
        event.stopImmediatePropagation();
      }
      // A host can deliver touchcancel without its pointercancel pair; the
      // swallow alone would leave #pointerOwned/#awaitClick latched and the
      // compat stream eaten until some later pointerup. A cancelled touch
      // reclaims every tracked pointer - the sweep is idempotent when the
      // paired pointercancel already ran (and vice versa).
      for (const id of [...this.#pointers.keys()]) {
        this.#cancelTrackedPointer(id);
      }
    }, options);
    window.addEventListener("pointerup", (event) => this.#handlePointerUp(event), options);
    window.addEventListener("pointercancel", (event) => this.#handlePointerCancel(event), options);
    document.addEventListener("keydown", (event) => this.#handleKeydown(event), { capture: true, signal });
    document.addEventListener("keyup", (event) => this.#handleKeyup(event), { capture: true, signal });
    // A window blur, a hidden tab, or a Page Lifecycle freeze can each swallow
    // the matching Space keyup and/or pointerup; end every live session through
    // the normal release paths so no rate/scrub/hold stays latched.
    const interrupt = () => this.#releaseSessions();
    window.addEventListener("blur", interrupt, { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        interrupt();
      }
    }, { signal });
    document.addEventListener("freeze", interrupt, { signal });

    subscribeFullscreen(() => {
      this.setTrackpadPinchEnabled(fs);
    }, this.#scope.signal);
    // Reconcile now, not just on the next change: a shell that spawns while
    // already fullscreen must get the wheel listener from frame one.
    this.setTrackpadPinchEnabled(fs);

    activeForges.add(this);
  }

  /** Engine lifetime signal - action wiring shares it and dies with it. */
  get signal() {
    return this.#scope.signal;
  }

  /**
   * Subscribe/unsubscribe the trackpad pinch wheel listener. It is the only
   * non-passive listener here besides the activation suppressors, so it lives
   * only while its feature can fire (fullscreen). Driven natively by
   * fullscreenchange; exposed for explicit scoping in tests.
   */
  setTrackpadPinchEnabled(enabled) {
    if (this.#scope.disposed || enabled === this.#trackpadPinchSubscribed) {
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
    if (this.#scope.disposed) {
      return;
    }
    this.#detachTrackpadPinch();
    // Release dispatches (pointer hold / scrub) must reach the action layer
    // while the scope signal is still live - dispose() lands at the end,
    // exactly where #scope.abort() used to.
    this.#endPointerSession();
    clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    clearTimeout(this.#keyboardHoldTimer);
    this.#keyboardHoldTimer = null;
    this.#videoRect = null;
    this.#pointers.clear();
    this.#releasedCapture.clear();
    cancelEase(this.#video);
    // DOM lifecycle: disconnect observers, restore styles, remove elements.
    this.#dom.destroy();
    activeForges.delete(this);
    if (lastActiveForge === this) {
      lastActiveForge = null;
    }
    this.#resetKeyboardHold();
    this.#pointerOwned = false;
    this.#clearAwaitClick();
    this.#cancelTapReplay();
    this.#scope.dispose();
  }

  /** Suppress the click/dblclick that follows an interactive gesture. */
  #suppressNextActivations() {
    this.#suppressClickUntil = performance.now() + SUPPRESS_WINDOW_MS;
  }

  #resetKeyboardHold() {
    if (this.#keyboardHolding) {
      // Reset/teardown while Space is held must restore the boosted rate
      // first - the pointer path releases through #endPointerSession, and
      // the keyboard path used to drop the release here, leaving playback
      // stuck at hold speed (e.g. destroy mid-hold on an SPA navigation).
      this.#keyboardHolding = false;
      this.#dispatchKeyboardRelease();
    }
    this.#keyboardOwn = false;
    this.#ownedKeyCodes.clear();
    clearTimeout(this.#keyboardHoldTimer);
    this.#keyboardHoldTimer = null;
  }

  /** Keyboard-source release, shared by keyup, blur, reconcile and teardown. */
  #dispatchKeyboardRelease() {
    releaseDetail.zone = "screen";
    releaseDetail.method = "keyboard";
    releaseDetail.duration = performance.now() - this.#keyboardHoldStart;
    this.#dispatch(GESTURE_EVENTS.release, releaseDetail);
  }

  #hitTestVideo(pointerEvent) {
    // Cache the box within one interaction so taps outside the HUD don't
    // force a sync layout flush (getBoundingClientRect) on Chromium. The cache
    // is dropped at every pointerdown (see #handlePointerDown), so it can never
    // be served stale by a scroll or ancestor-transform move.
    if (!this.#videoRect) {
      this.#videoRect = this.#video.getBoundingClientRect();
    }
    const rect = this.#videoRect;
    return pointerEvent.clientX >= rect.left && pointerEvent.clientX <= rect.right &&
      pointerEvent.clientY >= rect.top && pointerEvent.clientY <= rect.bottom;
  }

  #zoneForPoint(pointerEvent) {
    // Edge zones only steer fullscreen gestures (dbltap edge-skip, swipe-down
    // exit - both fs-gated), so the reference is the physical display. screen
    // also sidesteps innerWidth's scrollbar-inclusive quirk on Chromium. Guard
    // to the window when the screen reports no size (headless/test environs).
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
      releaseDetail.zone = this.#gestureZone;
      releaseDetail.method = "pointer";
      releaseDetail.duration = performance.now() - this.#startTime;
      this.#dispatch(GESTURE_EVENTS.release, releaseDetail);
    }
    if (this.#scrubbing) {
      this.#scrubbing = false;
      scrubEndDetail.zone = this.#gestureZone || "screen";
      scrubEndDetail.method = "pointer";
      this.#dispatch(GESTURE_EVENTS.scrubEnd, scrubEndDetail);
    }
    if (this.#swiping) {
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#lastSwipeDrag = NaN;
      this.#lastSwipeTransform = "";
      this.#restoreTransform();
    }
    this.#gestureFsActive = false;
    this.#suppressNextActivations();
  }

  #clearHoldTimer() {
    // Almost every pointermove reaches here with no hold timer armed; the
    // null check skips clearTimeout (and its timer-table lookup) on that hot
    // path. The null assignment stays unconditional so the field is reset.
    if (this.#holdTimer !== null) {
      clearTimeout(this.#holdTimer);
    }
    this.#holdTimer = null;
  }

  #beginPinchTracking() {
    this.#endPointerSession();
    this.#primaryPointerId = null;
    for (const pointerId of this.#pointers.keys()) {
      // hasPointerCapture is absent in some embedders; without it, assume the
      // release may fire so the id is never misread as a stolen pointer.
      if (typeof this.#zone.hasPointerCapture !== "function" || this.#zone.hasPointerCapture(pointerId)) {
        this.#releasedCapture.add(pointerId);
      }
      this.#pointerOp("releasePointerCapture", pointerId);
    }
    // Capture the baseline from the pointerdown lattice itself - both
    // pointers' latest coords are already in #pointers, so no settle timer is
    // needed. #pinchZone non-null is the tracking flag.
    this.#pinchStartDistance = 0;
    this.#pinchFired = false;
    this.#pinchZone = this.#gestureZone || "screen";
    this.#capturePinchBaseline();
  }

  #capturePinchBaseline() {
    if (!captureFirstTwo(this.#pointers, firstTwoPointers)) {
      return;
    }
    // sqrt(dx*dx+dy*dy) over hypot: measured ~1.25x faster and the two
    // agree to ~2e-16 relative, far below pinch's pixel resolution.
    const dx = firstTwoPointers.x1 - firstTwoPointers.x0;
    const dy = firstTwoPointers.y1 - firstTwoPointers.y0;
    this.#pinchStartDistance = Math.sqrt(dx * dx + dy * dy);
  }

  #checkPinch() {
    if (!fs || this.#pinchFired || this.#pinchStartDistance < PINCH_MIN_DISTANCE_PX) {
      return;
    }
    if (!captureFirstTwo(this.#pointers, firstTwoPointers)) {
      return;
    }
    const dx = firstTwoPointers.x1 - firstTwoPointers.x0;
    const dy = firstTwoPointers.y1 - firstTwoPointers.y0;
    const scaleDelta = (Math.sqrt(dx * dx + dy * dy) - this.#pinchStartDistance) / this.#pinchStartDistance;
    if (scaleDelta > PINCH_SCALE_THRESHOLD || scaleDelta < -PINCH_SCALE_THRESHOLD) {
      this.#pinchFired = true;
      this.#suppressNextActivations();
      pinchDetail.zone = this.#pinchZone;
      pinchDetail.method = "pointer";
      pinchDetail.direction = scaleDelta > 0 ? "out" : "in";
      this.#dispatch(GESTURE_EVENTS.pinch, pinchDetail);
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
    if (tag === "SELECT" || tag === "OPTION") {
      // Letter keys in a focused select are native typeahead, not hotkeys -
      // even KeyS (panel toggle, allowControlFocus) yields to them.
      return false;
    }
    if (tag === "INPUT") {
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
    return !forge.#scope.disposed && forge.#video.readyState > 0 && !forge.#video.ended;
  }

  #dispatch(eventName, detail) {
    if (!this.#scope.disposed && this.#eventTarget) {
      this.#eventTarget.dispatchEvent(pooledDispatchEvent(eventName, detail));
    }
  }

  #pointerOp(op, pointerId) {
    if (pointerId != null) {
      try {
        this.#zone[op](pointerId);
      } catch {}
    }
  }

  #handlePointerDown(event) {
    // Fresh box per interaction: scroll/ancestor-transform shifts that
    // ResizeObserver and fullscreenchange never see are covered by dropping
    // the cached hit-test box at every tap (the old document-scroll capture
    // listener nulled it, but only ever mattered at this read and ran on
    // every page scroll for the whole shell lifetime).
    this.#videoRect = null;
    // Any new press invalidates a stale await latch from a drag that never
    // produced a click (no settle timer to expire it), and clears any stale
    // intentional-capture-release marker for a recycled pointer id.
    this.#clearAwaitClick();
    this.#releasedCapture.delete(event.pointerId);
    if (
      event.button !== 0 ||
      this.#eventTarget && isInsideShell(this.#eventTarget, event.target) ||
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
    if (allowsAnyIntent()) {
      // Gesture-eligible press with any pointer gesture armed: the shell owns
      // this stream. Stop it here (zone capture, ancestor of the video) so
      // SDK target/bubble listeners never see it, and drop any pending
      // single-tap replay - a new press can still turn into a dbltap or a
      // gesture, and the SDK must not be toggled mid-sequence.
      this.#pointerOwned = true;
      if (allowsIntent("dbltap")) {
        this.#cancelTapReplay();
      }
      event.stopImmediatePropagation();
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
      this.#suppressClickUntil = 0;
      this.#gestureZone = this.#zoneForPoint(event);
      this.#scrubbing = false;
      this.#scrubLastX = event.clientX;
      this.#scrubLastTime = this.#startTime;
      this.#scrubVelocity = 0;
      this.#swiping = false;
      this.#swipeDirection = null;
      this.#lastSwipeDrag = NaN;
      this.#lastSwipeTransform = "";
      this.#clearHoldTimer();

      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = null;
        if (this.#primaryPointerId !== null && !this.#video.paused && allowsIntent("hold")) {
          this.#holding = true;
          this.#pointerOp("setPointerCapture", this.#primaryPointerId);
          holdDetail.zone = this.#gestureZone;
          holdDetail.method = "pointer";
          holdDetail.duration = performance.now() - this.#startTime;
          this.#dispatch(GESTURE_EVENTS.hold, holdDetail);
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
      if (this.#pointerOwned) {
        event.stopImmediatePropagation();
      }
    }
    if (this.#pointers.size === 2 && this.#pinchZone !== null) {
      this.#checkPinch();
      return;
    }
    if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
      return;
    }

    const dx = Math.abs(x - this.#startX);
    const dy = Math.abs(y - this.#startY);

    if (dx > HOLD_CANCEL_MOVE_PX || dy > HOLD_CANCEL_MOVE_PX) {
      this.#clearHoldTimer();
    }

    // The `fs` gate and the intent gates drive the session only until it
    // latches: once a scrub/swipe starts (both are fs-gated intents that began
    // fullscreen), #gestureFsActive replaces the per-move `fs` read and the
    // allowsIntent scans for the rest of the move stream - the same decisions
    // stay fixed mid-session.
    if ((this.#gestureFsActive || fs) && !this.#holding) {
      if (!this.#scrubbing && !this.#swiping) {
        // Intent gates are sampled live: toggling a setting mid-session
        // applies to the very next move.
        if (allowsIntent("scrub") && dx > SCROLL_START_PX && dx > dy * AXIS_DOMINANCE_RATIO) {
          this.#scrubbing = true;
          this.#gestureFsActive = true;
          this.#pointerOp("setPointerCapture", this.#primaryPointerId);
          this.#scrubLastX = x;
          // event.timeStamp shares the timebase the per-move velocity filter
          // below already reads, so the whole move stream pays no clock read.
          this.#scrubLastTime = event.timeStamp;
          this.#scrubVelocity = 0;
        } else if (allowsIntent("swipe") && dy > SCROLL_START_PX && dy > dx * AXIS_DOMINANCE_RATIO) {
          this.#swiping = true;
          this.#gestureFsActive = true;
          this.#swipeDirection = y > this.#startY ? "down" : "up";
          this.#swipeBaseTransform = this.#video.style.transform || "";
          // Promote the video to a compositor layer the moment a down-drag
          // latches so the per-move translateY below tracks on the compositor
          // (pointer rate) instead of forcing a re-rasterizing style recalc
          // every move. Dropped again by easeTransformTo when the stroke's
          // snap settles (down) or the restore eases back (up/cancel).
          if (this.#swipeDirection === "down") {
            this.#video.style.willChange = "transform";
          }
          this.#pointerOp("setPointerCapture", this.#primaryPointerId);
          this.#suppressNextActivations();
          event.stopImmediatePropagation();
          swipeStartDetail.zone = this.#gestureZone || "screen";
          swipeStartDetail.method = "pointer";
          swipeStartDetail.direction = this.#swipeDirection;
          this.#dispatch(GESTURE_EVENTS.swipeStart, swipeStartDetail);
        }
      }
      if (this.#scrubbing) {
        event.stopImmediatePropagation();
        this.#advanceScrub(event);
      }
      if (this.#swiping && this.#swipeDirection === "down") {
        event.stopImmediatePropagation();
        const drag = y - this.#startY;
        if (drag !== this.#lastSwipeDrag) {
          const t = this.#swipeBaseTransform
            ? this.#swipeBaseTransform + " translateY(" + drag + "px)"
            : "translateY(" + drag + "px)";
          if (t !== this.#lastSwipeTransform) {
            this.#video.style.transform = t;
            this.#lastSwipeTransform = t;
          }
          this.#lastSwipeDrag = drag;
        }
      }
    }
  }

  /**
   * Consume every coalesced sample of the move so high-rate Chromium pointer
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
   *
   * Chromium's PointerEvent.getPredictedEvents() returns extrapolated FUTURE
   * positions. We speculatively "draw ahead" with them, matching the drawing
   * idiom in the Pointer Events spec (predict, then discard once real points
   * arrive): predicted travel feeds the VELOCITY estimate only, never the
   * confirmed seek delta (#scrubLastX stays pinned to real samples). Because
   * scrub's amount is a monotonic function of velocity, a fresher, higher
   * velocity read makes the response feel ahead of the hand - lower perceived
   * latency - while the absolute position stays grounded in real motion, so a
   * prediction can never overshoot or drift a fast flick. Prediction is
   * bounded: only the first predicted sample, capped to the confirmed travel.
   */
  #advanceScrub(event) {
    let totalStep = 0;
    const hasCoalesced = typeof event.getCoalescedEvents === "function";
    const samples = hasCoalesced ? event.getCoalescedEvents() : null;
    // Coalesced samples then the live event, without materializing a combined
    // array: high-rate Chromium pointer streams land here every move, so a
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

    // Speculative velocity wash: the first predicted pointer beats the live
    // event just enough to pull the velocity estimate forward, but is clamped
    // to a fraction of the confirmed step so it can never dominate or reverse
    // against a correcting hand. Purely a velocity-shaping signal.
    const hasPredicted = hasCoalesced && typeof event.getPredictedEvents === "function";
    let velocityStep = totalStep;
    // Sub-pixel gate: the additive term is clamped to the confirmed step
    // (Math.min below), so a sub-pixel prediction contributes at most
    // sub-pixel to the smoothed velocity - skip the browser's array alloc
    // for the whole sub-pixel traffic high-rate pointers produce. Also covers
    // the zero step (sign(0) term is 0 anyway; a NaN delta can no longer
    // poison velocityStep at rest).
    if (hasPredicted) {
      // |totalStep| feeds both the sub-pixel gate and the clamp below, so read
      // it once per move instead of twice.
      const absStep = Math.abs(totalStep);
      if (absStep >= 1) {
        const predicted = event.getPredictedEvents();
        if (predicted && predicted.length) {
          velocityStep += Math.sign(totalStep) *
            Math.min(Math.abs(predicted[0].clientX - event.clientX), absStep);
        }
      }
    }

    const now = event.timeStamp;
    const dt = (now - this.#scrubLastTime) / 1000;
    this.#scrubLastTime = now;
    const instantVelocity = dt > 0.001 ? velocityStep / dt : 0;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / SCRUB_VELOCITY_TAU_S) : 0;
    this.#scrubVelocity += alpha * (instantVelocity - this.#scrubVelocity);
    // Emit via the pooled event: the payload and the Event both ride reused
    // objects, so no per-move allocation (dispatchEvent runs synchronously and
    // consumers read before the next move re-mutates them).
    scrubDetail.zone = this.#gestureZone || "screen";
    scrubDetail.method = "pointer";
    scrubDetail.dx = totalStep;
    scrubDetail.velocity = this.#scrubVelocity;
    scrubDetail.timestamp = now;
    if (!this.#scope.disposed && this.#eventTarget) {
      this.#eventTarget.dispatchEvent(pooledScrubEvent());
    }
  }

  #handlePointerUp(event) {
    const tracked = this.#pointers.has(event.pointerId);
    if (tracked && this.#pointerOwned) {
      event.stopImmediatePropagation();
    }
    this.#pointers.delete(event.pointerId);
    if (this.#pointers.size === 0 && this.#pointerOwned) {
      // Session over: the click decision follows in #handleClickCapture, but
      // the compat mouseup the UA fires between pointerup and click still
      // belongs to our stream - keep swallowing it briefly (#awaitClick).
      this.#pointerOwned = false;
      this.#armAwaitClick();
    }
    if (this.#pinchZone !== null && this.#pointers.size < 2) {
      this.#pinchStartDistance = 0;
      this.#pinchFired = false;
      this.#pinchZone = null;
    }
    if (this.#primaryPointerId === null || event.pointerId !== this.#primaryPointerId) {
      return;
    }
    this.#clearHoldTimer();
    // One clock read for the whole handler: the double-tap branch below shares
    // this stamp instead of taking a second performance.now() per tap.
    const now = performance.now();
    const elapsed = now - this.#startTime;
    const dx = event.clientX - this.#startX;
    const dy = event.clientY - this.#startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (this.#holding) {
      this.#holding = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      releaseDetail.zone = this.#gestureZone;
      releaseDetail.method = "pointer";
      releaseDetail.duration = elapsed;
      this.#dispatch(GESTURE_EVENTS.release, releaseDetail);
    } else if (this.#scrubbing) {
      this.#scrubbing = false;
      this.#gestureFsActive = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      scrubEndDetail.zone = this.#gestureZone || "screen";
      scrubEndDetail.method = "pointer";
      this.#dispatch(GESTURE_EVENTS.scrubEnd, scrubEndDetail);
    } else if (this.#swiping) {
      this.#swiping = false;
      this.#gestureFsActive = false;
      this.#suppressNextActivations();
      event.stopImmediatePropagation();
      this.#restoreTransform();
      swipeDetail.zone = this.#gestureZone || "screen";
      swipeDetail.method = "pointer";
      swipeDetail.direction = this.#swipeDirection;
      swipeDetail.distance = distance;
      this.#dispatch(GESTURE_EVENTS.swipe, swipeDetail);
      this.#swipeDirection = null;
      this.#lastSwipeDrag = NaN;
      this.#lastSwipeTransform = "";
    } else if (
      elapsed < HOLD_TIMEOUT_MS &&
      this.#gestureZone !== null &&
      allowsIntent("dbltap")
    ) {
      if (now - this.#lastTapTime < DOUBLE_TAP_WINDOW_MS) {
        this.#lastTapTime = -Infinity;
        this.#cancelTapReplay();
        this.#suppressNextActivations();
        dbltapDetail.zone = this.#gestureZone;
        dbltapDetail.method = "pointer";
        this.#dispatch(GESTURE_EVENTS.dbltap, dbltapDetail);
      } else {
        // First tap: the real click (already swallowed at capture by the
        // seed flag) may still belong to a future dbltap - hold it back and
        // replay it for the SDK only if the dbltap window closes untouched.
        this.#lastTapTime = now;
        this.#armTapReplay(event.target, event.clientX, event.clientY);
      }
    }
    this.#primaryPointerId = null;
    this.#gestureZone = null;
  }

  #handlePointerCancel(event) {
    if (this.#pointers.has(event.pointerId) && this.#pointerOwned) {
      event.stopImmediatePropagation();
    }
    this.#cancelTrackedPointer(event.pointerId);
  }

  /**
   * The browser reclaimed a captured pointer with no pointerup/pointercancel
   * (capture target removed, hit-test takeover). That press is over and no
   * click will follow, so reclaim it through the same cancellation path -
   * unless the release was our own pinch transition.
   */
  #handleLostCapture(event) {
    if (this.#releasedCapture.delete(event.pointerId)) {
      return;
    }
    if (this.#pointers.has(event.pointerId)) {
      this.#cancelTrackedPointer(event.pointerId);
    }
  }

  /**
   * End every live input session through the normal teardown paths. Used when
   * focus/visibility is lost: the UA may never deliver the closing keyup or
   * pointerup, so a keyboard rate or an owned pointer stream could otherwise
   * stay latched.
   */
  #releaseSessions() {
    this.#finishKeyboardHold(false);
    for (const id of [...this.#pointers.keys()]) {
      this.#cancelTrackedPointer(id);
    }
  }

  /** Reclaim one tracked pointer: shared by pointercancel and the touchcancel
   *  sweep below, so both paths run identical idempotent teardown. */
  #cancelTrackedPointer(pointerId) {
    this.#pointers.delete(pointerId);
    if (this.#pointers.size === 0) {
      // A cancelled press ends the stream; no click is coming, so drop any
      // await latch a prior pointerup left armed.
      this.#pointerOwned = false;
      this.#clearAwaitClick();
    }
    if (this.#pinchZone !== null && this.#pointers.size < 2) {
      this.#pinchStartDistance = 0;
      this.#pinchFired = false;
      this.#pinchZone = null;
    }
    // A pointercancel means the browser reclaimed the pointer (system
    // gesture, hit-test fighting, lost capture) - the interaction was never a
    // completed user gesture. Never commit a swipe, and never arm/seed the
    // double-tap window from a cancelled touch.
    if (this.#primaryPointerId === null || pointerId !== this.#primaryPointerId) {
      return;
    }
    this.#endPointerSession();
    this.#primaryPointerId = null;
    this.#gestureZone = null;
  }

  /** Whether this press belongs to the shell's gesture stream (zone capture
   *  should stop it). Used for touchstart/mousedown, which can arrive before
   *  or without the tracked pointerdown; mirrors #handlePointerDown's
   *  eligibility: armed gestures, left button, outside shell chrome, over the
   *  video (or joining a live session). */
  #dominatesPress(event) {
    if (event.button !== undefined && event.button !== 0) {
      return false;
    }
    if (!allowsAnyIntent()) {
      return false;
    }
    if (this.#eventTarget && isInsideShell(this.#eventTarget, event.target)) {
      return false;
    }
    if (this.#pointers.size > 0) {
      return true;
    }
    const point = (event.touches && event.touches[0]) || event;
    if (point.clientX === undefined) {
      return false;
    }
    return this.#hitTestVideo(point);
  }

  #armAwaitClick() {
    this.#awaitClick = true;
  }

  #clearAwaitClick() {
    this.#awaitClick = false;
  }

  /** Hold a first tap's click back for the dbltap window; on expiry (no
   *  second tap completed the gesture) the SDK receives a synthetic click at
   *  the original coordinates - so a single tap still reaches the SDK while
   *  a double tap never leaks its first click. Debounce only engages when
   *  the dbltap intent is armed (fullscreen), so inline taps keep their
   *  native zero-latency click. */
  #armTapReplay(target, x, y) {
    this.#cancelTapReplay();
    this.#tapReplayTarget = target;
    this.#tapReplayX = x;
    this.#tapReplayY = y;
    this.#tapReplayTimer = setTimeout(() => {
      this.#tapReplayTimer = null;
      this.#replayTapClick();
    }, DOUBLE_TAP_WINDOW_MS);
  }

  #cancelTapReplay() {
    clearTimeout(this.#tapReplayTimer);
    this.#tapReplayTimer = null;
    this.#tapReplayTarget = null;
  }

  #replayTapClick() {
    const target = this.#tapReplayTarget;
    this.#tapReplayTarget = null;
    if (this.#scope.disposed || !target || !target.isConnected) {
      return;
    }
    const win = target.ownerDocument && target.ownerDocument.defaultView;
    const Ctor = (win && win.MouseEvent) || globalThis.MouseEvent;
    if (!Ctor) {
      return;
    }
    const event = new Ctor("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win || null,
      detail: 1,
      clientX: this.#tapReplayX,
      clientY: this.#tapReplayY
    });
    replayedClicks.add(event);
    target.dispatchEvent(event);
  }

  #handleClickCapture(event) {
    // Our own single-tap stand-in: pass it to the SDK untouched.
    if (replayedClicks.has(event)) {
      this.#clearAwaitClick();
      return;
    }
    const ownedPress = this.#awaitClick || this.#tapReplayTarget !== null;
    this.#clearAwaitClick();
    // Gesture window: every activation the shell consumed stays invisible -
    // the window is a deadline, consumed by time, so a dblclick arriving
    // after its clicks is swallowed too.
    if (clickTime() < this.#suppressClickUntil) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    if (!ownedPress) {
      return; // Press the shell never took (SDK control, outside rect, right
      // button): native single click passes through as-is.
    }
    if (this.#tapReplayTarget) {
      // First tap of a possible dbltap - hold the real click back; the seed
      // replays it for the SDK if the window closes without a second tap.
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    // Owned press that never seeded (long press, dbltap disarmed): a plain
    // single click - pass natively, zero latency.
  }

  #handleDblClickCapture(event) {
    if (replayedClicks.has(event)) {
      return;
    }
    if (clickTime() < this.#suppressClickUntil) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    if (this.#tapReplayTarget) {
      // Two slow taps (outside the dbltap window): both clicks are managed
      // by their seeds, so the UA's dblclick stays invisible too.
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }

  #handleWheelCapture(event) {
    if (fs && event.ctrlKey && !event.momentum && allowsIntent("pinch")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (performance.now() >= this.#trackpadPinchCooldownUntil) {
        this.#trackpadPinchCooldownUntil = performance.now() + TRACKPAD_COOLDOWN_MS;
        this.#suppressNextActivations();
        pinchDetail.zone = "screen";
        pinchDetail.method = "trackpad";
        pinchDetail.direction = event.deltaY < 0 ? "out" : "in";
        this.#dispatch(GESTURE_EVENTS.pinch, pinchDetail);
      }
      return;
    }
    // Plain wheel in fullscreen: the document behind the fullscreen surface
    // has nothing to show, so don't let the gesture chain into it (edge
    // rubber-banding / pull-to-refresh). Propagation still flows so listeners
    // inside the shell (panel scrollers, SDK hover handlers) behave normally -
    // wheel over the panel itself is left scrollable.
    if (fs && !event.ctrlKey) {
      const path = event.composedPath?.() || [];
      // Indexed scan over an arrow + Array.prototype.some: the predicate would
      // allocate a closure and call back per node on every fullscreen wheel
      // event, which the inline loop avoids.
      let overPanel = false;
      for (let i = 0; i < path.length; i++) {
        if (path[i].classList?.contains("pf-panel")) {
          overPanel = true;
          break;
        }
      }
      if (!overPanel) {
        event.preventDefault();
      }
    }
  }

  /**
   * Space is absent from the binding table on purpose: it carries hold-to-
   * speed semantics and intentionally ignores the hotkeys toggle. The
   * capture-phase keydown preventDefault cancels the UA's own Space-activates-
   * video default so it cannot fight the hold, and a bare tap toggles play/
   * pause on the real keyup.
   */
  #handleKeydown(event) {
    if (event.repeat) {
      // Mirror the first press's ownership decision: repeats of an owned key
      // are shielded from the page exactly like that press was; repeats of a
      // press the page owned keep leaking untouched.
      if (this.#ownedKeyCodes.has(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    // Fresh press: re-latch from scratch so a swallowed earlier keyup can
    // never keep shielding a press this one no longer owns.
    this.#ownedKeyCodes.delete(event.code);
    if (event.code === "Space") {
      if (this.#shouldHandleKeys(false)) {
        lastActiveForge = this;
        // Own the press end-to-end: preventDefault cancels the UA's
        // Space-activates-video default, and stopImmediatePropagation keeps
        // page-level handlers (a platform's own Space shortcut lives on
        // document bubble after this capture listener) from toggling pause
        // mid-press - a pause before the 300ms timer would starve the hold
        // every time. Capturing ownership also lets keyup settle exactly
        // what keydown decided, even if focus moved in between.
        event.preventDefault();
        event.stopImmediatePropagation();
        // A swallowed keyup (focus slipped into an iframe, a page handler
        // ate it) would leave the boost latched and poison every later hold:
        // settle the orphaned session first, then re-arm from a clean state.
        if (this.#keyboardHolding) {
          this.#keyboardHolding = false;
          this.#dispatchKeyboardRelease();
        }
        this.#keyboardOwn = true;
        this.#ownedKeyCodes.add("Space");
        this.#keyboardHoldStart = performance.now();
        clearTimeout(this.#keyboardHoldTimer);
        this.#keyboardHoldTimer = setTimeout(() => {
          this.#keyboardHoldTimer = null;
          if (!this.#video.paused && allowsIntent("hold")) {
            this.#keyboardHolding = true;
            holdDetail.zone = "screen";
            holdDetail.method = "keyboard";
            holdDetail.duration = performance.now() - this.#keyboardHoldStart;
            this.#dispatch(GESTURE_EVENTS.hold, holdDetail);
          }
        }, HOLD_TIMEOUT_MS);
      } else {
        // Not ours (text entry, foreign focus): a later keyup must not
        // toggle playback for a press the page owned.
        this.#keyboardOwn = false;
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
      this.#ownedKeyCodes.add(event.code);
      keyDetail.method = "keyboard";
      keyDetail.direction = binding.direction;
      this.#dispatch(binding.emit, keyDetail);
      return;
    }
  }

  #handleKeyup(event) {
    this.#ownedKeyCodes.delete(event.code);
    if (event.code !== "Space") {
      return;
    }
    this.#finishKeyboardHold(true);
  }

  /**
   * End a Space session: an active hold always releases (restoring playback
   * rate via the action layer), a bare tap toggles play/pause - but only on a
   * real keyup for a press keydown captured (#keyboardOwn), never for a press
   * that started in a text field. Blur finishes silently-with-release and
   * never toggles.
   */
  #finishKeyboardHold(allowToggle) {
    const wasHolding = this.#keyboardHolding;
    const owned = this.#keyboardOwn;
    this.#keyboardOwn = false;
    this.#ownedKeyCodes.delete("Space");
    this.#keyboardHolding = false;
    clearTimeout(this.#keyboardHoldTimer);
    this.#keyboardHoldTimer = null;
    if (wasHolding) {
      this.#dispatchKeyboardRelease();
    } else if (allowToggle && owned && this.#shouldHandleKeys()) {
      if (this.#video.paused) {
        // play() returns a promise on spec engines; guard so an odd host
        // (test shims, minimal webviews) degrades to a silent no-op instead
        // of a TypeError inside the keyup handler.
        const played = this.#video.play();
        if (played && typeof played.catch === "function") {
          played.catch((err) => {
            if (!isBenignMediaPolicyError(err)) {
              logger.log("forge", "bare-tap play rejected:", err.name);
            }
          });
        }
      } else {
        this.#video.pause();
      }
    }
  }
}
