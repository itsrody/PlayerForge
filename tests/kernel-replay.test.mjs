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
const { FRAMEWORK_TUNING } = await import("../src/kernel/contract.js");

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

async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("removal watch reanchors after a parent swap and still detects removal", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  // This kernel adopts every video in the document (the previous test's is
  // still mounted), so wait for OUR shell specifically.
  await waitFor(() => created.some((shell) => shell.video === video));
  const shell = created.find((entry) => entry.video === video);
  let destroyed = false;
  shell.destroy = () => { destroyed = true; };

  // Reparent the VIDEO itself: its anchor chain goes stale, so the removal
  // observer must disconnect and re-observe from the new roots. (MutationObserver
  // has no unobserve(): the old loop called a method that does not exist, threw
  // inside the callback, and stranded the anchors on the original parents.)
  const swap = document.createElement("div");
  document.body.appendChild(swap);
  swap.appendChild(video);
  await new Promise((resolve) => setTimeout(resolve, 20)); // MutationObserver delivery

  // Removal from the NEW location is only noticed if reanchor re-observed it;
  // a stranded watcher would silently miss this childList record.
  video.remove();
  await waitFor(() => destroyed, 3000);
  assert.ok(destroyed, "the shell was torn down after removal from the swapped parent");
});

test("reconnect cancels the pending grace - a fresh one measures from the current disconnect", async () => {
  const graceMs = FRAMEWORK_TUNING.removalGraceMs;
  FRAMEWORK_TUNING.removalGraceMs = 700;
  try {
    const { kernel, video, created } = makeHarness();
    kernel.init();
    await waitFor(() => created.some((shell) => shell.video === video));
    const shell = created.find((entry) => entry.video === video);
    const wrapper = video.parentElement;
    let destroyedAt = 0;
    shell.destroy = () => { destroyedAt = Date.now(); };

    video.remove();                        // disconnect #1 -> grace armed (fires t0+700)
    await new Promise((r) => setTimeout(r, 50));
    wrapper.appendChild(video);            // reconnect: the event cancels the stale grace
    await new Promise((r) => setTimeout(r, 50));
    const removeAt = Date.now();
    video.remove();                        // disconnect #2 -> fresh grace (fires removeAt+700)
    await waitFor(() => destroyedAt > 0, 3000);

    // The stale grace from disconnect #1 would have fired ~600ms after
    // disconnect #2; a grace always measured from the CURRENT disconnect
    // cannot complete earlier than graceMs.
    assert.ok(
      destroyedAt - removeAt >= graceMs,
      `grace ran ${destroyedAt - removeAt}ms after the current disconnect - stale timer was not cancelled`
    );
  } finally {
    FRAMEWORK_TUNING.removalGraceMs = graceMs;
  }
});

test("kernel re-arms full discovery after the last shell is destroyed", async () => {
  // A clean page: prior tests left kernels sharing this document, but each
  // adopted its own player and is therefore already downgraded to the cheap
  // media-event tap - none of them will see a mutation-only insertion.
  document.body.innerHTML = "";

  const created = [];
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video, container, sdk, onDestroy }) {
      return { video, container, sdk, ready: Promise.resolve(), destroy: () => onDestroy?.() };
    }
  });

  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  document.body.appendChild(wrapper);
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  const first = created.find((shell) => shell.video === video);

  // Removal path tears the shell down -> registry empties -> kernel re-arms.
  // (Calling destroy() directly mirrors lifecycle.onVideoRemoved minus grace.)
  video.remove();
  first.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A second player inserted with no media event: only a live document tap can
  // discover it, which is exactly what the re-arm restored.
  const wrapper2 = document.createElement("div");
  wrapper2.className = "jwplayer";
  const video2 = document.createElement("video");
  wrapper2.appendChild(video2);
  video2.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video2.checkVisibility = () => true;
  document.body.appendChild(wrapper2);

  await waitFor(() => created.some((shell) => shell.video === video2), 3000);
  assert.ok(created.some((shell) => shell.video === video2), "the second player was discovered after re-arm");
});

test("resume (Page Lifecycle) reconciles a shell whose video was detached", async () => {
  document.body.innerHTML = "";
  const { kernel, video, created } = makeHarness();
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  const shell = created.find((entry) => entry.video === video);
  let destroyed = false;
  shell.destroy = () => { destroyed = true; };

  // Freeze->resume fires no pageshow, yet the player tree may have been
  // mutated while frozen; detach without a removal mutation and drive the
  // native resume signal.
  video.remove();
  document.dispatchEvent(new dom.window.Event("resume"));
  assert.equal(destroyed, true, "resume swept the orphaned shell");
});

test("pageshow on a discarded page (persisted false, wasDiscarded true) reconciles", async () => {
  document.body.innerHTML = "";
  const { kernel, video, created } = makeHarness();
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  const shell = created.find((entry) => entry.video === video);
  let destroyed = false;
  shell.destroy = () => { destroyed = true; };

  video.remove();
  document.wasDiscarded = true;
  try {
    document.dispatchEvent(new dom.window.Event("pageshow"));
    assert.equal(destroyed, true, "discarded page reconciled on restore");
  } finally {
    delete document.wasDiscarded;
  }
});