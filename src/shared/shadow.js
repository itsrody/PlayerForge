/**
 * Shadow DOM traversal helpers. PlayerForge injects its HUD into an open
 * shadow root for style encapsulation, but several DOM APIs
 * (`document.activeElement`, `contains()`, `closest()`) stop at shadow
 * boundaries. These three primitives bridge every gap.
 */

import { createActivity } from "./activity.js";
import { logger } from "./diagnostics.js";

/**
 * The deepest active element, piercing open shadow boundaries.
 * When `host` has a shadow root, the shadow tracks the real focused
 * element; otherwise falls back to `document.activeElement` (light DOM
 * or test environments like JSDOM).
 */
export function deepestActiveElement(host) {
  let el = host?.shadowRoot?.activeElement ?? document.activeElement;
  while (el?.shadowRoot) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

/**
 * True when `node` is a descendant of `host`'s shadow root
 * (or is the host itself). Falls back to light-DOM `contains()` when
 * no shadow root exists (e.g. JSDOM tests).
 */
export function isInsideShell(host, node) {
  return node === host || (host.shadowRoot?.contains(node) ?? host.contains(node));
}

/**
 * Generic interactive elements - the SDK's own controls, whatever player
 * they belong to. Buttons, links, form fields, editable text and anything
 * carrying an interactive ARIA role: no per-SDK selector list, because the
 * platform already labels these. The gesture engine consults this before
 * owning a press, and focus/contextmenu handling consults it before
 * stealing either: a press that lands on a control was meant for the SDK.
 */
const CONTROL_SELECTOR =
  "button, a[href], input, select, option, textarea, summary, " +
  "[contenteditable=\"\"], [contenteditable=\"true\"], " +
  "[role=\"button\"], [role=\"link\"], [role=\"menuitem\"], " +
  "[role=\"menuitemcheckbox\"], [role=\"menuitemradio\"], [role=\"tab\"], " +
  "[role=\"slider\"], [role=\"switch\"], [role=\"checkbox\"], [role=\"radio\"], " +
  "[role=\"option\"], [role=\"spinbutton\"]";

/** True when any element on the event's path is an SDK control. */
export function eventHitsControl(event) {
  if (typeof event?.composedPath === "function") {
    const path = event.composedPath();
    for (const node of path) {
      if (typeof node?.matches === "function" && node.matches(CONTROL_SELECTOR)) {
        return true;
      }
    }
    return false;
  }
  return !!event?.target?.closest?.(CONTROL_SELECTOR);
}

/**
 * SOL - the single fullscreen gate across PlayerForge. A boolean, not a DOM
 * reference: `true` means ALLOW every fs-gated feature, `false` means BLOCK
 * them. It is maintained exclusively by initFullscreenGate() off the native
 * `fullscreenchange` event, and every fs-conditioned path in the codebase
 * (gesture intents, input binding gates, shell state, pinch wiring) reads
 * this one boolean - nothing else touches fullscreen directly.
 *
 * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
 * fullscreen: latching `!!document.fullscreenElement` at the transition is the
 * single source of truth, regardless of which actor entered it. Module-level
 * so it represents document-wide truth and survives shell create/destroy.
 */
export let fs = false;

/** Subscribers notified on a fullscreen state transition (subscribed from a
 *  single underlying native listener; see initFullscreenGate). */
const fsSubscribers = new Set();

/**
 * The gate activity itself. Held so a re-init can retire the previous one
 * instead of stacking a second native listener behind it - two live gates
 * meant two fullscreenchange listeners and every transition fanned out twice.
 */
let fsGate = null;

/**
 * Fan out a transition to every subscriber.
 *
 * Snapshot first: subscribers are free to unsubscribe (or subscribe) from
 * inside the callback, which would otherwise mutate the Set mid-iteration and
 * skip the next subscriber. Isolate each one too - the dispatch runs from a
 * native event listener, so a throw would land in the page's error channel and
 * take out every later subscriber, including the HUD close and the gesture
 * unbind, rather than just the one that misbehaved.
 */
function notifyFullscreen(active) {
  for (const cb of [...fsSubscribers]) {
    try {
      cb(active);
    } catch (err) {
      logger.error("shadow", "Fullscreen subscriber threw during dispatch", err);
    }
  }
}

/**
 * Build the `fs` gate off the native fullscreen event and fan out transitions.
 * Call once at startup. `doc` is injectable for jsdom tests so they drive the
 * real mechanism.
 *
 * This is the ONLY place that touches fullscreen: it owns the `fs` value AND
 * the single underlying `fullscreenchange` listener. Every other fs-conditioned
 * path reads `fs` directly or subscribes to transitions via subscribeFullscreen,
 * so there is one gate and one transition source regardless of shell count.
 *
 * A fullscreen session is an activity, so the gate is one: Gecko's
 * `fullscreenElement` is the property, `fullscreenchange` is the edge, and
 * the fan-out is the enter/exit effect. During the window the gate changes
 * nothing else - there is no per-frame work to scope - which is why it reads
 * no work scope.
 *
 * Returns the activity handle so the caller owns its lifetime; a later init
 * retires the previous gate.
 */
export function initFullscreenGate(doc = document) {
  // Seed the derived value explicitly: the activity only runs effects on a
  // transition, so it will not re-assert an already-false `fs` on a later
  // document. This is the one place that reads `fs`'s initial value.
  fs = !!doc.fullscreenElement;
  fsGate?.dispose();
  fsGate = createActivity({
    target: doc,
    events: ["fullscreenchange"],
    isActive: () => !!doc.fullscreenElement,
    onEnter: () => {
      fs = true;
      notifyFullscreen(true);
    },
    onExit: () => {
      fs = false;
      notifyFullscreen(false);
    }
  });
  return fsGate;
}

/**
 * Subscribe to fullscreen state transitions (fires only on an actual flip,
 * before the gates' consumers observe the new `fs`). Returns an unsubscribe
 * function; pass `signal` to have it torn down automatically.
 */
export function subscribeFullscreen(cb, signal) {
  fsSubscribers.add(cb);
  if (signal) {
    // Same already-aborted trap as the status subscriber: the listener would
    // never fire, leaking the subscription past its owner's teardown.
    if (signal.aborted) {
      fsSubscribers.delete(cb);
      return () => {};
    }
    signal.addEventListener("abort", () => fsSubscribers.delete(cb), { once: true });
  }
  return () => fsSubscribers.delete(cb);
}
