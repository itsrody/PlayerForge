import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://www.youtube.com/watch?v=1" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { DOMManager } = await import("../src/shared/dom-manager.js");

/** Wrap addEventListener so listener registrations expose their options. */
function spy(target) {
  const registrations = [];
  const original = target.addEventListener.bind(target);
  target.addEventListener = (event, handler, options) => {
    registrations.push({ event, handler, options });
    original(event, handler, options);
  };
  return registrations;
}

test("listen() spawns passive by default", () => {
  const manager = new DOMManager();
  const host = document.createElement("div");
  const registrations = spy(host);
  const noop = () => {};
  manager.listen(host, "foobar", noop);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.passive, true, "no options means passive");

  const capture = () => {};
  manager.listen(host, "captured", capture, { capture: true });
  assert.equal(registrations[1].options.passive, true, "capture does not imply cancellation");
  assert.equal(registrations[1].options.capture, true, "capture preserved");

  manager.destroy();
});

test("listen() honors explicit passivity intent", () => {
  const manager = new DOMManager();
  const host = document.createElement("div");
  const registrations = spy(host);

  manager.listen(host, "cancel", () => {}, { passive: false });
  assert.equal(registrations[0].options.passive, false, "explicit opt-out survives");
  assert.equal(registrations[0].options.capture, undefined, "no capture invented");

  manager.listen(host, "plain", () => {}, { passive: true });
  assert.equal(registrations[1].options.passive, true, "explicit passive stays");

  manager.destroy();
});

test("listen() forwards a plain { signal } object with passive appended and a bare AbortSignal untouched", () => {
  const manager = new DOMManager();
  const host = document.createElement("div");
  const registrations = spy(host);

  const ac = new dom.window.AbortController();
  manager.listen(host, "sig", () => {}, { signal: ac.signal });
  assert.equal(registrations[0].options.signal, ac.signal, "signal forwarded");
  assert.equal(registrations[0].options.passive, true, "plain signal object gets passive");

  const bare = new dom.window.AbortController();
  manager.listen(host, "bare", () => {}, bare.signal);
  assert.equal(registrations[1].options.passive, undefined, "bare AbortSignal is not re-wrapped");

  manager.destroy();
});

test("destroy() removes with the exact same options that were registered", () => {
  const manager = new DOMManager();
  const host = document.createElement("div");
  const removed = [];
  const originalRemove = host.removeEventListener;
  host.removeEventListener = (event, handler, options) => {
    removed.push({ event, handler, options });
    originalRemove.call(host, event, handler, options);
  };

  const handler = () => {};
  manager.listen(host, "ping", handler);
  manager.listen(host, "menu", () => {}, { passive: false });
  manager.destroy();

  assert.equal(removed.length, 2);
  assert.equal(removed[0].options.passive, true, "passive-default removed with its own options");
  assert.equal(removed[1].options.passive, false, "opt-out removed with its own options");
});