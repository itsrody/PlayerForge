import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { InputForge, EngineBroker } = await import("../src/shell/inputs/forge.js");
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
function collect(host, _win) {
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
  assert.equal(scrollAdds, 0, "no always-on document scroll listener is armed with the forge");
  controller.destroy();
});

test("inline double taps never dispatch outside fullscreen", () => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
    const controller = new InputForge(video, zone, host, new EngineBroker());
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

test("focus arbitration: a fresh multi-player page still has exactly one key owner", () => {
  const { dom, video, zone, host } = makeEnv();
  const video2 = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video2);
  video2.getBoundingClientRect = video.getBoundingClientRect;
  Object.defineProperty(video2, "readyState", { value: 4, configurable: true });
  const zone2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone2);
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);

  const broker = new EngineBroker();
  const controllerA = new InputForge(video, zone, host, broker);
  const controllerB = new InputForge(video2, zone2, host2, broker);
  const seenA = collect(host, dom.window);
  const seenB = collect(host2, dom.window);

  // Nothing has been touched, both players are loaded and paused. The old gate
  // answered "is this the last-touched engine?" here, which nothing had ever
  // set, so the keystroke reached NOBODY and stayed dead until a click. Exactly
  // one engine must own it, and with no stronger signal boot order breaks the
  // tie.
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length + seenB.length, 1, "exactly one owner, never none and never both");
  assert.equal(seenA.length, 1, "boot order breaks an otherwise total tie");

  // A touch moves ownership, and the previous owner must let it go entirely.
  zone2.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone2.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length, 1, "the untouched owner must not also claim");
  assert.equal(seenB.length, 1);
  controllerA.destroy();
  controllerB.destroy();
});

test("key arbitration: the playing player wins over an idle one when neither was touched", () => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const video2 = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video2);
  video2.getBoundingClientRect = video.getBoundingClientRect;
  Object.defineProperty(video2, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video2, "paused", { value: true, configurable: true });
  const zone2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone2);
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);

  // Boot the IDLE player first, so boot order alone would hand it the key and
  // only the playing rung can redirect ownership to the other one.
  const broker = new EngineBroker();
  const controllerB = new InputForge(video2, zone2, host2, broker);
  const controllerA = new InputForge(video, zone, host, broker);
  const seenA = collect(host, dom.window);
  const seenB = collect(host2, dom.window);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length, 1, "the in-motion player should answer");
  assert.equal(seenB.length, 0);
  controllerA.destroy();
  controllerB.destroy();
});

test("key arbitration: focus inside a player outranks a playing sibling", () => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const video2 = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video2);
  video2.getBoundingClientRect = video.getBoundingClientRect;
  Object.defineProperty(video2, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video2, "paused", { value: true, configurable: true });
  const zone2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone2);
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);
  // A non-interactive focus holder: a pf BUTTON would legitimately keep
  // arrows for itself, which is a different rule entirely.
  const focused = dom.window.document.createElement("div");
  focused.setAttribute("tabindex", "-1");
  host2.appendChild(focused);
  focused.focus();
  assert.equal(dom.window.document.activeElement, focused);

  const broker = new EngineBroker();
  const controllerA = new InputForge(video, zone, host, broker);
  const controllerB = new InputForge(video2, zone2, host2, broker);
  const seenA = collect(host, dom.window);
  const seenB = collect(host2, dom.window);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length, 0, "a playing sibling must not steal keys from focused chrome");
  assert.equal(seenB.length, 1);
  controllerA.destroy();
  controllerB.destroy();
});

