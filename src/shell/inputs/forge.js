import { allowsIntent, allowsAnyIntent, isKeyArmed, KEY_BINDINGS, GESTURE_EVENTS, easeTransformTo, cancelEase } from "./actions.js";
import { TUNING, isBenignMediaPolicyError } from "../../shared/core.js";
import { deepestActiveElement, isInsideShell, fs, subscribeFullscreen, DOMManager } from "../../shared/dom.js";
import { logger, Scope, delay } from "../../shared/runtime.js";

/**
 * Pointer handlers are passive and never preventDefault on the press or move
 * streams - the prevent-scope rule: a plain tap's whole native sequence
 * passes unclaimed, and only a LATCHED session (scrub/swipe at threshold,
 * hold at timeout, pinch at recognition) claims the stream from there on.
 * Native pan/scroll over the zone was still the one touch-pipeline claimant
 * worth hedging against before a session exists, so the touch-action CSS
 * set at construction carries that guarantee, and a guarded touchmove belt
 * reinforces it mid-stream while a session is owned. Only three listeners
 * cancel defaults now: the claimed-session touchmove belt, the wheel pinch
 * listener (subscribed only while fullscreen), and the click/dblclick
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

/**
 * Interactive SDK controls whose presses the engine never adopts into the tap
 * machine: when a press's composed target resolves one of these, the decision
 * rejects and the SDK's double-tap/streak state stays entirely its own. This
 * is the press-stream version of the DOM hit-test law (no pf surface may
 * block): the engine claims NO stream at press time - a plain tap's full
 * native sequence (pointer, compat mouse/touch, the UA click) passes to the
 * page untouched, per the prevent-scope rule (suppress only the SDK's context
 * menu everywhere and its double taps in fullscreen). The lattice's remaining
 * job is the decision: SDK controls' presses must not feed the gesture
 * machine, or a control's own double-tap semantics would race the skip.
 * SDK rails are the exact shape: buttons or role-bearing wrappers. Not
 * listed: video itself (the gesture surface), tabindex'd
 * wrappers (too coarse - an SDK div with a focus target is not a control),
 * svg (same).
 * One native widening past the shape list, read per press (press is not a
 * hot path and the rect read already forced layout): the affordance cursor -
 * role-less SDK chrome (menus, custom rails, drag handles) declares its
 * press affordance the one way the platform lets it: `cursor: pointer|grab`.
 * The head element honors it as an interactive marker, but ONLY on a small
 * box (here: <= half the video's area) that is not the gesture-surface
 * family (the video, or an ancestor wrapping it): a click-to-pause wrapper
 * styling cursor:pointer over the whole player is the player surface, and
 * surrendering it wholesale would kill the gestures there.
 * Cost: one closest() climb per press attempt, only on flips of ownership -
 * press is not a hot path and no extra layout is read beyond the head rect
 * the affordance clause needs (the video rect is already cached warm).
 */
const SDK_CONTROLS_SELECTOR =
  "button, a, input, textarea, select, label, summary, [contenteditable]," +
  '[role="button"], [role="switch"], [role="checkbox"], [role="radio"],' +
  '[role="menuitem"], [role="option"], [role="tab"], [role="slider"]';
const PINCH_SCALE_THRESHOLD = TUNING.gestures.pinchScaleThreshold;
const TRACKPAD_COOLDOWN_MS = TUNING.gestures.trackpadCooldownMs;
const SUPPRESS_WINDOW_MS = TUNING.gestures.suppressWindowMs;
const DOUBLE_TAP_WINDOW_MS = TUNING.gestures.doubleTapWindowMs;
const SCRUB_VELOCITY_TAU_S = TUNING.scrub.velocityFilterMs / 1000;

/**
 * Cross-forge keyboard arbitration registry: which engine owns playback keys.
 * One module singleton - the arbitration is inherently global across all live
 * engines.
 */
class ForgeRegistry {
  /** All live input engines, used for keyboard focus arbitration. */
  #actives = new Set();
  #last = null;

  add(forge) {
    this.#actives.add(forge);
  }

  /** Drop a destroyed engine; clears the "last active" marker when it owns it. */
  remove(forge) {
    this.#actives.delete(forge);
    if (this.#last === forge) {
      this.#last = null;
    }
  }

  /** Live engines; iterated inside InputForge's keyboard arbitration. */
  actives() {
    return this.#actives;
  }

  isLast(forge) {
    return this.#last === forge;
  }

  makeLast(forge) {
    this.#last = forge;
  }
}

const forgeRegistry = new ForgeRegistry();

/**
 * Reusable scratch for the first two live pointers. The pinch path runs on
 * every two-finger move, so reading the pair into this single object (instead
 * of [...values()].slice(0,2) - two array allocations per move) keeps the hot
 * loop allocation-free for the JIT. Mutated in place; callers must read it
 * immediately.
 */
const firstTwoPointers = { x0: 0, y0: 0, x1: 0, y1: 0 };

/**
 * Pooled per-family event payloads mirroring the scrub payload: every #dispatch
 * site mutates one fixed-shape object in place and re-dispatches one pooled
 * Event, so the gesture boundary allocates nothing per event. Same
 * synchronous-read contract - consumers read detail.* inside dispatchEvent and
 * never retain the object, so each dispatch site must rewrite EVERY field it
 * owns (no stale carries between events).
 */
