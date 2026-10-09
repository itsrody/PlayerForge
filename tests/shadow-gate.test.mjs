import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://www.youtube.com/watch?v=1"
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom validates addEventListener's `signal` against its own AbortSignal.
globalThis.AbortController = dom.window.AbortController;

const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");
const { subscribeFullscreen } = await import("../src/shared/shadow.js");

initFsGate(dom);

test("subscribing with an already-aborted signal never fires", () => {
  // The abort listener would never fire, so the unguarded subscribe keeps
  // the callback (and its owner) subscribed past teardown - and the next
  // fullscreen flip notifies a dead owner. Refuse it the way the status
  // subscriber does.
  const ac = new dom.window.AbortController();
  ac.abort();
  const seen = [];
  const off = subscribeFullscreen(() => seen.push(1), ac.signal);
  assert.equal(typeof off, "function", "still returns an unsubscribe");

  setFullscreen(dom, dom.window.document.body);
  try {
    assert.deepEqual(seen, [], "no flip reaches a dead owner");
  } finally {
    setFullscreen(dom, null);
  }
  off();
});

test("a live subscription fires on flips and stops after unsubscribe", () => {
  const ac = new dom.window.AbortController();
  const seen = [];
  const off = subscribeFullscreen((active) => seen.push(active), ac.signal);
  setFullscreen(dom, dom.window.document.body);
  setFullscreen(dom, null);
  off();
  setFullscreen(dom, dom.window.document.body);
  setFullscreen(dom, null);
  assert.deepEqual(seen, [true, false], "flips arrive once each until unsubscribe");
});
