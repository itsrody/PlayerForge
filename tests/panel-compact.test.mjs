import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");
const { setSetting } = await import("../src/shell/chrome/config.js");

/**
 * Controllable matchMedia fake: records the compact query Chromium fires
 * change for and holds a single listener slot so tests can drive a viewport
 * crossing exactly like the real MediaQueryList. jsdom has no viewport
 * engine, so the loader's static shim is replaced here per-test.
 */
function installMatchMedia() {
  const fake = {
    matches: false,
    listener: null,
    dispatch(matches) {
      fake.matches = matches;
      fake.listener?.({ matches });
    }
  };
  globalThis.matchMedia = (query) => {
    assert.equal(query, "(max-width: 480px) and (pointer: coarse)");
    return {
      get matches() {
        return fake.matches;
      },
      addEventListener(_type, fn) {
        fake.listener = fn;
      },
      removeEventListener() {}
    };
  };
  return fake;
}

async function makeShell(autoDetect) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.CSSStyleSheet = class {
    replaceSync() {}
  };
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    value: [], writable: true, configurable: true
  });

  if (autoDetect) {
    // Unset ui.compact (undefined cache entry) so #isCompactMode falls through
    // to the matchMedia auto-detect branch instead of the explicit default.
    setSetting("ui.compact", undefined);
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  const teardown = () => {
    shell.destroy();
    delete globalThis.matchMedia;
  };
  return { dom, shell, container, video, teardown };
}

test("compact class tracks a live viewport crossing while open", async () => {
  const media = installMatchMedia();
  const { shell, teardown } = await makeShell(true);
  assert.ok(media.listener, "panel wired the change listener at construction");
  await shell.panel.open();
  assert.ok(shell.panel.element.classList.contains("pf-compact") === media.matches,
    "build mirrors auto-detect at open");
  media.dispatch(true);
  assert.ok(shell.panel.element.classList.contains("pf-compact"),
    "change event applies the class");
  media.dispatch(false);
  assert.ok(!shell.panel.element.classList.contains("pf-compact"),
    "change event removes the class");
  teardown();
});

test("explicit ui.compact setting wins and the listener never flips it", async () => {
  const media = installMatchMedia();
  const { shell, teardown } = await makeShell(true);
  setSetting("ui.compact", true);
  await shell.panel.open();
  assert.ok(shell.panel.element.classList.contains("pf-compact"),
    "explicit compact applies at open");
  media.dispatch(false);
  assert.ok(shell.panel.element.classList.contains("pf-compact"),
    "viewport exit cannot override the explicit setting");
  teardown();
});

test("stepper hold-to-repeat releases all timers when the panel dies mid-hold", async () => {
  // Mirrors HOLD_DELAY_MS / HOLD_REPEAT_MS in panel.js.
  const HOLD_DELAY_MS = 400;
  installMatchMedia();
  const { shell, teardown } = await makeShell(false);
  await shell.panel.open();

  const parent = document.createElement("div");
  let nudges = 0;
  shell.panel.addStepper(parent, {
    label: "Test",
    min: 0,
    max: 100,
    step: 1,
    value: 0,
    onChange: () => nudges++
  });
  document.body.appendChild(parent);

  const upButton = parent.querySelector(".pf-stepper-btn");
  upButton.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    view: window
  }));

  // Past the delay so the 75ms repeat interval is live and nudging.
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS + 150));
  assert.ok(nudges >= 2, "hold started repeating before destroy");

  shell.destroy();
  const frozen = nudges;
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(nudges, frozen, "destroy stopped the repeat - no nudges on a dead panel");
  teardown();
});