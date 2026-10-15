import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/"
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
// jsdom WebIDL checks the signal's realm: PF's Scope mints its controller
// from the global AbortController, so it must be the JSDOM realm's own or
// every addEventListener with a scope signal throws (see panel-compact).
globalThis.AbortController = dom.window.AbortController;
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {}
});

const { SettingsPanel } = await import("../src/shell/chrome/panel.js");

function makePanel() {
  const hudLayer = document.createElement("div");
  document.body.append(hudLayer);
  const shellHost = document.createElement("div");
  document.body.append(shellHost);
  return new SettingsPanel({ shellDom: { hudLayer }, shellHost });
}

test("the dialog reports busy while sections build and clears after", async () => {
  const panel = makePanel();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  panel.setSectionBuilder(() => gate);
  const opening = panel.open();
  assert.equal(panel.element.getAttribute("aria-busy"), "true");
  release();
  await opening;
  assert.equal(panel.element.hasAttribute("aria-busy"), false);
});

test("a throwing builder still clears the busy flag", async () => {
  const panel = makePanel();
  panel.setSectionBuilder(async () => {
    throw new Error("section build failed");
  });
  await assert.rejects(panel.open(), /section build failed/);
  assert.equal(panel.element.hasAttribute("aria-busy"), false);
});
