import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { injectShell } = await import("../src/shell/chrome/inject.js");

function makeEnv() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1",
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    writable: true,
    configurable: true,
  });
  globalThis.CSSStyleSheet = class {
    replaceSync() {}
  };
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    value: [],
    writable: true,
    configurable: true,
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  return { dom, container };
}

function injectWithCpuTier(tier) {
  const { dom, container } = makeEnv();
  globalThis.navigator.cpuPerformance = tier;
  const { host } = injectShell(container);
  return { dom, host };
}

test("CPU Performance API tier fences low/high device fidelity (non-medium only)", () => {
  for (const [tier, expected] of [
    [1, "low"],
    [3, "high"],
    [4, "high"],
  ]) {
    const { host } = injectWithCpuTier(tier);
    assert.equal(host.getAttribute("data-pf-cpu-tier"), expected, `tier ${tier}`);
  }
});

test("CPU mid/unknown/absent hosts stay unfenced (medium default)", () => {
  for (const tier of [0, 2, undefined]) {
    const { host } = injectWithCpuTier(tier);
    assert.equal(host.hasAttribute("data-pf-cpu-tier"), false, `tier ${tier}`);
  }
});