test("key arbitration: destroying the owner hands keys to the survivor", () => {
  const { dom, video, zone, host } = makeEnv();
  const video2 = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video2);
  video2.getBoundingClientRect = video.getBoundingClientRect;
  Object.defineProperty(video2, "readyState", { value: 4, configurable: true });
  const zone2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone2);
  const host2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host2);

  const broker = new EngineBroker();
  const controllerA = new InputForge(video, zone, host, broker);
  const controllerB = new InputForge(video2, zone2, host2, broker);
  const seenA = collect(host, dom.window);
  const seenB = collect(host2, dom.window);

  controllerA.destroy();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenA.length, 0);
  assert.equal(seenB.length, 1, "the surviving player must pick the page up");
  controllerB.destroy();

  // With every engine gone the broker must leave no listener holding the page.
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(seenB.length, 1, "a torn-down broker must not claim anything");
});

test("an engine left over from another realm cannot claim this one's keys", () => {
  // A player that was never torn down still holds a loaded video, but it
  // belongs to a different document. The broker is realm-scoped, so it must not
  // arbitrate here - and it registered FIRST, so without the realm filter it
  // would win every keystroke on this page and starve the live player.
  const first = makeEnv();
  const broker = new EngineBroker();
  const stale = new InputForge(first.video, first.zone, first.host, broker);
  const staleSeen = collect(first.host, first.dom.window);

  const second = makeEnv();
  const video = second.video;
  const zone = second.zone;
  const host = second.host;
  const fresh = new InputForge(video, zone, host, broker);
  const freshSeen = collect(host, second.dom.window);

  second.dom.window.document.dispatchEvent(new second.dom.window.KeyboardEvent("keydown", {
    code: "ArrowRight", bubbles: true, cancelable: true
  }));
  assert.equal(freshSeen.length, 1, "the live realm's player must answer");
  assert.equal(staleSeen.length, 0, "a foreign-realm engine must never claim");

  fresh.destroy();
  stale.destroy();
});

test("N players share one document keydown/keyup listener pair", () => {
  const { dom, video, zone, host } = makeEnv();
  const added = [];
  const realAdd = dom.window.document.addEventListener.bind(dom.window.document);
  dom.window.document.addEventListener = (type, fn, opts) => {
    if (type === "keydown" || type === "keyup") {
      added.push({ type, opts });
    }
    return realAdd(type, fn, opts);
  };
  const broker = new EngineBroker();
  const engines = [new InputForge(video, zone, host, broker)];
  for (let i = 0; i < 3; i++) {
    const v = dom.window.document.createElement("video");
    dom.window.document.body.appendChild(v);
    v.getBoundingClientRect = video.getBoundingClientRect;
    Object.defineProperty(v, "readyState", { value: 4, configurable: true });
    const z = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(z);
    const h = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(h);
    engines.push(new InputForge(v, z, h, broker));
  }
  assert.equal(added.length, 2, "four players must still install exactly one keydown + one keyup");
  assert.ok(added.every((a) => a.opts.capture === true), "shared keys stay capture-phase");
  for (const engine of engines) {
    engine.destroy();
  }
});

test("trackpad ctrl+wheel pinches in fullscreen with a cooldown window", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
 * The shell owns gesture-eligible presses on the bare video surface; the
 * SDK sees deliberate passthroughs: single click/tap (replayed after the
 * dbltap window), hover, presses outside the gesture zone - and every
 * press that lands on one of its own controls, which stays native,
 * zero-latency and trusted no matter which intents are armed. */

/** SDK-side observer: bubble listeners at the same node the platform would
 *  bind to (the container/zone), registered after the forge like a real
 *  SDK's would be. */
function sdkObserver(zone, _win) {
  const seen = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointerover",
    "mousedown", "mousemove", "mouseup", "touchstart", "touchend", "click", "dblclick"]) {
    zone.addEventListener(type, (_event) => seen.push(type));
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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
  const controller = new InputForge(video, zone, host, new EngineBroker());
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

  const controller = new InputForge(video, zone, host, new EngineBroker());
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

  const controller = new InputForge(video, zone, host, new EngineBroker());
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

  const controller = new InputForge(video, zone, host, new EngineBroker());
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

  const controller = new InputForge(video, zone, host, new EngineBroker());
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

/** A scrub pointermove whose (fake) coalesced sample streams we control. */
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

/**
 * Drive one pointerdown plus two rightward scrub moves and report the second
 * move's scrub payload. `predicted` plants a getPredictedEvents() on the final
 * move the way a UA that actually implements prediction would, so the same
 * gesture can be run with and without the hint.
 */
function runScrub(predicted) {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);

  // pointerdown at x=100 latches the start; then two scrub moves to the right.
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 100, y: 200 }));
  // Move 1: confirmed 20px travel -> dx is exactly 20.
  zone.dispatchEvent(scrubMoveEvent(dom.window, {
    x: 120, y: 205, ts: 1000, coalesced: [{ clientX: 120, clientY: 205 }]
  }));
  // Move 2: confirmed +10px.
  zone.dispatchEvent(scrubMoveEvent(dom.window, {
    x: 130, y: 208, ts: 1050,
    coalesced: [{ clientX: 130, clientY: 208 }],
    predicted
  }));

  const scrubs = seen.filter((entry) => entry.type === GESTURE_EVENTS.scrub);
  const detail = { ...scrubs[1].detail };
  controller.destroy();
  dom.window.close();
  return detail;
}

