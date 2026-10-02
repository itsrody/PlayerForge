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

test("hit-test rect is not kept fresh by an always-on document scroll listener", () => {
  const { dom, video, zone, host } = makeEnv();
  const { document: doc } = dom.window;
  // The rect cache was historically invalidated by a capture-phase document
  // scroll listener that ran on every page scroll for the whole shell life.
  // It must not be registered anymore: freshness is per-tap instead.
  const realAdd = doc.addEventListener.bind(doc);
  let scrollAdds = 0;
  doc.addEventListener = (type, fn, opts) => {
    if (type === "scroll") {
      scrollAdds++;
    }
    return realAdd(type, fn, opts);
  };
  const controller = new InputForge(video, zone, host);
  assert.equal(scrollAdds, 0, "no always-on document scroll listener is armed with the forge");
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

test("same-name gestures dispatch repeatedly on the pooled event", () => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  // Two dispatches under ONE CustomEvent ctor exercise the pool's stale-hit
  // path: CustomEvent.detail is a prototype getter over an internal slot, so
  // the old plain assignment threw in strict mode and silently dropped every
  // gesture after the first per name (the per-test fresh jsdom ctor used to
  // mask it; the bench's stable ctor hit it thousands of times).
  for (let i = 0; i < 2; i++) {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      code: "ArrowRight", bubbles: true, cancelable: true
    }));
  }
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.skip).length, 2,
    "second same-name dispatch reuses the pooled event with detail intact");
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

  // Fullscreen plain wheel: the chain into the (invisible) document is
  // stopped - except over the panel, whose scroller keeps its wheel.
  const plain = wheelEvent(dom.window, { deltaY: -100, ctrlKey: false });
  zone.dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, true, "fullscreen plain wheel stops document scroll chaining");

  const panel = dom.window.document.createElement("div");
  panel.className = "pf-panel";
  zone.appendChild(panel);
  const overPanel = wheelEvent(dom.window, { deltaY: -100, ctrlKey: false });
  panel.dispatchEvent(overPanel);
  assert.equal(overPanel.defaultPrevented, false, "wheel over the panel still scrolls");
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

test("pointercancel cancels a swipe without committing it or arming a dbltap", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.swipeStart).length, 1);
  zone.dispatchEvent(pointerEvent(dom.window, "pointercancel", { x: 405, y: 260 }));

  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.swipe).length, 0,
    "a cancelled pointer never commits a swipe");
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 0);

  // A cancelled pointer must not have seeded the double-tap window: the first
  // real tap arms it, the second fires exactly one dbltap.
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 402, y: 202 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 402, y: 202 }));

  const dbltaps = seen.filter((entry) => entry.type === GESTURE_EVENTS.dbltap);
  assert.equal(dbltaps.length, 1, "cancel does not consume the first genuine tap");
  controller.destroy();
});

test("pointercancel mid-hold still releases playback rate", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  await sleep(350);
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.hold).length, 1);

  zone.dispatchEvent(pointerEvent(dom.window, "pointercancel", { x: 400, y: 200 }));
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 1,
    "a cancelled hold still restores the boosted rate");
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

/** Dispatch a Space keystroke on the document, like the host page would. */
const space = (win, type) =>
  win.document.dispatchEvent(new win.KeyboardEvent(type, { code: "Space", bubbles: true, cancelable: true }));

test("space hold boosts after the hold timeout and releases exactly once on keyup", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  // t.after: an assertion failure must not leak this forge into the shared
  // activeForges set and cascade into unrelated keyboard tests.
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  space(dom.window, "keydown");
  await sleep(350);
  const holds = seen.filter((entry) => entry.type === GESTURE_EVENTS.hold);
  assert.equal(holds.length, 1, "hold fires once while Space is held");
  assert.equal(holds[0].detail.method, "keyboard");

  space(dom.window, "keyup");
  const releases = seen.filter((entry) => entry.type === GESTURE_EVENTS.release);
  assert.equal(releases.length, 1, "keyup releases exactly once");
  assert.equal(releases[0].detail.method, "keyboard");
  controller.destroy();
});

test("an orphaned space hold (lost keyup) heals on the next space press", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  space(dom.window, "keydown");
  await sleep(350);
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.hold).length, 1);
  // The keyup never reaches the document (focus slid into an iframe): the
  // boost stays latched and #keyboardHolding stays true until the press is
  // settled - the next keydown must release the orphan before re-arming.
  space(dom.window, "keydown");
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 1,
    "the orphaned hold is released by the next press");

  await sleep(350);
  space(dom.window, "keyup");
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.hold).length, 2,
    "the second press still holds");
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 2,
    "holds and releases stay balanced across the orphan");
  controller.destroy();
});

test("destroying mid space-hold fires the release before teardown", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  space(dom.window, "keydown");
  await sleep(350);
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.hold).length, 1);

  controller.destroy();
  assert.equal(seen.filter((entry) => entry.type === GESTURE_EVENTS.release).length, 1,
    "teardown mid-hold must not leave playback stuck at boost speed");
});

