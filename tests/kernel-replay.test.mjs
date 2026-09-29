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

const { logger } = await import("../src/shared/diagnostics.js");
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
test("a shell that fails to boot is retried exactly once, then abandoned", async () => {
  // Fresh video so the counter is ours alone: every kernel in this file adopts
  // every video in the shared body, and the earlier harnesses are still live.
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  document.body.appendChild(wrapper);
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  let attempts = 0;
  const kernel = new Kernel();
  kernel.registerShellProvider({
    create({ video: v, container, sdk }) {
      if (v === video) {
        attempts++;
      }
      return {
        video: v,
        container,
        sdk,
        ready: Promise.reject(new Error("boot boom")),
        destroy() {}
      };
    }
  });
  kernel.init();
  await waitFor(() => attempts >= 1, 3000);

  // The shell rolls its own DOM back, so the video is unmarked and adoptable
  // again. A media event is the real re-discovery signal: the mutation feed
  // only visits videos in ADDED nodes, so it would never re-offer a video that
  // is already sitting in the DOM - which is the whole point of the re-arm.
  const nudge = () => video.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));
  for (let i = 0; i < 60 && attempts < 2; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 2, "the failed video was re-armed for exactly one retry");

  // Unbounded re-arming would spin on every event, so a deterministically
  // throwing boot has to be final on its second failure.
  for (let i = 0; i < 24; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 2, "a boot that keeps throwing does not spin on the discovery tap");
});

test("a bfcache pagehide keeps shell-created listeners live for the restored page", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));

  // persisted: true is the bfcache case. The kernel must NOT tear down here -
  // the page is coming back, so whoever registered a shell-created listener
  // still has to hear about the next shell. (A real pagehide is the branch
  // that releases the set; clearing it unconditionally would break exactly
  // this restore path.)
  const hide = new dom.window.Event("pagehide");
  hide.persisted = true;
  dom.window.dispatchEvent(hide);

  const before = created.length;
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const late = document.createElement("video");
  wrapper.appendChild(late);
  document.body.appendChild(wrapper);
  late.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  late.checkVisibility = () => true;
  late.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));

  await waitFor(() => created.length > before, 3000);
  assert.equal(created.length, before + 1, "the restored page still notifies its shell-created listener");
});