test("scrub velocity comes from confirmed samples; a prediction hint changes nothing", () => {
  const confirmedOnly = runScrub(undefined);
  // dx is grounded in real samples (10px here), never in predicted travel.
  assert.equal(confirmedOnly.dx, 10, "dx stays pinned to confirmed motion");
  assert.ok(confirmedOnly.velocity > 0, "velocity is computed from the confirmed step");

  // Gecko exposes getPredictedEvents but never populates it (bug 1702175), so
  // the retired branch could only ever add an allocation, never a sample. If it
  // comes back, the hinted run's velocity rises above the confirmed-only value
  // and this fails; platform/capabilities.json holds the token retired.
  const hinted = runScrub([{ clientX: 139, clientY: 211 }]);
  assert.equal(hinted.dx, confirmedOnly.dx, "a prediction hint does not move the payload");
  assert.equal(
    hinted.velocity,
    confirmedOnly.velocity,
    "a prediction hint does not lift velocity"
  );
});

test("swipe-down drag promotes a compositor layer, released on restore", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());

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

test("swipe-down drag builds its transform from a prefix cached at latch", () => {
  // The per-move transform is the latched base joined to a translateY of the
  // live drag. The base cannot change mid-stroke, so it is joined once at the
  // latch rather than re-derived per move; these pin the resulting string, and
  // pin that it does not accumulate across moves (a per-move re-derivation
  // that appended to itself would stack translateY() terms).
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  assert.equal(video.style.transform, "translateY(60px)", "no base transform to prepend");

  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 280 }));
  assert.equal(video.style.transform, "translateY(80px)", "drag advances by the live delta");
  assert.equal(
    video.style.transform.match(/translateY\(/g).length,
    1,
    "the cached prefix is reused, not appended to"
  );

  controller.destroy();
  dom.window.close();
});

test("swipe-down drag prepends the latched base transform exactly once", () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  // A prior inline transform is the prefix the drag composes onto, and it is
  // what easeTransformTo restores on release.
  video.style.transform = "rotate(3deg)";
  const controller = new InputForge(video, zone, host, new EngineBroker());

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  assert.equal(
    video.style.transform,
    "rotate(3deg) translateY(60px)",
    "the latched base leads the drag transform"
  );

  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 280 }));
  assert.equal(
    video.style.transform.match(/rotate\(3deg\)/g).length,
    1,
    "the base appears once however many moves have run"
  );

  controller.destroy();
  dom.window.close();
});

