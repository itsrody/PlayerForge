import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");
const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");
const { subscribeFullscreen } = await import("../src/shared/shadow.js");
const { getSetting, setSetting } = await import("../src/shell/chrome/config.js");

async function makeShell() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  // Wire the shared fs gate to this environment BEFORE any shell/forge
  // subscribes, so subscriptions see the one shared transition source.
  initFsGate(dom);
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  // jsdom rejects foreign-realm AbortSignals in listener options.
  globalThis.AbortController = dom.window.AbortController;
  // inject.js builds a constructable stylesheet against the ambient realm;
  // provide a realm-local fake so the suite never depends on jsdom CSS support.
  globalThis.CSSStyleSheet = class {
    replaceSync() {}
  };
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    value: [], writable: true, configurable: true
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  const teardown = () => {
    setFullscreen(dom, null);
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  };

  return { dom, shell, container, video, teardown };
}

test("checkmark is false until an element goes fullscreen", async () => {
  const { shell, teardown } = await makeShell();
  assert.equal(shell.fullscreen, false);
  teardown();
});

test("entering fullscreen on our container flips the shared marker and checkmark", async () => {
  const { dom, shell, container, teardown } = await makeShell();
  const seen = [];
  subscribeFullscreen((active) => seen.push(active));
  setFullscreen(dom, container);
  assert.deepEqual(seen, [true], "shared fs gate flips open");
  assert.equal(shell.fullscreen, true, "shell checkmark reflects the shared marker");
  teardown();
});

test("any document fullscreen element marks this shell", async () => {
  const env = await makeShell();
  const { dom, shell, teardown } = env;

  const stranger = dom.window.document.createElement("section");
  dom.window.document.body.appendChild(stranger);
  setFullscreen(dom, stranger);

  assert.equal(shell.fullscreen, true, "shared gate tracks any fullscreen element");
  teardown();
});

test("exiting fullscreen flips the marker back closed", async () => {
  const { dom, shell, container, teardown } = await makeShell();

  const seen = [];
  subscribeFullscreen((active) => seen.push(active));
  setFullscreen(dom, container);
  setFullscreen(dom, null);

  assert.deepEqual(seen, [true, false], "shared fs gate opens then closes");
  assert.equal(shell.fullscreen, false);
  teardown();
});

test("subscribeFullscreen fires once per actual transition, deduping repeat events", async () => {
  const { dom, container, teardown } = await makeShell();
  const seen = [];
  subscribeFullscreen((active) => seen.push(active));

  setFullscreen(dom, container);
  setFullscreen(dom, container); // no state flip: same element, gated already
  setFullscreen(dom, container);
  setFullscreen(dom, null);
  setFullscreen(dom, null);

  assert.deepEqual(seen, [true, false], "only real flips notify subscribers");
  teardown();
});

test("a fullscreen subscription is torn down on its signal", async () => {
  const { dom, container, teardown } = await makeShell();

  const seen = [];
  const scope = new AbortController();
  subscribeFullscreen((active) => seen.push(active), scope.signal);
  scope.abort();
  setFullscreen(dom, container);

  assert.equal(seen.length, 0, "subscription removed on abort");
  teardown();
});

test("rejected fullscreen request surfaces a blocked hint", async () => {
  const { dom, shell, teardown } = await makeShell();

  dom.window.document.dispatchEvent(new dom.window.Event("fullscreenerror"));

  const toast = shell.shellDom.hudLayer.querySelector("pf-toast");
  assert.ok(toast, "toast surface exists");
  assert.equal(toast.classList.contains("pf-visible"), true);
  assert.match(toast.textContent, /Fullscreen blocked/);
  teardown();
});

test("rejected fullscreen while already fullscreen shows no hint", async () => {
  const { dom, shell, container, teardown } = await makeShell();

  setFullscreen(dom, container);
  dom.window.document.dispatchEvent(new dom.window.Event("fullscreenerror"));

  const toasts = shell.shellDom.hudLayer.querySelectorAll("pf-toast.pf-visible");
  assert.equal(toasts.length, 0, "no blocked hint while already fullscreen");
  teardown();
});

test("referenceBox in fullscreen is the physical screen (edge-to-edge bypass)", async () => {
  const { dom, shell, container, teardown } = await makeShell();
  globalThis.screen = { width: 1080, height: 2400 };
  // Post-bypass (viewport-fit=cover injection): the fullscreen iframe fills
  // the whole screen behind the cutout, so the reference is screen.* - no
  // env-based safe-rect narrowing applies inside the iframe.
  setFullscreen(dom, container);
  assert.deepEqual(shell.referenceBox, { width: 1080, height: 2400 });
  setFullscreen(dom, null);
  delete globalThis.screen;
  teardown();
});
