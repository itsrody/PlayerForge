import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");

async function makeShell(id = "t") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
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

  const emissions = [];
  const bus = {
    emit(type, detail) {
      emissions.push({ type, detail });
    },
    addEventListener() {},
    removeEventListener() {}
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const setFullscreenEl = (el) => {
    Object.defineProperty(dom.window.document, "fullscreenElement", {
      value: el, configurable: true
    });
  };
  const fireChange = () => {
    dom.window.document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  const changes = () => emissions.filter((entry) => entry.type === "pf:shell-fullscreen-change");

  const shell = new Shell({ id, video, container, sdk: {}, sdkName: "test-sdk", bus });
  await shell.ready;
  const teardown = () => {
    setFullscreenEl(null);
    fireChange();
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  };

  return { dom, shell, container, video, emissions, setFullscreenEl, fireChange, changes, teardown };
}

test("checkmark is false until an element goes fullscreen", async () => {
  const { shell, teardown } = await makeShell();
  assert.equal(shell.fullscreen, false);
  teardown();
});

test("entering fullscreen on our container flips the checkmark and emits one change", async () => {
  const env = await makeShell();
  const { shell, container, setFullscreenEl, fireChange, changes, teardown } = env;

  setFullscreenEl(container);
  fireChange();

  assert.equal(shell.fullscreen, true);
  assert.deepEqual(changes(), [
    { type: "pf:shell-fullscreen-change", detail: { shellId: "t", fullscreen: true } }
  ]);
  teardown();
});

test("any document fullscreen element marks this shell", async () => {
  const env = await makeShell();
  const { dom, shell, setFullscreenEl, fireChange, changes, teardown } = env;

  const stranger = dom.window.document.createElement("section");
  dom.window.document.body.appendChild(stranger);
  setFullscreenEl(stranger);
  fireChange();

  assert.equal(shell.fullscreen, true);
  assert.deepEqual(changes(), [
    { type: "pf:shell-fullscreen-change", detail: { shellId: "t", fullscreen: true } }
  ]);
  teardown();
});

test("exiting fullscreen emits exactly one false transition", async () => {
  const env = await makeShell();
  const { shell, container, setFullscreenEl, fireChange, changes, teardown } = env;

  setFullscreenEl(container);
  fireChange();
  setFullscreenEl(null);
  fireChange();

  assert.equal(shell.fullscreen, false);
  const states = changes().map((entry) => entry.detail.fullscreen);
  assert.deepEqual(states, [true, false]);
  teardown();
});

test("repeated change events without a state flip are deduped", async () => {
  const env = await makeShell();
  const { shell, container, setFullscreenEl, fireChange, changes, teardown } = env;

  setFullscreenEl(container);
  fireChange();
  fireChange();
  fireChange();

  assert.equal(changes().length, 1, "no spurious re-emits");
  teardown();
});

test("a destroyed shell no longer reacts to fullscreen transitions", async () => {
  const env = await makeShell();
  const { shell, container, emissions, setFullscreenEl, fireChange, teardown } = env;

  shell.destroy();
  setFullscreenEl(container);
  fireChange();

  assert.equal(
    emissions.filter((entry) => entry.type === "pf:shell-fullscreen-change").length,
    0,
    "listener removed with the shell"
  );
  teardown();
});

test("rejected fullscreen request surfaces a hint and emits the blocked event", async () => {
  const env = await makeShell();
  const { dom, shell, emissions, teardown } = env;

  dom.window.document.dispatchEvent(new dom.window.Event("fullscreenerror"));

  const blocked = emissions.filter((entry) => entry.type === "pf:shell-fullscreen-blocked");
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0].detail, { shellId: "t" });

  const toast = shell.shellDom.hudLayer.querySelector("pf-toast");
  assert.ok(toast, "toast surface exists");
  assert.equal(toast.classList.contains("pf-visible"), true);
  assert.match(toast.textContent, /Fullscreen blocked/);
  teardown();
});

test("rejected fullscreen while already fullscreen emits nothing", async () => {
  const env = await makeShell();
  const { dom, shell, container, setFullscreenEl, emissions, teardown } = env;

  setFullscreenEl(container);
  dom.window.document.dispatchEvent(new dom.window.Event("fullscreenerror"));

  assert.equal(
    emissions.filter((entry) => entry.type === "pf:shell-fullscreen-blocked").length,
    0
  );
  teardown();
});
