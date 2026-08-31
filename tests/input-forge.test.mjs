import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { InputForge } = await import("../src/shell/inputs/forge.js");
const { GESTURE_EVENTS, computeCoverScale, attachInputActions } = await import("../src/shell/inputs/actions.js");
const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEnv() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  // gestures.js builds its CustomEvents against the ambient global realm;
  // jsdom hosts reject foreign-realm event objects, so bridge the constructor.
  globalThis.CustomEvent = dom.window.CustomEvent;
  // jsdom rejects foreign-realm AbortSignals in listener options.
  globalThis.AbortController = dom.window.AbortController;
  // Wire the shared fs gate to this environment before the forge reads it.
  initFsGate(dom);

  const video = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video);
  video.getBoundingClientRect = () => ({
    left: 0, right: 800, top: 0, bottom: 450, width: 800, height: 450
  });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "paused", { value: true, configurable: true });

  const zone = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);

  return { dom, video, zone, host };
}

function pointerEvent(win, type, { id = 1, x = 0, y = 0 } = {}) {
  const event = new win.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
  });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}

/** Force fullscreen on through the real gate: set the marker + fire the event. */
function stubFullscreen(dom, value) {
  setFullscreen(dom, value);
}

function wheelEvent(win, { deltaY, ctrlKey }) {
  const event = new win.MouseEvent("wheel", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "ctrlKey", { value: ctrlKey });
  return event;
}

/** Collector for gesture CustomEvents fired on the host. */
function collect(host, win) {
  const seen = [];
  for (const name of Object.values(GESTURE_EVENTS)) {
    host.addEventListener(name, (event) => {
      seen.push({ type: event.type, detail: event.detail });
    });
  }
  return seen;
}

test("double tap in the left-edge zone dispatches once in fullscreen", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 50, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 50, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 52, y: 202 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 52, y: 202 }));

  const dbltaps = seen.filter((entry) => entry.type === GESTURE_EVENTS.dbltap);
  assert.equal(dbltaps.length, 1);
  assert.equal(dbltaps[0].detail.zone, "left-edge");
  controller.destroy();
});

test("inline double taps never dispatch outside fullscreen", () => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 50, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 50, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 52, y: 202 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 52, y: 202 }));

  assert.equal(seen.length, 0, "dbltap is fullscreen-only");
  controller.destroy();
});

test("keydown arrows map through the action table with preventDefault", () => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  const right = new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  });
  dom.window.document.dispatchEvent(right);
  assert.deepEqual(seen.at(-1), {
    type: GESTURE_EVENTS.skip,
    detail: { method: "keyboard", direction: "right" }
  });
  assert.equal(right.defaultPrevented, true);
  controller.destroy();
});

test("disabling the hotkeys toggle silences arrows but Space still toggles playback", async () => {
  const { setSetting } = await import("../src/shell/chrome/config.js");
  setSetting("gestures.hotkeys", false);
  try {
    const { dom, video, zone, host } = makeEnv();
    const playCalls = [];
    video.play = () => {
      playCalls.push(true);
      return Promise.resolve();
    };
    const controller = new InputForge(video, zone, host);
    const seen = collect(host, dom.window);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      code: "ArrowRight", bubbles: true, cancelable: true
    }));
    assert.equal(seen.length, 0, "arrow fired despite toggle off");

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      code: "Space", bubbles: true, cancelable: true
    }));
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keyup", {
      code: "Space", bubbles: true
    }));
    await flush();
    assert.equal(playCalls.length, 1, "Space bypassed the hotkeys toggle");
    controller.destroy();
  } finally {
    setSetting("gestures.hotkeys", true);
  }
});

test("focus arbitration: the last active controller owns page-level keys", () => {
  const { dom, video, zone, host } = makeEnv();
  const video2 = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video2);
  video2.getBoundingClientRect = video.getBoundingClientRect;
  Object.defineProperty(video2, "readyState", { value: 4, configurable: true });
  const zone2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone2);
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);

  const controllerA = new InputForge(video, zone, host);
  const controllerB = new InputForge(video2, zone2, host2);
  const seenA = collect(host, dom.window);
  const seenB = collect(host2, dom.window);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length + seenB.length, 0, "no owner chosen yet");

  zone2.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone2.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length, 0);
  assert.equal(seenB.length, 1);
  controllerA.destroy();
  controllerB.destroy();
});