test("a second swipe stroke rebuilds its prefix instead of reusing the last", () => {
  // The prefix is a cached-at-latch value, so the invariant that matters is
  // that it is rebuilt every stroke and not carried over. A first stroke
  // against a rotated base would otherwise leave that base glued onto the
  // second stroke's transform.
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  video.style.transform = "rotate(3deg)";
  const controller = new InputForge(video, zone, host, new EngineBroker());

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 405, y: 300 }));
  assert.match(video.style.transform, /rotate\(3deg\)/, "first stroke carries the base");

  // The restore eases back to the base, so the second stroke latches against
  // whatever the element actually holds now.
  video.style.transform = "";
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointermove", { x: 405, y: 260 }));
  assert.equal(
    video.style.transform,
    "translateY(60px)",
    "the previous stroke's prefix was rebuilt, not carried over"
  );

  controller.destroy();
  dom.window.close();
});

test("fill pinch owns object-fit: contain and restores it on clear", () => {
  const { dom, video, host } = makeEnv();
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

test("scrubEnd settles the exact latched target of the stroke", () => {
  // Per-move seeks may ride fastSeek (keyframe-imprecise feedback), so the
  // release must write the stroke's exact target - otherwise the resting
  // position sits wherever the nearest keyframe was.
  const { dom, video, host } = makeEnv();
  const latched = [];
  const settled = [];
  const shell = {
    video,
    duration: 120,
    currentTime: 40,
    referenceBox: { width: 800, height: 450 },
    media: {
      scrubToLatched: (t) => latched.push(t),
      scrubSettle: (t) => settled.push(t)
    },
    toast() {},
    hideToast() {}
  };
  const ac = new AbortController();
  attachInputActions(shell, host, ac.signal);

  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.scrub, {
    detail: { dx: 200, velocity: 2000 }
  }));
  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.scrub, {
    detail: { dx: 100, velocity: 1000 }
  }));
  assert.equal(latched.length, 2, "both moves rode the latched path");
  assert.equal(settled.length, 0, "no settle before the release");

  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.scrubEnd, { detail: {} }));
  assert.equal(settled.length, 1, "the release settles once");
  assert.equal(settled[0], latched.at(-1), "the settle lands exactly where the last move aimed");

  ac.abort();
  dom.window.close();
});

test("scrubEnd with no qualifying move settles nothing", () => {
  const { dom, video, host } = makeEnv();
  const settled = [];
  const shell = {
    video,
    duration: 0,
    currentTime: 40,
    referenceBox: { width: 800, height: 450 },
    media: {
      scrubToLatched: () => {},
      scrubSettle: (t) => settled.push(t)
    },
    toast() {},
    hideToast() {}
  };
  const ac = new AbortController();
  attachInputActions(shell, host, ac.signal);

  // No duration means the stroke never latches; a dead-zone-only stroke must
  // not settle a target it never had.
  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.scrub, {
    detail: { dx: 200, velocity: 2000 }
  }));
  host.dispatchEvent(new dom.window.CustomEvent(GESTURE_EVENTS.scrubEnd, { detail: {} }));
  assert.deepEqual(settled, [], "nothing latched, nothing settled");

  ac.abort();
  dom.window.close();
});


/* --- Controls belong to the SDK -------------------------------------- *
 * A press on an interactive element is never gesture-eligible: control
 * taps stay on the full native stream (trusted, zero latency) even with
 * every intent armed, in fullscreen, where a surface tap would be held
 * back for the dbltap window and replayed synthetic. */

test("a tap on an SDK control stays native with the dbltap intent armed", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true); // a surface tap here would be held for replay
  const controller = new InputForge(video, zone, host, new EngineBroker());
  t.after(() => controller.destroy());
  const seen = collect(host, dom.window);
  const sdk = sdkObserver(zone, dom.window);

  const control = dom.window.document.createElement("button");
  control.className = "sdk-play";
  zone.appendChild(control);
  control.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  control.dispatchEvent(mouse(dom.window, "mousedown", { x: 400, y: 200 }));
  control.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  control.dispatchEvent(mouse(dom.window, "mouseup", { x: 400, y: 200 }));
  control.dispatchEvent(mouse(dom.window, "click", { x: 400, y: 200 }));
  assert.deepEqual(sdk, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
    "a control tap passes immediately - no holdback, no replay seed");

  await sleep(350); // past the dbltap window: no synthetic second click
  assert.deepEqual(sdk, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
    "nothing is replayed for a press the shell never owned");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.dbltap).length, 0);
});