const releaseDetail = { zone: "", method: "pointer" };
const holdDetail = { zone: "", method: "pointer" };
const scrubEndDetail = { zone: "", method: "pointer" };
const pinchDetail = { zone: "", method: "pointer", direction: "" };
const swipeStartDetail = { zone: "", method: "pointer", direction: "" };
const swipeDetail = { zone: "", method: "pointer", direction: "", distance: 0 };
const dbltapDetail = { zone: "", method: "pointer" };
const keyDetail = { method: "keyboard", direction: undefined };
// Scrub's per-name detail payload, refilled in place by ScrubStroke.advance
// (same
// mutate-in-place discipline as the other per-family payloads; actions.js
// reads it synchronously within the scrub handler).
const scrubDetail = { zone: "", method: "pointer", dx: 0, dy: 0, velocity: 0, timestamp: 0 };

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
 * Pooled per-name CustomEvents so the gesture boundary never allocates - one
 * mechanism for every semantic event, including scrub. Scrub fires once per
 * coalesced pointer move (up to display rate), so allocating a fresh
 * CustomEvent per move - the old pre-pool shape - churned the young
 * generation for the whole drag; the pooled Event plus its pooled detail
 * payload ride the same path as every other event. Each instance gets a
 * fresh own `detail` assigned before every dispatch (own properties shadow
 * the prototype getter), and consumers read it synchronously without
 * retaining it (actions.js reads detail.dx/velocity within the scrub
 * handler), so a re-dispatched instance is safe - nothing retains the object
 * past the caller that last read it. Lazy `globalThis.CustomEvent` resolution
 * keeps the pool realm-safe (built in the same realm as the surface it is
 * dispatched onto). One pool entry per name; each engine instantiates its
 * own channel, and only one gesture per name can be in flight at a time
 * within an engine, so sharing is safe.
 */
class GestureChannel {
  #pool = new Map();

  event(name, detail) {
    const Ctor = globalThis.CustomEvent;
    const stale = this.#pool.get(name);
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
    this.#pool.set(name, { Ctor, event });
    return event;
  }
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
 * Scrub recognizer: the pointer move-stream machine. Owns the stroke's
 * sample anchors and the real-time velocity filter, and the per-move pooled
 * dispatch. The engine owns the latch decision (axis thresholds + intent
 * gate) and stream policy; once latched, every subsequent call into this
 * machine rides the same decisions being fixed mid-session.
 */
class ScrubStroke {
  #dispatch;
  #zone;
  #active = false;
  #lastX = 0;
  // Y mirror of #lastX: the pan arm of scrub (zoomed fullscreen) needs
  // the vertical stroke delta the seek arm never consumed.
  #lastY = 0;
  #lastTime = 0;
  #velocity = 0;

  constructor(dispatch, zone) {
    this.#dispatch = dispatch;
    this.#zone = zone;
  }

  get active() {
    return this.#active;
  }

  /** Fresh press: anchors re-init so a later latch starts from its origin. */
  reset(x, y, time) {
    this.#active = false;
    this.#lastX = x;
    this.#lastY = y;
    this.#lastTime = time;
    this.#velocity = 0;
  }