test("trackpad ctrl+wheel pinches in fullscreen with a cooldown window", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  controller.setTrackpadPinchEnabled(true);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(wheelEvent(dom.window, { deltaY: -100, ctrlKey: true }));
  zone.dispatchEvent(wheelEvent(dom.window, { deltaY: -100, ctrlKey: true }));
  const pinches = seen.filter((entry) => entry.type === GESTURE_EVENTS.pinch);
  assert.equal(pinches.length, 1);
  assert.equal(pinches[0].detail.direction, "out");
  assert.equal(pinches[0].detail.method, "trackpad");

  const passive = new dom.window.MouseEvent("wheel", { bubbles: true, cancelable: true });
  zone.dispatchEvent(passive);
  assert.equal(passive.defaultPrevented, false, "plain wheel untouched");
  controller.destroy();
});

test("wheel pinch listener is inert until enabled and detaches on disable", () => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  const blocked = wheelEvent(dom.window, { deltaY: -100, ctrlKey: true });
  zone.dispatchEvent(blocked);
  assert.equal(seen.length, 0, "no pinch before the listener is scoped in");
  assert.equal(blocked.defaultPrevented, false, "nothing cancelled while detached");

  stubFullscreen(dom, true);
  controller.setTrackpadPinchEnabled(true);
  zone.dispatchEvent(wheelEvent(dom.window, { deltaY: -100, ctrlKey: true }));
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.pinch).length, 1);

  controller.setTrackpadPinchEnabled(false);
  const afterDetach = wheelEvent(dom.window, { deltaY: -100, ctrlKey: true });
  zone.dispatchEvent(afterDetach);
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.pinch).length, 1, "detached again");
  assert.equal(afterDetach.defaultPrevented, false, "nothing cancelled once detached");
  controller.destroy();
});

test("pointer gestures never cancel defaults (passivity contract)", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  collect(host, dom.window);

  const dispatched = [
    pointerEvent(dom.window, "pointerdown", { x: 50, y: 200 }),
    pointerEvent(dom.window, "pointermove", { x: 55, y: 260 }),
    pointerEvent(dom.window, "pointerup", { x: 55, y: 360 }),
    pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }),
    pointerEvent(dom.window, "pointercancel", { x: 402, y: 202 })
  ];
  for (const event of dispatched) {
    const notCancelled = zone.dispatchEvent(event);
    assert.equal(notCancelled, true, `${event.type} must not be default-cancelled`);
  }
  controller.destroy();
});

test("swipe down starts from any zone in fullscreen, not just the center", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 50, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 55, y: 240 }));
  const starts = seen.filter((entry) => entry.type === GESTURE_EVENTS.swipeStart);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].detail.zone, "left-edge");
  assert.equal(starts[0].detail.direction, "down");

  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 55, y: 360 }));
  const swipes = seen.filter((entry) => entry.type === GESTURE_EVENTS.swipe);
  assert.equal(swipes.length, 1);
  assert.ok(swipes[0].detail.distance > 100);
  controller.destroy();
});

test("destroying mid-hold fires the pending release before teardown", async () => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  await sleep(350);
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.hold).length, 1);

  controller.destroy();
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 1);
});

test("a focused native player button does not silence hotkeys", () => {
  const { dom, video, zone, host } = makeEnv();
  // Native SDK control-bar button inside the container - NOT pf chrome.
  const nativeButton = dom.window.document.createElement("button");
  nativeButton.textContent = "play";
  zone.appendChild(nativeButton);
  nativeButton.focus();

  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.skip).length, 1,
    "clicking a native control must not kill arrow hotkeys");
  controller.destroy();
});

test("pf-owned buttons still keep exclusive key ownership", async () => {
  const { SHELL_MARKER } = await import("../src/shell/chrome/inject.js");
  const { dom, video, zone, host } = makeEnv();
  host.setAttribute(SHELL_MARKER, "t");
  const stepperButton = dom.window.document.createElement("button");
  host.appendChild(stepperButton);
  stepperButton.focus();

  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seen.length, 0, "panel stepper arrows belong to the stepper");
  controller.destroy();
});

test("an SPA app-root div holding page focus arms hotkeys", () => {
  const { dom, video, zone, host } = makeEnv();
  // Sites commonly focus their app wrapper instead of body.
  const appRoot = dom.window.document.createElement("div");
  appRoot.setAttribute("tabindex", "-1");
  dom.window.document.body.appendChild(appRoot);
  appRoot.focus();
  assert.equal(dom.window.document.activeElement, appRoot);

  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.skip).length, 1,
    "page-level non-interactive focus must not block hotkeys");
  controller.destroy();
});

test("typing targets outside the container never trigger hotkeys", () => {
  const { dom, video, zone, host } = makeEnv();
  const searchBox = dom.window.document.createElement("input");
  searchBox.setAttribute("type", "text");
  dom.window.document.body.appendChild(searchBox);
  searchBox.focus();

  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);
  const keystroke = new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  });
  dom.window.document.dispatchEvent(keystroke);
  assert.equal(seen.length, 0, "text entry owns the keyboard");
  assert.equal(keystroke.defaultPrevented, false);
  controller.destroy();
});