test("a touchstart on a control is not dominated", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host, new EngineBroker());
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);

  const control = dom.window.document.createElement("input");
  control.type = "range";
  zone.appendChild(control);
  control.dispatchEvent(touch(dom.window, "touchstart", { x: 400, y: 200 }));
  assert.ok(sdk.includes("touchstart"), "compat touch stream passes for controls");
});

test("touch-action escalates only for owned sessions", (t) => {
  const { dom, video, zone, host } = makeEnv();
  const controller = new InputForge(video, zone, host, new EngineBroker());
  t.after(() => controller.destroy());

  assert.equal(zone.style.touchAction, "pan-x pan-y",
    "idle: the SDK keeps panning/zooming for its own scrollable chrome");
  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  assert.equal(zone.style.touchAction, "none",
    "owned: the browser must not scroll/zoom from a gesture press");
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  assert.equal(zone.style.touchAction, "pan-x pan-y",
    "released: idle behavior back, no lifetime kill");
});

test("contextmenu passes when idle and dies mid-gesture", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  const controller = new InputForge(video, zone, host, new EngineBroker());
  t.after(() => controller.destroy());
  const sdk = sdkObserver(zone, dom.window);
  let menuSeen = 0;
  zone.addEventListener("contextmenu", () => menuSeen++);

  const menu = (win) => new win.Event("contextmenu", { bubbles: true, cancelable: true });
  const idle = menu(dom.window);
  zone.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false, "idle right-click belongs to the SDK");
  assert.equal(menuSeen, 1, "it reaches the SDK's menu");

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  await sleep(350); // hold fires: a gesture session is live
  const held = menu(dom.window);
  zone.dispatchEvent(held);
  assert.equal(held.defaultPrevented, true, "a menu mid-hold would spring from an owned press");
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
});

test("tap replay re-resolves a control the SDK re-rendered mid-window", async (t) => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  t.after(() => controller.destroy());

  // The SDK swaps its chrome while the first tap waits out the window.
  const fresh = dom.window.document.createElement("button");
  fresh.className = "sdk-play-v2";
  zone.appendChild(fresh);
  let freshClicks = 0;
  fresh.addEventListener("click", () => freshClicks++);
  dom.window.document.elementFromPoint = () => fresh;

  zone.dispatchEvent(pointerEvent(dom.window, "pointerdown", { x: 400, y: 200 }));
  zone.dispatchEvent(pointerEvent(dom.window, "pointerup", { x: 400, y: 200 }));
  zone.dispatchEvent(mouse(dom.window, "click", { x: 400, y: 200 }));
  await sleep(350);
  assert.equal(freshClicks, 1, "the replay follows the live node, not the detached one");
});

/* --- EngineBroker: one broker per document, no global arbitration state -- */

function fakeEngine(target, { playing = false, claim = true } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      target: () => target,
      isPlaying: () => playing,
      keydown: (event) => {
        calls.push(["keydown", event.code]);
        return claim;
      },
      keyup: (event) => {
        calls.push(["keyup", event.code]);
      },
      finishHold: () => {
        calls.push(["finish"]);
      }
    }
  };
}

const brokerKey = (win, type, code) =>
  new win.KeyboardEvent(type, { bubbles: true, cancelable: true, code });