test("an owned space press is invisible to page-level key handlers", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  let pageSaw = 0;
  // A page shortcut (the platform's own Space toggle) listening on the
  // bubble side must not run for a press PlayerForge owns - a mid-press
  // pause from the page starves the hold timer.
  dom.window.addEventListener("keydown", (event) => {
    if (event.code === "Space") pageSaw++;
  });

  space(dom.window, "keydown");
  assert.equal(pageSaw, 0, "stopImmediatePropagation must shield page handlers");
  space(dom.window, "keyup");
  controller.destroy();
});

test("auto-repeats of an owned press stay shielded; unowned repeats keep leaking", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const pageSaw = [];
  dom.window.addEventListener("keydown", (event) => {
    pageSaw.push({ code: event.code, repeat: event.repeat });
  });
  const down = (repeat) =>
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      code: "Space", bubbles: true, cancelable: true, repeat
    }));

  // Owned press: the first keydown AND every auto-repeat must be invisible -
  // the page's own Space shortcut must not fire at repeat rate mid-hold.
  down(false);
  down(true);
  down(true);
  assert.equal(pageSaw.length, 0, "owned press + repeats shielded from page handlers");

  // keyup releases the shield latch; the next press starts in a text field,
  // so the page owns it - both the press and its repeat must reach the page.
  space(dom.window, "keyup");
  const box = dom.window.document.createElement("textarea");
  dom.window.document.body.appendChild(box);
  box.focus();
  down(false);
  down(true);
  assert.equal(pageSaw.length, 2, "unowned press and its repeat reach the page");
  assert.equal(pageSaw[1].repeat, true);
  box.blur();
  controller.destroy();
});

test("a space press that started in a text field never toggles playback on keyup", (t) => {
  const { dom, video, zone, host } = makeEnv();
  let plays = 0;
  let pauses = 0;
  video.play = () => {
    plays++;
    return Promise.resolve();
  };
  video.pause = () => {
    pauses++;
  };
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  collect(host, dom.window);

  const box = dom.window.document.createElement("textarea");
  dom.window.document.body.appendChild(box);
  box.focus();
  space(dom.window, "keydown");
  box.blur(); // focus leaves the text field before keyup arrives
  space(dom.window, "keyup");
  assert.equal(plays, 0, "keyup must not toggle a press the keydown never owned");
  assert.equal(pauses, 0);
  controller.destroy();
});

/* --- SDK dominance contract ------------------------------------------- *
 * The shell owns every stream a gesture can activate; the SDK sees only
 * deliberate passthroughs: single click/tap (replayed after the dbltap
 * window), hover, and presses outside the gesture zone. */

/** SDK-side observer: bubble listeners at the same node the platform would
 *  bind to (the container/zone), registered after the forge like a real
 *  SDK's would be. */
function sdkObserver(zone, win) {
  const seen = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointerover",
    "mousedown", "mousemove", "mouseup", "touchstart", "touchend", "click", "dblclick"]) {
    zone.addEventListener(type, (event) => seen.push(type));
  }
  return seen;
}

const mouse = (win, type, { x = 0, y = 0 } = {}) =>
  new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

const touch = (win, type, { x = 0, y = 0 } = {}) => {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }]
  });
  return event;
};

test("an owned hold press is completely invisible to the SDK", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);
  const sdk = sdkObserver(zone, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "mousedown", { x: 400, y: 200 }));
  zone.dispatchEvent(touch(dom.window, "touchstart", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 410, y: 200 }));
  await sleep(350); // hold fires
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 410, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "mouseup", { x: 410, y: 200 }));
  zone.dispatchEvent(touch(dom.window, "touchend", { x: 410, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "click", { x: 410, y: 200 }));

  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.hold).length, 1);
  assert.deepEqual(sdk, [],
    "the SDK must not observe any pointer/mouse/touch/click event of an owned gesture press");
});

test("a plain single tap reaches the SDK as one click after the dbltap window", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true); // the dbltap intent is fullscreen-gated
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);
  const sdk = sdkObserver(zone, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "mousedown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "mouseup", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "click", { x: 400, y: 200 }));
  assert.deepEqual(sdk, [], "the raw press stays held back while a dbltap may still form");

  await sleep(350); // dbltap window closes untouched
  assert.equal(sdk.length, 1, "exactly one passthrough event");
  assert.equal(sdk[0], "click", "the SDK's single click is replayed, nothing else");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.dbltap).length, 0);
});

test("a double tap leaves the SDK with no click at all", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true); // the dbltap intent is fullscreen-gated
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);
  const sdk = sdkObserver(zone, dom.window);

  for (const x of [400, 404]) {
    zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x, y: 200 }));
    zone.dispatchEvent(mouse(dom.window, "mousedown", { x, y: 200 }));
    zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x, y: 200 }));
    zone.dispatchEvent(mouse(dom.window, "mouseup", { x, y: 200 }));
    zone.dispatchEvent(mouse(dom.window, "click", { x, y: 200 }));
  }
  zone.dispatchEvent(mouse(dom.window, "dblclick", { x: 404, y: 200 }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.dbltap).length, 1);

  await sleep(350);
  assert.deepEqual(sdk, [], "neither tap nor the dblclick may reach the SDK");
});

