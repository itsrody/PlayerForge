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
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.AbortController = dom.window.AbortController;
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

function stubFullscreen(dom, value) {
  setFullscreen(dom, value);
}

function collect(host, _win) {
  const seen = [];
  for (const name of Object.values(GESTURE_EVENTS)) {
    host.addEventListener(name, (event) => {
      seen.push({ type: event.type, detail: event.detail });
    });
  }
  return seen;
}

test("two-finger down/up fires pinch once and never a single-finger scrub", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);
  const down = (id, x, y) => pointerEvent(dom.window, "pointerdown", { id, x, y });
  const move = (id, x, y) => pointerEvent(dom.window, "pointermove", { id, x, y });
  const up = (id, x, y) => pointerEvent(dom.window, "pointerup", { id, x, y });

  // First finger latches a scrub intent on its own; the second joins before
  // it fires, and the pinch baseline resolves into a real spread.
  zone.dispatchEvent(down(1, 100, 200));
  zone.dispatchEvent(down(2, 200, 200));
  await new Promise((r) => setTimeout(r, 20));
  zone.dispatchEvent(move(2, 300, 200));
  zone.dispatchEvent(move(2, 400, 200));
  zone.dispatchEvent(up(2, 400, 200));
  zone.dispatchEvent(up(1, 100, 200));

  const pinches = seen.filter((e) => e.type === GESTURE_EVENTS.pinch);
  const scrubs = seen.filter((e) => e.type === GESTURE_EVENTS.scrub);
  assert.equal(pinches.length, 1, "exactly one pinch fires");
  assert.equal(pinches[0].detail.direction, "out", "spread -> out");
  assert.equal(scrubs.length, 0, "the single-finger scrub is abandoned the moment the second finger joins");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.scrubEnd).length, 0,
    "no stray scrubEnd from the abandoned scrub");
  controller.destroy();
});

test("a pinch that never spreads fires no pinch and no scrub", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);
  const down = (id, x, y) => pointerEvent(dom.window, "pointerdown", { id, x, y });
  const up = (id, x, y) => pointerEvent(dom.window, "pointerup", { id, x, y });

  zone.dispatchEvent(down(1, 100, 200));
  zone.dispatchEvent(down(2, 120, 200));
  await new Promise((r) => setTimeout(r, 20));
  zone.dispatchEvent(up(2, 120, 200));
  zone.dispatchEvent(up(1, 100, 200));

  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.pinch).length, 0,
    "below threshold: no pinch");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.scrub).length, 0,
    "the first finger never scrubbed alone");
  controller.destroy();
});

test("a second finger lifting mid-pinch fires no release", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);
  const down = (id, x, y) => pointerEvent(dom.window, "pointerdown", { id, x, y });
  const move = (id, x, y) => pointerEvent(dom.window, "pointermove", { id, x, y });
  const up = (id, x, y) => pointerEvent(dom.window, "pointerup", { id, x, y });

  zone.dispatchEvent(down(1, 100, 200));
  zone.dispatchEvent(down(2, 200, 200));
  await new Promise((r) => setTimeout(r, 20));
  zone.dispatchEvent(move(2, 300, 200));
  zone.dispatchEvent(up(2, 300, 200));
  zone.dispatchEvent(up(1, 100, 200));

  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.pinch).length, 1, "pinch already fired");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 0,
    "lifting a pinch finger is not a release - the primary session already ended");
  controller.destroy();
});

test("a cancelled second finger aborts pinch without a stray release", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);
  const down = (id, x, y) => pointerEvent(dom.window, "pointerdown", { id, x, y });
  const cancel = (id, x, y) => pointerEvent(dom.window, "pointercancel", { id, x, y });

  zone.dispatchEvent(down(1, 100, 200));
  zone.dispatchEvent(down(2, 200, 200));
  await new Promise((r) => setTimeout(r, 20));
  zone.dispatchEvent(cancel(2, 200, 200));
  zone.dispatchEvent(cancel(1, 100, 200));

  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.pinch).length, 0,
    "cancel before spread: no pinch");
  assert.equal(seen.filter((e) => e.type === GESTURE_EVENTS.release).length, 0,
    "cancel is not a release - no release event");
  controller.destroy();
});

test("a third finger joining a live pinch is ignored", async () => {
  const { dom, video, zone, host } = makeEnv();
  stubFullscreen(dom, true);
  const controller = new InputForge(video, zone, host, new EngineBroker());
  const seen = collect(host, dom.window);
  const down = (id, x, y) => pointerEvent(dom.window, "pointerdown", { id, x, y });
  const move = (id, x, y) => pointerEvent(dom.window, "pointermove", { id, x, y });
  const up = (id, x, y) => pointerEvent(dom.window, "pointerup", { id, x, y });

  // 20ms is shorter than the 2ms baseline delay + scheduler latency in
  // jsdom; give the baseline time to resolve before the spread.
  zone.dispatchEvent(down(1, 100, 200));
  zone.dispatchEvent(down(2, 200, 200));
  await new Promise((r) => setTimeout(r, 20));
  // A third finger only joins the map; it must not reset the baseline or
  // the spread measurement. Spread it via the second finger.
  zone.dispatchEvent(move(2, 400, 200));
  await new Promise((r) => setTimeout(r, 5));
  zone.dispatchEvent(down(3, 300, 200));
  zone.dispatchEvent(up(3, 300, 200));
  zone.dispatchEvent(up(2, 400, 200));
  zone.dispatchEvent(up(1, 100, 200));

  const pinches = seen.filter((e) => e.type === GESTURE_EVENTS.pinch);
  assert.equal(pinches.length, 1, "the third finger is ignored, pinch fires once");
  assert.equal(pinches[0].detail.direction, "out", "spread direction intact");
  controller.destroy();
});