  latch(x, y, time) {
    this.#active = true;
    this.#lastX = x;
    this.#lastY = y;
    this.#lastTime = time;
    this.#velocity = 0;
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
   * confirmed seek delta (#lastX stays pinned to real samples). Because
   * scrub's amount is a monotonic function of velocity, a fresher, higher
   * velocity read makes the response feel ahead of the hand - lower perceived
   * latency - while the absolute position stays grounded in real motion, so a
   * prediction can never overshoot or drift a fast flick. Prediction is
   * bounded: only the first predicted sample, capped to the confirmed travel.
   */
  advance(event) {
    let totalStep = 0;
    let totalStepY = 0;
    // getCoalescedEvents (58) and getPredictedEvents (92) are
    // floor-guaranteed, and even constructed/synthetic PointerEvents carry
    // the interface methods returning empty lists - so the old API-absent
    // arms were unreachable; an empty list lands in the same loop below.
    const samples = event.getCoalescedEvents();
    // Coalesced samples then the live event, without materializing a combined
    // array: high-rate Chromium pointer streams land here every move, so a
    // [[...samples, event]] spread per frame would allocate needlessly.
    const count = samples.length + 1;
    let lastX = this.#lastX;
    let lastY = this.#lastY;
    for (let i = 0; i < count; i++) {
      const sample = i < samples.length ? samples[i] : event;
      totalStep += sample.clientX - lastX;
      lastX = sample.clientX;
      totalStepY += sample.clientY - lastY;
      lastY = sample.clientY;
    }
    this.#lastX = lastX;
    this.#lastY = lastY;

    // Speculative velocity wash: the first predicted pointer beats the live
    // event just enough to pull the velocity estimate forward, but is clamped
    // to a fraction of the confirmed step so it can never dominate or reverse
    // against a correcting hand. Purely a velocity-shaping signal.
    let velocityStep = totalStep;
    // Sub-pixel gate: the additive term is clamped to the confirmed step
    // (Math.min below), so a sub-pixel prediction contributes at most
    // sub-pixel to the smoothed velocity - skip the browser's array alloc
    // for the whole sub-pixel traffic high-rate pointers produce. Also covers
    // the zero step (sign(0) term is 0 anyway; a NaN delta can no longer
    // poison velocityStep at rest).
    const absStep = Math.abs(totalStep);
    if (absStep >= 1) {
      const predicted = event.getPredictedEvents();
      if (predicted.length) {
        velocityStep += Math.sign(totalStep) *
          Math.min(Math.abs(predicted[0].clientX - event.clientX), absStep);
      }
    }

    const now = event.timeStamp;
    const dt = (now - this.#lastTime) / 1000;
    this.#lastTime = now;
    const instantVelocity = dt > 0.001 ? velocityStep / dt : 0;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / SCRUB_VELOCITY_TAU_S) : 0;
    this.#velocity += alpha * (instantVelocity - this.#velocity);
    // Emit via the pooled event: the payload and the Event both ride reused
    // objects, so no per-move allocation (dispatchEvent runs synchronously and
    // consumers read before the next move re-mutates them).
    scrubDetail.zone = this.#zone() || "screen";
    scrubDetail.method = "pointer";
    scrubDetail.dx = totalStep;
    scrubDetail.dy = totalStepY;
    scrubDetail.velocity = this.#velocity;
    scrubDetail.timestamp = now;
    this.#dispatch(GESTURE_EVENTS.scrub, scrubDetail);
  }

  /** Stroke end: unlatch and emit the pooled scrub-end. Self-guarding -
   *  the engine's session teardown runs unconditionally for all strokes. */
  end() {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    scrubEndDetail.zone = this.#zone() || "screen";
    scrubEndDetail.method = "pointer";
    this.#dispatch(GESTURE_EVENTS.scrubEnd, scrubEndDetail);
  }
}

/**
 * Swipe recognizer: the vertical drag machine owns the video-transform side
 * of a swipe stroke - the live-visual capture, the per-move translateY
 * follow, and the eased restore. The engine owns the latch
 * decision, stream policy (capture, suppression, swipeStart dispatch). Per
 * shell law the zoom/fill crop is the one transform owner; this stroke
 * deliberately rewrites the same property as legacy behavior - its base
 * snapshot and the eased hand-back make it a scope of one, restored before
 * the swipe event can be consumed.
 */
class SwipeStroke {
  #video;
  #active = false;
  #direction = null;
  #baseTransform = "";
  #lastDrag = NaN;
  #lastTransform = "";

  constructor(video) {
    this.#video = video;
  }

  get active() {
    return this.#active;
  }

  get direction() {
    return this.#direction;
  }

  /** Fresh press: the drag state dies with the press; the base snapshot
   *  persists (it is only ever read by a stroke that re-captures it first). */
  reset() {
    this.#active = false;
    this.#direction = null;
    this.#lastDrag = NaN;
    this.#lastTransform = "";
  }

  /** Latch: snapshot the LIVE visual before any write happens, and promote
   *  the video to a compositor layer the moment a down-drag takes the stroke
   *  so the per-move translateY tracks on the compositor (pointer rate)
   *  instead of forcing a re-rasterizing style recalc every move. Dropped
   *  again by the restore ease below.
   *  The live-visual guard: a snap in flight (TransformEase fill:"both",
   *  120ms) owns the rendered value while style.transform still reads its
   *  pre-flight value, so a plain inline read snapshots where the video WAS,
   *  not where it shows. getAnimations (84, on Element) is floor-guaranteed;
   *  the jsdom inline-read arm was its only other caller shape - the same
   *  arm TransformEase's transition fallback occupied until it died. */
  latch(direction) {
    this.#active = true;
    this.#direction = direction;
    // The computed read covers the no-animation case too: with zero running
    // animations the computed transform IS the inline value.
    this.#baseTransform = getComputedStyle(this.#video).transform;
    // "none" cannot compose in a list; the string-empty base means a
    // bare translateY follow, the resting composition.
    if (this.#baseTransform === "none") {
      this.#baseTransform = "";
    }
    if (this.#direction === "down") {
      this.#video.style.willChange = "transform";
    }
  }

  /** Per-move follow: the engine derives the stroke delta (y relative to the
   *  press origin); this machine deduplicates frame-identical writes. The
   *  follow translate LEADS the list so it lands after everything else in
   *  screen space (leftmost = outermost = applied last): appended after the
   *  composition it would live inside a live scale() and follow at s× the
   *  pointer rate. */
  drag(drag) {
    if (drag === this.#lastDrag) {
      return;
    }
    const t = this.#baseTransform
      ? "translateY(" + drag + "px) " + this.#baseTransform
      : "translateY(" + drag + "px)";
    if (t !== this.#lastTransform) {
      this.#video.style.transform = t;
      this.#lastTransform = t;
    }
    this.#lastDrag = drag;
  }

  /** Stroke end when still latched: drop the drag state and ease the video
   *  back to the pre-stroke composition. Self-guarding, like ScrubStroke.end. */
  end() {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#direction = null;
    this.#lastDrag = NaN;
    this.#lastTransform = "";
    easeTransformTo(this.#video, this.#baseTransform || "");
  }
}

/**
 * Double-tap window machine: the first tap of a possible double tap opens the
 * window; a tap inside it closes it as the dbltap gesture (the engine then
 * dispatches and suppresses the following activation). No seed and no replay:
 * by the prevent-scope rule the tap's native stream was never claimed, so
 * there is nothing held back to hand back on expiry - the engine only
 * observes timing. The window state persists across presses, so it keeps its
 * own class (rule 4) instead of folding into module-level lets.
 */
class TapWindow {
  /** -Infinity so the very first tap can never match against boot time. */
  #lastTapTime = -Infinity;

  /** One pointerup tap visited. Returns "second" when this tap closes a
   *  dbltap window (the engine dispatches dbltap and suppresses the
   *  activations that follow), "first" when it opens one. */
  tap(now) {
    if (now - this.#lastTapTime < DOUBLE_TAP_WINDOW_MS) {
      this.#lastTapTime = -Infinity;
      return "second";
    }
    this.#lastTapTime = now;
    return "first";
  }
}

/**
 * Space key machine: hold-to-speed + bare-tap toggle. The engine keeps the
 * keydown/keyup routing (binding-table dispatch, focus arbitration, the
 * cross-code repeat shield set); this owns the press's hold timer, hold
 * state, and its release/toggle decision, so an orphaned hold left latched
 * by a swallowed keyup can be settled exactly by the next press.
 */
class SpaceSession {
  #video;
  #dispatch;
  /** Liveness gate for the bare-tap toggle (focus may have moved between
   *  keydown and keyup), borrowed from the engine at handoff time. */
  #canToggle;
  #timer = null;
  #holding = false;
  /** Whether the CURRENT Space press was captured by us. The keydown decision
   *  (shouldHandleKeys) is latched here so keyup never toggles playback for a
   *  press we did not own (focus moved between down and up), and always
   *  releases a hold we did. */
  #own = false;

  constructor(video, dispatch, canToggle) {
    this.#video = video;
    this.#dispatch = dispatch;
    this.#canToggle = canToggle;
  }

  /** A captured press begins (the engine already made the ownership and
   *  shielding decisions): settle any orphaned hold, then re-arm from a
   *  clean state - a swallowed keyup would otherwise poison every later
   *  hold with a latched boost. */
  press() {
    if (this.#holding) {
      this.#holding = false;
      this.#dispatchRelease();
    }
    this.#own = true;
    this.clearTimer();
    this.#timer = delay(() => {
      this.#timer = null;
      if (!this.#video.paused && allowsIntent("hold")) {
        this.#holding = true;
        holdDetail.zone = "screen";
        holdDetail.method = "keyboard";
        this.#dispatch(GESTURE_EVENTS.hold, holdDetail);
      }
    }, HOLD_TIMEOUT_MS);
  }

  /** A press the page owned (text entry, foreign focus): its keyup must not
   *  toggle playback for it. */
  foreign() {
    this.#own = false;
  }

  /**
   * End a Space session: an active hold always releases (restoring playback
   * rate via the action layer), a bare tap toggles play/pause - but only for
   * a press keydown captured, never for a press that started in a text
   * field. Blur finishes silently-with-release and never toggles.
   */
  release(allowToggle) {
    const wasHolding = this.#holding;
    const owned = this.#own;
    this.#own = false;
    this.#holding = false;
    this.clearTimer();
    if (wasHolding) {
      this.#dispatchRelease();
    } else if (allowToggle && owned && this.#canToggle()) {
      if (this.#video.paused) {
        // play() is a promise (spec-mandated since the API landed); benign
        // policy rejections (autoplay block) idle silently here.
        this.#video.play().catch((err) => {
          if (!isBenignMediaPolicyError(err)) {
            logger.log("forge", "bare-tap play rejected:", err.name);
          }
        });
      } else {
        this.#video.pause();
      }
    }
  }

