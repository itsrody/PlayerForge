import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/start"
});
globalThis.window = dom.window;

const { onNavigate } = await import("../src/shared/page.js");

// The harness Navigation API (tests/loader.mjs) emulates the platform
// surface: production's single-backend onNavigate subscribes to it exactly
// as it does a real Chromium `navigation` object, and events arrive as
// explicit `currententrychange` dispatches.

test("onNavigate subscribes to currententrychange and unsubscribes cleanly", () => {
  const seen = [];
  const off = onNavigate((event) => seen.push(event.type));
  globalThis.navigation.dispatchEvent({ type: "currententrychange" });
  globalThis.navigation.dispatchEvent({ type: "currententrychange" });
  assert.deepEqual(seen, ["currententrychange", "currententrychange"]);

  off();
  globalThis.navigation.dispatchEvent({ type: "currententrychange" });
  assert.equal(seen.length, 2, "the unsubscribe detached the listener");
});

test("onNavigate honors an abort signal as teardown", () => {
  const ac = new dom.window.AbortController();
  let calls = 0;
  onNavigate(() => { calls++; }, { signal: ac.signal });
  ac.abort();
  globalThis.navigation.dispatchEvent({ type: "currententrychange" });
  assert.equal(calls, 0, "an aborted subscription never fires");
});

test("window events are not a backend - only currententrychange fires", () => {
  let calls = 0;
  const off = onNavigate(() => calls++);
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  dom.window.dispatchEvent(new dom.window.Event("hashchange"));
  assert.equal(calls, 0, "popstate/hashchange never lie about a pushState-only route change");
  globalThis.navigation.dispatchEvent({ type: "currententrychange" });
  assert.equal(calls, 1);
  off();
});

test("realms with no Navigation API yield an inert unsubscribe", () => {
  const previous = globalThis.navigation;
  globalThis.navigation = undefined;
  try {
    const off = onNavigate(() => {
      throw new Error("an inert subscription must never fire");
    });
    assert.equal(typeof off, "function");
    off();
  } finally {
    globalThis.navigation = previous;
  }
});
