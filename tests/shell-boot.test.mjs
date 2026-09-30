import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_deleteValue = () => {};
if (typeof globalThis.GM_addValueChangeListener !== "function") {
  globalThis.GM_addValueChangeListener = () => 0;
}
if (typeof globalThis.GM_removeValueChangeListener !== "function") {
  globalThis.GM_removeValueChangeListener = () => {};
}

const { Shell } = await import("../src/shell/shell.js");
const { SHELL_MARKER } = await import("../src/kernel/contract.js");
const { initFsGate } = await import("./fs-gate.mjs");

function makeRealm() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
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
    value: [],
    writable: true,
    configurable: true
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);
  return { dom, container, video };
}

// A throw inside #boot AFTER the markers are set used to strand a half-live
// shell: the video kept data-pf-shell, the kernel's #adoptVideo refused it for
// the life of the document, and the HUD stayed in the container. The boot
// rollback is what makes the video adoptable again.
test("a boot that throws after injection rolls the shell DOM back", async () => {
  const { container, video } = makeRealm();
  const native = globalThis.getComputedStyle;
  // Delegate until the video is marked - i.e. until #markManaged has run - then
  // fail. getComputedStyle is the first call after the markers go on, so this
  // is a real post-marking throw and not a pre-injection one.
  globalThis.getComputedStyle = (el) => {
    if (video.hasAttribute(SHELL_MARKER)) {
      throw new Error("late boot failure");
    }
    return native(el);
  };

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await assert.rejects(shell.ready, /late boot failure/);

  assert.equal(video.hasAttribute(SHELL_MARKER), false, "the video gave up its shell claim");
  assert.equal(container.hasAttribute(SHELL_MARKER), false, "the container gave up its shell claim");
  assert.equal(container.querySelector(".pf-shell"), null, "the injected host was removed");
  delete globalThis.CSSStyleSheet;
});

test("destroy() stays idempotent after a failed boot rolled back", async () => {
  const { container, video } = makeRealm();
  const native = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (el) => {
    if (video.hasAttribute(SHELL_MARKER)) {
      throw new Error("late boot failure");
    }
    return native(el);
  };

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await assert.rejects(shell.ready, /late boot failure/);
  // The kernel's removal watcher (and any caller holding a reference) will
  // still call destroy(); a second teardown must not throw on the nulled
  // sub-components.
  shell.destroy();
  delete globalThis.CSSStyleSheet;
});