  /** Teardown-shaped finish: restore a latched hold's rate (release-only,
   *  never toggles - used only where focus truth is unknowable, destroy). */
  abort() {
    if (this.#holding) {
      this.#holding = false;
      this.#dispatchRelease();
    }
    this.#own = false;
  }

  clearTimer() {
    // Almost every landing reaches here with no hold timer armed; the
    // null check skips the cancel invocation on that hot path. The null
    // assignment stays unconditional so the field is reset.
    if (this.#timer !== null) {
      this.#timer();
    }
    this.#timer = null;
  }

  #dispatchRelease() {
    releaseDetail.zone = "screen";
    releaseDetail.method = "keyboard";
    this.#dispatch(GESTURE_EVENTS.release, releaseDetail);
  }
}

/**
 * InputForge engine: the gesture router. Turns pointer/keyboard/wheel
 * physics into semantic GESTURE_EVENTS on the shell host; every policy
 * decision (settings gates, fullscreen requirement) is delegated to the
 * declarative INPUT_BINDINGS list, sampled live at each decision point.
 * Per-story state machines own the recognizer state (ScrubStroke, SwipeStroke,
 * TapWindow, SpaceSession) while the engine keeps the stream: press * eligibility, pointer tracking, the shared session-latch flag, and the
 * click/dblclick suppression decisions.
 *
 * Chromium 156+ native by design: one AbortSignal owns the entire listener
 * lifetime (destroy() === scope.abort()), all pointer listeners are passive,
 * scrub sampling consumes getCoalescedEvents(), and fullscreen truth is the
 * single shared `fs` gate (shadow.js), built on the native fullscreen event.
 */
export class InputForge {
  #video;
  #zone;
  #eventTarget;
  /** Pooled semantic-event channel owned by this engine instance. */
  #channel = new GestureChannel();

  /** DOM lifecycle manager: listeners, observers, style rollbacks. */
  #dom = new DOMManager();
  /** Lifecycle scope: signal exposed via getter for action wiring; the
   *  disposed flag guards dispatch + destroy. */
  #scope = new Scope();

  // Cached <video> box for hit-testing, invalidated per press (and at
  // teardown) so pointerdown never forces a synchronous layout flush with
  // getBoundingClientRect; a fresh press re-reads truth, covering anything a
  // ResizeObserver or a fullscreen flip cannot.
  #videoRect = null;

  // Pointer session state.
  #primaryPointerId = null;
  #startX = 0;
  #startY = 0;
  #startTime = 0;
  #holdTimer = null;
  #holding = false;
  #gestureZone = null;

  // Click/dblclick suppression after gestures: a deadline (time-based, not
  // one-shot) that every activation inside the window is swallowed by - the
  // window stays armed for its full span so click AND dblclick both die.
  #suppressClickUntil = 0;

  // Press ownership, split for the prevent-scope rule (suppress only the
  // SDK's context menu everywhere and its double taps in fullscreen; every
  // plain tap passes natively):
  //   #pointerOwned - the DECISION: the press was gesture-eligible, so up
  //     feeds the tap window and session arms claim the stream. A plain tap
  //     is decision-owned but stream-open.
  //   #streamClaimed - an ARMED session (scrub/swipe/hold/pinch) captured the
  //     pointer; only this flag gates the zone-capture stream suppressors,
  //     so taps keep their whole native sequence including the UA click.
  //   #awaitClick - latched at pointerup for claimed sessions only, to
  //     swallow the compat mouseup before the click decision; it clears on
  //     the arriving click, on cancel, or on the next pointerdown - no timer
  //     needed.
  #pointerOwned = false;
  #streamClaimed = false;
  #awaitClick = false;