test("hover passes through the forge untouched", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "mousemove", { x: 400, y: 200 }));
  zone.dispatchEvent(new dom.window.MouseEvent("pointerover", { bubbles: true, clientX: 400, clientY: 200 }));
  assert.deepEqual(sdk, ["pointermove", "mousemove", "pointerover"],
    "hover input must never be mistaken for a gesture stream");
});

test("a press outside the gesture zone passes natively, immediately", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 900, y: 500 }));
  zone.dispatchEvent(mouse(dom.window, "mousedown", { x: 900, y: 500 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 900, y: 500 }));
  zone.dispatchEvent(mouse(dom.window, "mouseup", { x: 900, y: 500 }));
  zone.dispatchEvent(mouse(dom.window, "click", { x: 900, y: 500 }));
  assert.deepEqual(sdk, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
    "outside the video rect the zone is transparent - full native stream");
});

test("with every pointer gesture disabled the shell stops dominating", async (t) => {
  const { setSetting } = await import("../src/shell/chrome/config.js");
  const keys = ["gestures.scrub", "gestures.swipe", "gestures.hold", "gestures.dbltap", "gestures.pinch"];
  for (const key of keys) setSetting(key, false);
  t.after(() => {
    for (const key of keys) setSetting(key, true);
  });
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true); // all gestures would be armed here - settings win
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "click", { x: 400, y: 200 }));
  assert.deepEqual(sdk, ["pointerdown", "pointerup", "click"],
    "gestures off = zero interception, click passes with no debounce");
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
    toast() {},
    toastFlash() {}
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

test("fill re-derives the cover scale when the video's intrinsic size changes", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true, writable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true, writable: true });
  const shell = {
    video,
    sdk: { name: "test" },
    referenceBox: { width: 1080, height: 2400 },
    toast() {},
    toastFlash() {}
  };
  const ac = new AbortController();
  attachInputActions(shell, host, ac.signal);

  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.pinch, {
    detail: { direction: "out" }
  }));
  const first = video.style.transform;
  assert.match(first, /scale\(3\.9/, "landscape source scaled to cover the portrait screen");

  // Adaptive stream switch: the intrinsic ratio flips to portrait while fill
  // is active. The native `resize` event on the element signals the change;
  // the frozen cover scale must be re-derived instead of letterboxing.
  video.videoWidth = 1080;
  video.videoHeight = 1920;
  video.dispatchEvent(new dom.window.Event("resize"));
  assert.notEqual(video.style.transform, first, "cover scale re-derived on intrinsic-size change");
  assert.match(video.style.transform, /scale\(1\.25/, "portrait source no longer overflows");

  ac.abort();
  dom.window.close();
});

/* --- Event-driven session lifecycles ---------------------------------- *
 * The await-click latch and the pinch baseline used to be short timers.
 * They are now driven by real events (click, next pointerdown, second
 * pointerdown) plus native session-interruption signals (blur,
 * visibilitychange, lostpointercapture). */

test("a two-finger pointer pinch captures its baseline at pointerdown", (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { id: 1, x: 100, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { id: 2, x: 200, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { id: 2, x: 300, y: 200 }));

  const pinches = seen.filter((e) => e.type === GESTURE_EVENTS.pinch);
  assert.equal(pinches.length, 1, "pinch fires from the pointerdown baseline");
  assert.equal(pinches[0].detail.direction, "out");
  assert.equal(pinches[0].detail.method, "pointer");
});

test("a new press clears the stale await latch from a clickless drag", (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);

  // An owned tap whose click the UA swallowed: pointerup latches #awaitClick
  // with no timer to expire it.
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));

  // A later press outside the video rect must not have its compat mouseup
  // eaten by the stale latch: the pointerdown clears it.
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 900, y: 500 }));
  zone.dispatchEvent(mouse(dom.window, "mouseup", { x: 900, y: 500 }));
  assert.ok(sdk.includes("mouseup"), "the new press cleared the stale latch");
});

test("a window blur ends a live space hold without double-releasing", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  space(dom.window, "keydown");
  await sleep(350);
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.hold).length, 1);

  dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "blur releases the boosted hold");

  space(dom.window, "keyup");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "the late keyup does not double-release");
});

test("hiding the tab ends a live pointer hold without double-releasing", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  await sleep(350);
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.hold).length, 1);

  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "hidden", configurable: true
  });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "a hidden tab releases the boosted hold");

  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "the swallowed pointerup does not double-release");
});

test("a lost pointer capture reclaims an owned press", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host);
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  await sleep(350);
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.hold).length, 1,
    "capture is set while the hold boosts");

  zone.dispatchEvent(pointerEvent(dom.window, "lostpointercapture", { x: 400, y: 200 }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "lost capture ends the press through the cancellation path");

  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 1,
    "the press is already reclaimed, so no double-release");
});

