import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = () => undefined;
globalThis.GM_setValue = () => {};
globalThis.GM_deleteValue = () => {};
if (typeof globalThis.GM_addValueChangeListener !== "function") {
  globalThis.GM_addValueChangeListener = () => 0;
}
if (typeof globalThis.GM_removeValueChangeListener !== "function") {
  globalThis.GM_removeValueChangeListener = () => {};
}

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.location = dom.window.location;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.AbortController = dom.window.AbortController;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { logger } = await import("../src/shared/logger.js");
logger.disable();

const { Kernel } = await import("../src/kernel/kernel.js");

function makeHarness() {
  const body = document.body;
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  body.appendChild(wrapper);
  // jsdom has no layout: force the admission gate's rect so the still-connected
  // player is size-qualified exactly like a rendered 640x360 element.
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  const created = [];
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video: v, container, sdk }) {
      return { video: v, container, sdk, ready: Promise.resolve(), destroy() {} };
    }
  });
  return { kernel, video, created };
}

test("kernel.init() adopts a video already present in the parsed DOM", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  const deadline = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("shell not created in time")), 2000);
    const poll = () => {
      if (created.length) {
        clearTimeout(t);
        resolve();
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
  await deadline;
  assert.equal(created.length, 1, "the pre-existing video got a shell without any media event");
  assert.equal(created[0].video, video);
  assert.equal(created[0].sdk.name, "JW Player");
});