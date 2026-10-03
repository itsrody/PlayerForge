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
const { initFsGate } = await import("./fs-gate.mjs");

/**
 * A controllable IntersectionObserver, installed before the shell boots so
 * both of its users see this rather than the loader's no-op shim: PlayerStatus
 * (which turns the report into Presence.OCCLUDED) and resume.js's save gate
 * (which just flips a boolean). A real scroll drives both at once, so this
 * does too.
 */
const observers = new Set();

globalThis.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    observers.add(this);
  }

  observe(target) {
    this.targets.push(target);
  }

  unobserve(target) {
    this.targets = this.targets.filter((t) => t !== target);
  }

  disconnect() {
    observers.delete(this);
  }

  fire(isIntersecting) {
    if (!this.targets.length) {
      return;
    }
    this.cb(
      [{ isIntersecting, intersectionRatio: isIntersecting ? 1 : 0, target: this.targets[0] }],
      this
    );
  }
};

const setIntersecting = (isIntersecting) => {
  for (const io of [...observers]) {
    io.fire(isIntersecting);
  }
};

/** One microtask turn - the batch PlayerStatus delivers its commit on. */
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

/**
 * One timer turn: the occlusion resolve is *requested* rather than run, so the
 * class write lands on the gate's task. Every assertion below reads `pf-detached`,
 * which is why the microtask alone stopped being enough in phase 7.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** PlayerStatus's commit, then the RenderGate commit it requests. */
const flush = async () => {
  await tick();
  await settle();
};

/** jsdom exposes visibilityState only as a prototype getter. */
function setVisibility(doc, hidden) {
  Object.defineProperty(doc, "visibilityState", {
    value: hidden ? "hidden" : "visible",
    configurable: true
  });
  Object.defineProperty(doc, "hidden", { value: hidden, configurable: true });
  doc.dispatchEvent(new globalThis.Event("visibilitychange"));
}

async function makeShell() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  initFsGate(dom);
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  // jsdom rejects foreign-realm AbortSignals in listener options.
  globalThis.AbortController = dom.window.AbortController;
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

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;

  const host = container.querySelector(".pf-shell");
  assert.ok(host, "the shell host is in the container");

  return {
    dom,
    shell,
    container,
    video,
    host,
    doc: dom.window.document,
    teardown: () => {
      shell.destroy();
      delete globalThis.CSSStyleSheet;
    }
  };
}

test("a paused player the viewport cannot see drops the HUD, and takes it back", async () => {
  const { host, video, teardown } = await makeShell();
  assert.equal(video.paused, true, "the fixture boots unstarted, i.e. idle");
  assert.ok(!host.classList.contains("pf-detached"), "on screen: attached");

  setIntersecting(false);
  await flush();
  assert.ok(host.classList.contains("pf-detached"), "paused + off screen -> out of layout");

  setIntersecting(true);
  await flush();
  assert.ok(!host.classList.contains("pf-detached"), "back on screen -> attached again");

  teardown();
});

test("a playing player keeps its HUD even off screen", async () => {
  const { host, video, teardown } = await makeShell();

  video.dispatchEvent(new globalThis.Event("playing"));
  await flush();

  setIntersecting(false);
  await flush();

  assert.ok(!host.classList.contains("pf-detached"), "the playhead is advancing, so the HUD matters");
  teardown();
});

test("focus on a control inside the HUD blocks the detach until it leaves", async () => {
  const { host, doc, teardown } = await makeShell();

  const layer = host.shadowRoot.querySelector(".pf-hud-layer");
  const control = doc.createElement("button");
  layer.appendChild(control);
  control.focus();

  setIntersecting(false);
  await flush();
  assert.ok(
    !host.classList.contains("pf-detached"),
    "hiding it now would drop this focus mid-interaction"
  );

  control.blur();
  // jsdom does not run the composed focus pair out of a shadow root, so the
  // trigger is dispatched directly: what is under test is that the listener
  // schedules a re-resolve with no geometry change at all.
  control.dispatchEvent(new doc.defaultView.Event("focusout"));
  await flush();
  assert.ok(host.classList.contains("pf-detached"), "the focusout trigger re-resolves on its own");

  teardown();
});

test("the shell's own focus anchor is not focus-within", async () => {
  const { host, doc, teardown } = await makeShell();

  assert.equal(doc.activeElement, host, "boot parks focus on the host as a keyboard sink");

  setIntersecting(false);
  await flush();

  assert.ok(
    host.classList.contains("pf-detached"),
    "a parked sink is not interaction - counting it would make the rule unsatisfiable"
  );

  teardown();
});

test("a hidden tab is an occlusion, not a visibility", async () => {
  const { host, doc, teardown } = await makeShell();

  setVisibility(doc, true);
  await flush();
  assert.ok(
    host.classList.contains("pf-detached"),
    "on screen but the tab is hidden - not visible to the user either"
  );

  setVisibility(doc, false);
  await flush();
  assert.ok(!host.classList.contains("pf-detached"), "tab back -> attached");

  teardown();
});

test("an on-screen player never detaches, whatever else changes", async () => {
  const { host, video, doc, teardown } = await makeShell();

  video.dispatchEvent(new globalThis.Event("pause"));
  setVisibility(doc, true);
  setVisibility(doc, false);
  await flush();

  assert.ok(!host.classList.contains("pf-detached"), "geometry is the conjunct that cannot be skipped");
  teardown();
});

test("teardown leaves no observer behind", async () => {
  const { teardown } = await makeShell();
  assert.ok(observers.size > 0, "both off-screen gates registered while the shell lived");

  teardown();

  assert.equal(observers.size, 0, "every observer the shell made was disconnected");
});