test("computeCoverScale covers a reference box from aspect ratios alone", () => {
  const { dom, video } = makeEnv();
  // Landscape 16:9 screen, like a fullscreened display - the fs reference box.
  const ref = { width: 1920, height: 1080 };

  // 16:9 video on a 16:9 screen -> exactly fits, scale 1.
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  assert.ok(Math.abs(computeCoverScale(video, ref) - 1) < 1e-9);

  // 4:3 video on a 16:9 screen -> contain-fit = max(1920/1440, 1080/1080).
  Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
  assert.ok(Math.abs(computeCoverScale(video, ref) - 4 / 3) < 1e-9);

  dom.window.close();
});

/** A scrub pointermove whose (fake) Chromium sample streams we control. */
function scrubMoveEvent(win, { x, y, coalesced, predicted, ts }) {
  const event = pointerEvent(win, "pointermove", { x, y });
  Object.defineProperty(event, "timeStamp", { value: ts });
  if (coalesced) {
    Object.defineProperty(event, "getCoalescedEvents", { value: () => coalesced });
  }
  if (predicted) {
    Object.defineProperty(event, "getPredictedEvents", { value: () => predicted });
  }
  return event;
}

test("predicted pointer travel lifts scrub velocity but never the confirmed delta", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  // pointerdown at x=100 latches the start; then two scrub moves to the right.
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 100, y: 200 }));
  // Move 1: confirmed 20px travel, no prediction -> dx is exactly 20.
  zone.dispatchEvent(scrubMoveEvent(dom.window, {
    x: 120, y: 205, ts: 1000, coalesced: [{ clientX: 120, clientY: 205 }]
  }));
  // Move 2: confirmed +10px, predicted +9px further ahead (same sign, capped).
  zone.dispatchEvent(scrubMoveEvent(dom.window, {
    x: 130, y: 208, ts: 1050,
    coalesced: [{ clientX: 130, clientY: 208 }],
    predicted: [{ clientX: 139, clientY: 211 }]
  }));

  const scrubs = seen.filter((entry) => entry.type === GESTURE_EVENTS.scrub);
  // The confirmed dx payload is grounded in real samples (10px here, plus the
  // 20px from move 1 -> this event's dx is the 10px move).
  assert.equal(scrubs[1].detail.dx, 10, "dx stays pinned to confirmed motion");
  // The prediction only shapes velocity: a +9px prediction on a +10px step
  // must raise the velocity estimate above the confirmed-only value.
  const dtSec = 0.05;
  const confirmedOnlyVelocity = 10 / dtSec;
  assert.ok(
    scrubs[1].detail.velocity > confirmedOnlyVelocity,
    `prediction raised velocity (${scrubs[1].detail.velocity} > ${confirmedOnlyVelocity})`
  );
  controller.destroy();
  dom.window.close();
});

test("swipe-down drag promotes a compositor layer, released on restore", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  assert.equal(
    video.style.willChange, "transform",
    "layer promoted the moment a down-drag latches"
  );

  // Drag further, then release (no fullscreen exit distance).
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 280 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 405, y: 300 }));
  // The restore eases the video back (layer stays active during the ease); in
  // jsdom the WAAPI finish never runs, so the CSS-transition end releases it.
  assert.equal(
    video.style.willChange, "transform",
    "layer persists while the restore ease is in flight"
  );
  video.dispatchEvent(Object.assign(new dom.window.Event("transitionend", { bubbles: true }), {
    propertyName: "transform"
  }));
  assert.equal(
    video.style.willChange, "",
    "restore released the compositor layer once the ease settled"
  );
  controller.destroy();
  dom.window.close();
});

test("fill pinch owns object-fit: contain and restores it on clear", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  const shell = {
    video,
    sdk: { name: "test" },
    referenceBox: { width: 1080, height: 2400 },
    toast() {}
  };
  const ac = new AbortController();
  attachInputActions(shell, host, ac.signal);

  // Embed had no inline object-fit; the UA default is 'fill'. On fill entry
  // PlayerForge must normalize to 'contain' (computeCoverScale models that).
  assert.equal(video.style.objectFit, "", "embed object-fit untouched before fill");
  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.pinch, {
    detail: { direction: "out" }
  }));
  assert.equal(video.style.objectFit, "contain", "fill owns object-fit: contain");
  assert.match(video.style.transform, /scale\(/, "cover scale applied to the element");

  // Pinch-in clears fill and hands the embed's object-fit back.
  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.pinch, {
    detail: { direction: "in" }
  }));
  assert.equal(video.style.objectFit, "", "object-fit restored on clear");

  ac.abort();
  dom.window.close();
});

