import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");
const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");
const shadow = await import("../src/shared/shadow.js");
const { subscribeFullscreen } = shadow;
const { requestFullscreenProvision, FS_REQUEST_TYPE } = await import("../src/shared/context.js");

/** One timer turn: the toast's writes go through L4, so they land on a task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function makeShell({ embedded = false } = {}) {
  const outer = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  // An embedded frame is the only shape where window.top !== window, which is
  // exactly the branch the fullscreen re-provision lives behind, so that case
  // has to be a real frame rather than a stubbed `top`.
  let dom = outer;
  let win = outer.window;
  if (embedded) {
    const frame = outer.window.document.createElement("iframe");
    outer.window.document.body.appendChild(frame);
    win = frame.contentWindow;
    dom = { window: win };
  }
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.document = win.document;
  // Wire the shared fs gate to this environment BEFORE any shell/forge
  // subscribes, so subscriptions see the one shared transition source.
  initFsGate(dom);
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.MutationObserver = win.MutationObserver;
  // jsdom rejects foreign-realm AbortSignals in listener options.
  globalThis.AbortController = win.AbortController;
  // inject.js builds a constructable stylesheet against the ambient realm;
  // provide a realm-local fake so the suite never depends on jsdom CSS support.
  globalThis.CSSStyleSheet = class {
    replaceSync() {}
  };
  Object.defineProperty(win.document, "adoptedStyleSheets", {
    value: [],
    writable: true,
    configurable: true
  });

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const video = win.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  const teardown = () => {
    setFullscreen(dom, null);
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  };

  return { dom, shell, container, video, teardown, parent: outer.window };
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
  await settle();

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
  await settle();

  const toasts = shell.shellDom.hudLayer.querySelectorAll("pf-toast.pf-visible");
  assert.equal(toasts.length, 0, "no blocked hint while already fullscreen");
  teardown();
});

test("a rejected fullscreen re-provisions the chain after boot already spent the latch", async () => {
  const { dom, parent, teardown } = await makeShell({ embedded: true });

  // The handler posts to window.parent, which is the outer frame here.
  const posted = [];
  const original = parent.postMessage.bind(parent);
  parent.postMessage = (msg) => posted.push(msg);
  try {
    // entry.js spends the boot-time latch the moment the shell comes up, long
    // before any fullscreen attempt. That is why recovery cannot ride the same
    // entry point - a spent latch would silently drop the replay.
    requestFullscreenProvision();
    requestFullscreenProvision();
    assert.equal(posted.length, 1, "boot-time provisioning posted once and latched");

    dom.window.document.dispatchEvent(new dom.window.Event("fullscreenerror"));
    assert.deepEqual(
      posted[1],
      { type: FS_REQUEST_TYPE },
      "the rejected attempt re-provisioned the ancestor chain"
    );
  } finally {
    parent.postMessage = original;
    teardown();
  }
});

test("referenceBox in fullscreen is the physical screen", async () => {
  const { dom, shell, container, teardown } = await makeShell();
  globalThis.screen = { width: 1080, height: 2400 };
  // Geometry rule: fullscreen reference is screen.* - the :fullscreen CSS
  // stretches the container to the screen, and Firefox has no safe-area
  // letterboxing to narrow around.
  setFullscreen(dom, container);
  assert.deepEqual(shell.referenceBox, { width: 1080, height: 2400 });
  setFullscreen(dom, null);
  delete globalThis.screen;
  teardown();
});

test("destroy is idempotent - calling twice does not throw or double-cleanup", async () => {
  const { shell, teardown } = await makeShell();
  // First destroy should clean up normally
  shell.destroy();
  // Second destroy should be a complete no-op (no throw, no double-remove)
  shell.destroy();
  // Verify shell is cleaned up
  assert.ok(!shell.shellDom, "shellDom cleared after destroy");
  teardown();
});

test("a throwing fullscreen subscriber does not strand the ones after it", async () => {
  const { dom, container, teardown } = await makeShell();
  const seen = [];
  subscribeFullscreen(() => {
    throw new Error("subscriber blew up");
  });
  subscribeFullscreen((active) => seen.push(active));
  subscribeFullscreen((active) => seen.push(active * 10));

  // The dispatch runs from a native fullscreenchange listener, so an escaping
  // throw would surface in the page's error channel and strand the HUD close
  // and the gesture unbind that subscribe later in the fan-out.
  setFullscreen(dom, container);

  assert.deepEqual(seen, [true, 10], "a throwing subscriber skipped its peers");
  teardown();
});

test("the gate boolean still flips when a subscriber throws", async () => {
  const { dom, container, teardown } = await makeShell();
  subscribeFullscreen(() => {
    throw new Error("subscriber blew up");
  });

  setFullscreen(dom, container);
  assert.equal(shadow.fs, true, "fs gate must latch before dispatching");
  setFullscreen(dom, null);
  assert.equal(shadow.fs, false);
  teardown();
});

test("unsubscribing mid-dispatch still notifies the remaining subscribers", async () => {
  // Without a snapshot, deleting from the live Set during iteration skips the
  // subscriber that shifted into the removed slot.
  const { dom, container, teardown } = await makeShell();
  const seen = [];
  let offSecond;
  subscribeFullscreen((active) => seen.push(active));
  offSecond = subscribeFullscreen((active) => {
    seen.push(active);
    offSecond();
  });
  subscribeFullscreen((active) => seen.push(active * 10));

  setFullscreen(dom, container);

  assert.deepEqual(seen, [true, true, 10]);
  teardown();
});

test("initFullscreenGate returns a disposable handle and does not stack gates", async () => {
  const { dom, container, teardown } = await makeShell();
  const seen = [];

  // A second init must not leave the first native listener behind, or every
  // transition fans out twice.
  initFsGate(dom);
  subscribeFullscreen((active) => seen.push(active));

  setFullscreen(dom, container);
  setFullscreen(dom, null);

  assert.deepEqual(seen, [true, false], "a re-init stacked a second gate");
  teardown();
});