  /** Per-story machines, built in the constructor (each borrows the engine's
   *  live gesture boundaries: video, dispatch, zone). Scrub: the move-stream
   *  recognizer; Swipe: the translate-drag machine; TapWindow: the dbltap
   *  first/second window; SpaceSession: the keyboard hold/toggle press. */
  #scrub;
  #swipe;
  #tap;
  #space;

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

  // Keyboard: the Space press machine owns its own state below; only the
  // cross-code repeat shield set stays engine-owned (bindings + repeats).
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
    // The recognizer set: borrowed closures over this engine's live gesture
    // boundaries (video element for transform/toggle truth, dispatch for the
    // pooled semantic events, the gesture-zone reader for session teardowns).
    const dispatchGesture = (name, detail) => this.#dispatch(name, detail);
    this.#scrub = new ScrubStroke(dispatchGesture, () => this.#gestureZone);
    this.#swipe = new SwipeStroke(video);
    this.#tap = new TapWindow();
    this.#space = new SpaceSession(video, dispatchGesture, () => this.#shouldHandleKeys());
    const { signal } = this.#scope;
    // Track touch-action (kills scroll/pinch takeover) and user-select (kills
    // native selection highlight + its hit-testing while scrubbing over page
    // text) for automatic rollback on destroy. The touch-action contract is
    // consulted from the touch target UP the flat tree, so it is anchored on
    // the video itself too - embeds where the video does not share the
    // container's chain (sibling overlays, SDK re-parenting during
    // fullscreen) still present a default-auto chain to the browser.
    this.#dom.markStyle(zone, "touch-action", "none");
    this.#dom.markStyle(zone, "user-select", "none");
    this.#dom.markStyle(video, "touch-action", "none");

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
    // Belt under touch-action none: during a claimed session, touchmove
    // carries no default that should win - scrolling or UA recognizers
    // taking the stream out from under the latched stroke. Cancelled while
    // claimed only, so plain taps and SDK streams stay native.
    zone.addEventListener("touchmove", (event) => {
      if (this.#streamClaimed) {
        event.preventDefault();
      }
    }, { capture: true, passive: false, signal });
    // Capture loss without a pointerup/cancel pair (element removed, hit-test
    // takeover) would strand an owned session; treat it as cancellation.
    zone.addEventListener("lostpointercapture", (event) => this.#handleLostCapture(event), options);
    zone.addEventListener("click", (event) => this.#handleClickCapture(event), { capture: true, signal });
    zone.addEventListener("dblclick", (event) => this.#handleDblClickCapture(event), { capture: true, signal });
    // SDK stream suppression - ONE policy table for the compat mouse/touch
    // streams, keyed on the ARMED claim, not the press decision. The
    // prevent-scope rule: a plain tap's whole stream (pointer, compat
    // mouse/touch, the UA click) passes natively - suppressing it here would
    // hide the SDK's only real click. Only a latched session (scrub, swipe,
    // hold, pinch) stops the compat streams it is already owning through
    // pointer capture, and its mouseup/touchend tails feed the click hangover
    // (#awaitClick) until the suppressed click decides. Machine-idle moves
    // and every plain tap pass through untouched.
    const STREAM_GUARDS = {
      mousedown: (event) => event.button === 0 && this.#streamClaimed,
      touchstart: () => this.#streamClaimed,
      mousemove: () => this.#streamClaimed,
      touchmove: () => this.#streamClaimed,
      mouseup: (event) => event.button === 0 && (this.#streamClaimed || this.#awaitClick),
      touchend: () => this.#streamClaimed || this.#awaitClick
    };
    for (const [type, guard] of Object.entries(STREAM_GUARDS)) {
      zone.addEventListener(type, (event) => {
        if (guard(event)) {
          event.stopImmediatePropagation();
        }
      }, options);
    }
    // touchcancel shares the touchend guard and adds the pointer sweep: a
    // host can deliver it without the paired pointercancel, and the swallow
    // alone would leave #pointerOwned/#streamClaimed/#awaitClick latched and
    // the compat stream eaten until some later pointerup. A cancelled touch
    // reclaims every tracked pointer - the sweep is idempotent when the
    // paired pointercancel already ran (and vice versa).
    zone.addEventListener("touchcancel", (event) => {
      if (STREAM_GUARDS.touchend()) {
        event.stopImmediatePropagation();
      }
      for (const id of this.#pointers.keys()) {
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

    forgeRegistry.add(this);
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

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#detachTrackpadPinch();
    // Release dispatches (pointer hold / scrub) must reach the action layer
    // while the scope signal is still live - dispose() lands at the end,
    // exactly where #scope.abort() used to.
    this.#endPointerSession();
    this.#clearHoldTimer();
    this.#videoRect = null;
    this.#pointers.clear();
    cancelEase(this.#video);
    // DOM lifecycle: disconnect observers, restore styles, remove elements.
    this.#dom.destroy();
    forgeRegistry.remove(this);
    this.#space.abort();
    this.#ownedKeyCodes.clear();
    this.#space.clearTimer();
    this.#pointerOwned = false;
    this.#streamClaimed = false;
    this.#clearAwaitClick();
    this.#scope.dispose();
  }

  /** Suppress the click/dblclick that follows an interactive gesture. */
  #suppressNextActivations() {
    this.#suppressClickUntil = performance.now() + SUPPRESS_WINDOW_MS;
  }

  /** Fill the shared release detail and dispatch the GESTURE_EVENTS.release
   *  command from `start` to now. */
  #fireRelease(zone, method) {
    releaseDetail.zone = zone;
    releaseDetail.method = method;
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
    // exit - both fs-gated), so while the fs gate is open the reference is
    // the physical display - screen also sidesteps innerWidth's
    // scrollbar-inclusive quirk on Chromium and covers the fullscreen-iframe
    // shape (clientX is viewport-relative and the frame fills the display).
    // Inline the player occupies only the viewport: a screen-relative verdict
    // could name edges the player does not have, so the reference becomes the
    // surface the press actually landed on. Every behavioral zone consumer is
    // fs-gated (the inline zone is telemetry only - hold/release details and
    // the press breadcrumbs), which is exactly why fs closing may degrade
    // the reference instead of breaking a gesture. The window fallback
    // answers the headless fact (screen.width 0), not a missing-global
    // paranoia: `screen` is bound in every Chromium frame.
    const screenWidth = fs
      ? (screen.width > 0 ? screen.width : window.innerWidth)
      : window.innerWidth;
    if (pointerEvent.clientX < screenWidth * EDGE_ZONE_RATIO) {
      return "left-edge";
    } else if (pointerEvent.clientX > screenWidth * EDGE_ZONE_START) {
      return "right-edge";
    } else {
      return "screen";
    }
  }

  /** End the current pointer interaction: fire the hold release, the scrub
   *  end, and (for a swipe) restore the eased transform. Stroke machines
   *  self-guard, so the three teardown calls are unconditional. */
  #endPointerSession() {
    this.#clearHoldTimer();
    if (this.#holding) {
      this.#holding = false;
      this.#fireRelease(this.#gestureZone, "pointer");
    }
    this.#scrub.end();
    this.#swipe.end();
    this.#gestureFsActive = false;
    this.#streamClaimed = false;
    this.#suppressNextActivations();
  }

  #clearHoldTimer() {
    // Almost every pointermove reaches here with no hold timer armed; the
    // null check skips the cancel invocation on that hot path. The null
    // assignment stays unconditional so the field is reset.
    if (this.#holdTimer !== null) {
      this.#holdTimer();
    }
    this.#holdTimer = null;
  }

  /** Tear down two-pointer pinch tracking once fewer than two pointers remain. */
  #endPinch() {
    this.#pinchStartDistance = 0;
    this.#pinchFired = false;
    this.#pinchZone = null;
  }

  #beginPinchTracking() {
    this.#endPointerSession();
    this.#primaryPointerId = null;
    // Two pointers captured on one element is native pointer-events: both
    // streams retarget here in full until each ends (the recapture happens
    // below, at recognition time). Baseline comes from the pointerdown
    // lattice itself - both pointers' latest coords are already in #pointers,
    // so no settle timer is needed. #pinchZone non-null is the tracking flag.
    this.#pinchStartDistance = 0;
    this.#pinchFired = false;
    this.#pinchZone = this.#gestureZone || "screen";
    // The claim arms at recognition, not at the press (prevent-scope rule),
    // and BOTH pointers recapture onto the zone here: the at-press capture
    // died with the claim (it retargeted a plain tap's click off the pressed
    // node - the swallow this batch repairs), so pinch re-anchors what the
    // recapture law still needs - an SDK overlay's tap-time re-render must
    // not strand either stream in an implicit capture a pointercancel eats.
    this.#streamClaimed = true;
    for (const pointerId of this.#pointers.keys()) {
      this.#pointerOp("setPointerCapture", pointerId);
    }
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
    for (const forge of forgeRegistry.actives()) {
      if (this.#isActive(forge)) {
        candidates++;
        includesThis ||= forge === this;
      }
    }
    if (candidates === 1) {
      return includesThis;
    } else if (candidates > 1) {
      return forgeRegistry.isLast(this);
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
      this.#eventTarget.dispatchEvent(this.#channel.event(eventName, detail));
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
    // produced a click (no settle timer to expire it).
    this.#clearAwaitClick();
    // One rejection verdict per press, short-circuiting in the same order the
    // compound guard ran: the verdict string is the #pf-debug breadcrumb that
    // tells a device run WHY the recognizer never saw the press.
    let rejected = null;
    if (event.button !== 0) {
      rejected = "button";
    } else if (this.#eventTarget && isInsideShell(this.#eventTarget, event.target)) {
      rejected = "hud";
    } else if (this.#pointers.size === 0 && !this.#hitTestVideo(event)) {
      rejected = "rect";
    } else if (this.#sdkTargetInteractive(event)) {
      rejected = "sdk-target";
    }
    if (rejected) {
      logger.log("forge", `press rejected: ${rejected} (${event.pointerType})`);
      return;
    }
    forgeRegistry.makeLast(this);
    const existing = this.#pointers.get(event.pointerId);
    if (existing) {
      existing.x = event.clientX;
      existing.y = event.clientY;
    } else {
      this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (allowsAnyIntent()) {
      // Decision-only ownership, the prevent-scope rule: the engine adopts
      // the press (the up feeds the tap window) but claims NOTHING - a plain
      // tap's whole native sequence (pointer, compat mouse/touch, the UA
      // click) passes to the page untouched, so the SDK always receives the
      // real, trusted tap. A session that arms (scrub, swipe, hold, pinch)
      // claims the stream at its latch instead; only the ARMED claim gates
      // the zone-capture suppressors. Selection/scroll defaults stay CSS-
      // driven (user-select + touch-action above), and long-press menus are
      // the contextmenu suppression, not a touch-default kill.
      this.#pointerOwned = true;
      // The breadcrumb reports the fresh press's zone verdict: #gestureZone
      // only takes its value in the primary-anchor block below (kept down
      // there so a pinch second finger cannot overwrite the first finger's
      // zone), so reading the field here prints the previous press's reset
      // null - every `zone=null` in the field traces is this staleness, not
      // a zoneless press. The fs tail is the drag-gesture discriminator: the
      // fullscreen-only intents all sit behind the gate, so a fullscreen
      // press whose breadcrumb still says fs=off names the
      // fullscreen-without-fullscreenElement family (CSS full-window) in
      // one line.
      logger.log("forge", `press owned: ${event.pointerType}, zone=${this.#zoneForPoint(event)}, fs=${fs ? "on" : "off"}`);
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
      // Anchors + latches re-init per press (machines own their fields; the
      // swipe base snapshot deliberately persists - only a latch re-captures it).
      this.#scrub.reset(event.clientX, event.clientY, this.#startTime);
      this.#swipe.reset();
      this.#clearHoldTimer();

      this.#holdTimer = delay(() => {
        this.#holdTimer = null;
        if (this.#primaryPointerId !== null && !this.#video.paused && allowsIntent("hold")) {
          this.#holding = true;
          // The hold arms the claim here, not at the press (prevent-scope
          // rule): first 300ms of a still press stays native, then the
          // stream becomes ours for the release.
          this.#streamClaimed = true;
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
      if (this.#streamClaimed) {
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
      if (!this.#scrub.active && !this.#swipe.active) {
        // Intent gates are sampled live: toggling a setting mid-session
        // applies to the very next move.
        if (allowsIntent("scrub") && dx > SCROLL_START_PX && dx > dy * AXIS_DOMINANCE_RATIO) {
          this.#scrub.latch(x, y, event.timeStamp);
          // The latch claims the stream here, not at the press: the first
          // 15px stayed native (the SDK saw it), and from latch everything
          // pointer-shape is ours (capture retargets the rest of the stroke).
          this.#streamClaimed = true;
          this.#gestureFsActive = true;
          this.#pointerOp("setPointerCapture", this.#primaryPointerId);
          logger.log("forge", `scrub latch (dx=${dx}, dy=${dy})`);
          // event.timeStamp shares the timebase the per-move velocity filter
          // below already reads, so the whole move stream pays no clock read.
        } else if (allowsIntent("swipe") && dy > SCROLL_START_PX && dy > dx * AXIS_DOMINANCE_RATIO) {
          this.#swipe.latch(event.clientY > this.#startY ? "down" : "up");
          this.#streamClaimed = true;
          this.#gestureFsActive = true;
          this.#pointerOp("setPointerCapture", this.#primaryPointerId);
          logger.log("forge", `swipe latch (${this.#swipe.direction}, dy=${this.#swipe.direction === "down" ? "+" : "-"})`);
          this.#suppressNextActivations();
          event.stopImmediatePropagation();
          swipeStartDetail.zone = this.#gestureZone || "screen";
          swipeStartDetail.method = "pointer";
          swipeStartDetail.direction = this.#swipe.direction;
          this.#dispatch(GESTURE_EVENTS.swipeStart, swipeStartDetail);
        }
      }
      if (this.#scrub.active) {
        event.stopImmediatePropagation();
        this.#scrub.advance(event);
      }
      if (this.#swipe.active && this.#swipe.direction === "down") {
        event.stopImmediatePropagation();
        this.#swipe.drag(y - this.#startY);
      }
    }
  }

  #handlePointerUp(event) {
    const tracked = this.#pointers.has(event.pointerId);
    if (tracked && this.#streamClaimed) {
      event.stopImmediatePropagation();
    }
    this.#pointers.delete(event.pointerId);
    let ownedTap = false;
    if (this.#pointers.size === 0 && this.#pointerOwned) {
      // Session over. The click decision follows in #handleClickCapture; the
      // compat mouseup between pointerup and click belongs to the claimed
      // stream only (a plain tap's whole tail is native), so the hangover
      // latch arms for claimed sessions and the decision flag drops either
      // way - every press's ownership is fresh next time.
      const claimed = this.#streamClaimed;
      this.#pointerOwned = false;
      this.#streamClaimed = false;
      if (claimed) {
        this.#awaitClick = true;
      }
      ownedTap = true;
    }
    if (this.#pinchZone !== null && this.#pointers.size < 2) {
      this.#endPinch();
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

    if (this.#holding || this.#scrub.active || this.#swipe.active) {
      // A latched session ends through the same #endPointerSession teardown
      // the cancel/destroy paths use: it fires the release, the scrub-end,
      // and (for a swipe) restores the video transform and clears the stroke
      // state. The stroke's direction is captured first - the session end
      // clears it before the swipe event can read it - and the swipe event is
      // dispatched after restoration, which dispatchEvent (synchronous) makes
      // the semantically identical order to the old inline branch.
      event.stopImmediatePropagation();
      const wasSwiping = this.#swipe.active;
      const swipeDirection = this.#swipe.direction;
      this.#endPointerSession();
      if (wasSwiping) {
        swipeDetail.zone = this.#gestureZone || "screen";
        swipeDetail.method = "pointer";
        swipeDetail.direction = swipeDirection;
        swipeDetail.distance = distance;
        this.#dispatch(GESTURE_EVENTS.swipe, swipeDetail);
      }
    } else if (
      ownedTap &&
      elapsed < HOLD_TIMEOUT_MS &&
      this.#gestureZone !== null &&
      allowsIntent("dbltap")
    ) {
      if (this.#tap.tap(now) === "second") {
        this.#suppressNextActivations();
        dbltapDetail.zone = this.#gestureZone;
        dbltapDetail.method = "pointer";
        this.#dispatch(GESTURE_EVENTS.dbltap, dbltapDetail);
      }
    }
    // A plain tap has nothing owned to replay: by the prevent-scope rule its
    // native stream already carried the press to the page, and the click that
    // follows it passes through #handleClickCapture untouched.
    this.#primaryPointerId = null;
    this.#gestureZone = null;
  }

  #handlePointerCancel(event) {
    if (this.#pointers.has(event.pointerId) && this.#pointerOwned) {
      event.stopImmediatePropagation();
    }
    if (this.#pointers.has(event.pointerId)) {
      logger.log("forge", `pointercancel reclaimed pointer ${event.pointerId} (${event.pointerType ?? "?"})`);
    }
    this.#cancelTrackedPointer(event.pointerId);
  }

  /**
   * The browser reclaimed a captured pointer with no pointerup/pointercancel
   * (capture target removed, hit-test takeover). That press is over and no
   * click follows, so reclaim it through the same cancellation path.
   */
  #handleLostCapture(event) {
    if (this.#pointers.has(event.pointerId)) {
      logger.log("forge", `capture lost mid-session, reclaiming pointer ${event.pointerId}`);
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
    // The Space shield entry dies with the session; the machine's release
    // covers the hold + toggle decision (never toggles on lifecycle loss).
    this.#ownedKeyCodes.delete("Space");
    this.#space.release(false);
    for (const id of this.#pointers.keys()) {
      this.#cancelTrackedPointer(id);
    }
  }

  /** Reclaim one tracked pointer: shared by pointercancel and the touchcancel
   *  sweep below, so both paths run identical idempotent teardown. */
  #cancelTrackedPointer(pointerId) {
    this.#pointers.delete(pointerId);
    if (this.#pointers.size === 0) {
      // A cancelled press ends the stream; no click is coming, so drop any
      // await latch a prior pointerup left armed. The claim dies with the
      // pointers: an unconsumed claimant would otherwise suppress a later
      // plain tap's native stream forever.
      this.#pointerOwned = false;
      this.#streamClaimed = false;
      this.#clearAwaitClick();
    }
    if (this.#pinchZone !== null && this.#pointers.size < 2) {
      this.#endPinch();
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

  /** Whether the press target resolves an interactive SDK control (see
   *  SDK_CONTROLS_SELECTOR). The composed-path head is used so shadow-tree
   *  press spread still resolves; text targets satisfy closest by tree walk.
   *  Past the shape list, the affordance-cursor clause and the box gate
   *  decide role-less chrome (the clause docstring holds the reasoning). */
  #sdkTargetInteractive(event) {
    const head = event.composedPath ? event.composedPath()[0] : event.target;
    if (typeof head?.closest !== "function") {
      return false;
    }
    if (head.closest(SDK_CONTROLS_SELECTOR)) {
      return true;
    }
    // Role-less chrome: only elements OUTSIDE the gesture-surface family
    // (the video itself, or an ancestor wrapping it) may claim the cursor.
    // The box gate keeps full-cover affordance overlays (click-to-pause
    // layers styling pointer over the whole player) unclaimed by this
    // clause - their tap already passes natively (prevent-scope: nothing
    // owned claims it), so classifying them as controls would only
    // retarget the press ownership decision away from the player surface -
    // while small crisp UIs (menus, rails, slider thumbs, icon buttons)
    // are exempt outright.
    if (head.nodeType !== 1 || head === this.#video ||
        (head.contains?.(this.#video) ?? false)) {
      return false;
    }
    // The mousedown/touchstart dominance probes can precede any pointerdown,
    // so the video box may still be cold: fill it here exactly the way the
    // hit-test does (per-press truth, invalidated at the next pointerdown).
    const videoRect = this.#videoRect ??
      (this.#videoRect = this.#video.getBoundingClientRect());
    const box = head.getBoundingClientRect();
    if (box.width * box.height > videoRect.width * videoRect.height / 2) {
      return false;
    }
    const cursor = getComputedStyle(head).cursor;
    return cursor === "pointer" || cursor === "grab";
  }

  #clearAwaitClick() {
    this.#awaitClick = false;
  }

  /** The click hangover latch lives above (#awaitClick) - click capture only
   *  consumes it. */

  #handleClickCapture(event) {
    // Gesture hangover: the window is a deadline, consumed by time, so every
    // activation inside it stays invisible - a scrub/hold/pinch session's
    // trailing click, and an fs double-tap's second activation, both die here.
    // Everything else is native, full stop: a plain single click passes
    // through with zero interception (the prevent-scope rule - the SDK's only
    // real click is this one, trusted and unthrottled).
    this.#clearAwaitClick();
    if (clickTime() < this.#suppressClickUntil) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }

  #handleDblClickCapture(event) {
    // Gesture hangover window first (an fs double tap's dblclick dies here
    // like its clicks did).
    if (clickTime() < this.#suppressClickUntil) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    // The prevent-scope rule's second arm: the SDK's DOUBLE TAP is prevented
    // in fullscreen and only there - the UA dblclick carries every SDK's
    // fullscreen-toggle/zoom double-tap, which would race the skip gesture
    // (inline those intents are disarmed, so the SDK keeps its native double
    // taps). Shell chrome is native ground: panel text selection and control
    // dblclicks pass untouched.
    if (fs && !(this.#eventTarget && isInsideShell(this.#eventTarget, event.target))) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }

  #handleWheelCapture(event) {
    // The repetition arm is the cooldown below, full stop: WheelEvent carries
    // no momentum attribute on this platform (only the delta members), so a
    // former `!event.momentum` tail filter was an always-true WebKit relic -
    // Chromium's pinch momentum phase is not DOM-visible, and the cooldown is
    // what keeps the tail's repeated ctrl+wheel events from re-firing.
    if (fs && event.ctrlKey && allowsIntent("pinch")) {
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
        forgeRegistry.makeLast(this);
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
        this.#space.press();
        this.#ownedKeyCodes.add("Space");
      } else {
        // Not ours (text entry, foreign focus): a later keyup must not
        // toggle playback for a press the page owned.
        this.#space.foreign();
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
      forgeRegistry.makeLast(this);
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
    // Space session end: hold release / bare-tap toggle - the press decision
    // machine carries it.
    this.#space.release(true);
  }
}
