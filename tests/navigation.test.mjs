import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Node has no Navigation API - exactly the fallback realm we need to cover.
assert.equal(typeof globalThis.navigation, "undefined");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/start"
});
globalThis.window = dom.window;

const { onNavigate } = await import("../src/shared/navigation.js");

test("onNavigate falls back to popstate + hashchange and unsubscribes cleanly", () => {
  const seen = [];
  const off = onNavigate((event) => seen.push(event.type));
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  dom.window.dispatchEvent(new dom.window.Event("hashchange"));
  assert.deepEqual(seen, ["popstate", "hashchange"]);

  off();
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  assert.equal(seen.length, 2, "the unsubscribe detached both listeners");
});

test("onNavigate honors an abort signal as teardown", () => {
  const ac = new dom.window.AbortController();
  let calls = 0;
  onNavigate(() => { calls++; }, { signal: ac.signal });
  ac.abort();
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  assert.equal(calls, 0, "an aborted subscription never fires");
});

test("the Navigation API backend wins when the realm exposes it", () => {
  const listeners = [];
  const previous = globalThis.navigation;
  globalThis.navigation = {
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener() {}
  };
  try {
    const off = onNavigate(() => {});
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, "currententrychange");
    assert.equal(typeof off, "function");
    off();
  } finally {
    globalThis.navigation = previous;
  }
});

test("no navigation backend at all yields an inert unsubscribe", () => {
  const previous = globalThis.window;
  globalThis.window = undefined;
  try {
    const off = onNavigate(() => {
      throw new Error("an inert subscription must never fire");
    });
    assert.equal(typeof off, "function");
    off();
  } finally {
    globalThis.window = previous;
  }
});