test("a broker arbitrates its engines best-first", (t) => {
  const { dom } = makeEnv();
  const broker = new EngineBroker();
  t.after(() => {
    broker.unregister(idle.adapter);
    broker.unregister(active.adapter);
  });
  const idle = fakeEngine(dom.window.document.createElement("div"));
  const active = fakeEngine(dom.window.document.createElement("div"), { playing: true });
  broker.register(idle.adapter);
  broker.register(active.adapter);
  assert.equal(broker.size, 2);

  dom.window.document.dispatchEvent(brokerKey(dom.window, "keydown", "KeyM"));
  assert.deepEqual(active.calls, [["keydown", "KeyM"]], "the playing engine claims first");
  assert.deepEqual(idle.calls, [], "a claim ends arbitration - no weaker engine is visited");
});

test("an empty broker holds no document listeners", (t) => {
  const { dom } = makeEnv();
  const doc = dom.window.document;
  const view = doc.defaultView;
  let adds = 0;
  let removes = 0;
  const realDocAdd = doc.addEventListener.bind(doc);
  const realViewAdd = view.addEventListener.bind(view);
  doc.addEventListener = (type, fn, opts) => {
    if (type === "keydown" || type === "keyup") {
      adds++;
    }
    return realDocAdd(type, fn, opts);
  };
  view.addEventListener = (type, fn, opts) => {
    if (type === "blur") {
      adds++;
    }
    return realViewAdd(type, fn, opts);
  };
  // removeEventListener has no per-type hook need: aborts release by signal,
  // so balance is observed through re-registration instead (see below).
  const broker = new EngineBroker();
  assert.equal(broker.size, 0, "a fresh broker attaches nothing");
  assert.equal(adds, 0);

  const engine = fakeEngine(doc.createElement("div"));
  broker.register(engine.adapter);
  assert.equal(adds, 3, "first registration attaches the document pair plus blur");
  broker.unregister(engine.adapter);
  assert.equal(broker.size, 0);

  // Re-registration after a full teardown re-attaches exactly once: the
  // dispose-then-recreate cycle leaves no ghost scope behind.
  broker.register(engine.adapter);
  assert.equal(adds, 6, "re-attach after empty is exactly one more set");
  broker.unregister(engine.adapter);
  t.after(() => {
    doc.addEventListener = realDocAdd;
    view.addEventListener = realViewAdd;
  });
});

test("engines from another document never arbitrate", (t) => {
  const first = makeEnv();
  const broker = new EngineBroker();
  const stale = fakeEngine(first.dom.window.document.createElement("div"));
  broker.register(stale.adapter);

  // A new realm: the broker re-attaches to it, and the previous document's
  // engine is filtered instead of consulted.
  const second = makeEnv();
  const local = fakeEngine(second.dom.window.document.createElement("div"), { claim: false });
  broker.register(local.adapter);
  t.after(() => {
    broker.unregister(stale.adapter);
    broker.unregister(local.adapter);
  });
  second.dom.window.document.dispatchEvent(brokerKey(second.dom.window, "keydown", "KeyM"));
  assert.deepEqual(stale.calls, [], "the stale engine is filtered, not visited");
  assert.deepEqual(local.calls, [["keydown", "KeyM"]], "the local engine still arbitrates");
});

test("two brokers on one document route only their own engines", (t) => {
  // Sharing was ambient (one module-global registry); now it is explicit,
  // so two brokers on the same page must each serve exactly their engines.
  const { dom } = makeEnv();
  const first = new EngineBroker();
  const second = new EngineBroker();
  const engineA = fakeEngine(dom.window.document.createElement("div"));
  const engineB = fakeEngine(dom.window.document.createElement("div"));
  first.register(engineA.adapter);
  second.register(engineB.adapter);
  t.after(() => {
    first.unregister(engineA.adapter);
    second.unregister(engineB.adapter);
  });
  dom.window.document.dispatchEvent(brokerKey(dom.window, "keydown", "KeyM"));
  assert.deepEqual(engineA.calls, [["keydown", "KeyM"]], "broker one served its engine");
  assert.deepEqual(engineB.calls, [["keydown", "KeyM"]], "broker two served its engine");
  assert.equal(first.size, 1, "no engine leaked across brokers");
  assert.equal(second.size, 1);
});
