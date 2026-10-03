import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");
const { setSetting } = await import("../src/shell/chrome/config.js");

/** One timer turn: the compact rewrite is requested, so it lands on a task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Controllable matchMedia fake: records compact-query change notifications
 * and holds a single listener slot so tests can drive a viewport
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
    delete globalThis.CloseWatcher;
  };
  return { dom, shell, container, video, teardown };
}

/**
 * CloseWatcher fake. Gecko has shipped the interface on by default since 149
 * (bug 1966073), below the 157 floor, so in production this - not the keydown
 * listener - is the live dismissal path, and without a fake here the branch in
 * #armDismissal would never execute under the harness. It models the parts
 * panel.js actually depends on: a UA-initiated close (Esc, or the Android back
 * button) fires `close`; close() fires `close` and THEN deactivates, which is
 * why #teardownDismissal nulls its refs before calling it; and a listener
 * registered with a signal detaches when that signal aborts.
 */
function installCloseWatcher() {
  const instances = [];
  class FakeCloseWatcher {
    static throwOnConstruct = false;
    #listeners = new Set();
    #closed = false;
    constructor() {
      if (FakeCloseWatcher.throwOnConstruct) {
        throw new TypeError("CloseWatcher is gated on this host");
      }
      instances.push(this);
    }
    addEventListener(type, fn, opts) {
      if (type !== "close") {
        return;
      }
      this.#listeners.add(fn);
      opts?.signal?.addEventListener?.("abort", () => this.#listeners.delete(fn), { once: true });
    }
    removeEventListener(type, fn) {
      if (type === "close") {
        this.#listeners.delete(fn);
      }
    }
    /** UA-initiated close: Esc, or the Android back button. */
    requestClose() {
      if (this.#closed) {
        return;
      }
      this.#fire();
    }
    /** Script-initiated close: fires `close`, then deactivates. */
    close() {
      if (this.#closed) {
        return;
      }
      this.#fire();
      this.#closed = true;
      this.#listeners.clear();
    }
    destroy() {
      this.#closed = true;
      this.#listeners.clear();
    }
    get closed() {
      return this.#closed;
    }
    #fire() {
      for (const fn of [...this.#listeners]) {
        fn({ type: "close" });
      }
    }
  }
  globalThis.CloseWatcher = FakeCloseWatcher;
  return { instances, FakeCloseWatcher };
}

test("compact class tracks a live viewport crossing while open", async () => {
  const media = installMatchMedia();
  const { shell, teardown } = await makeShell(true);
  assert.ok(media.listener, "panel wired the change listener at construction");
  await shell.panel.open();
  assert.ok(shell.panel.element.classList.contains("pf-compact") === media.matches,
    "build mirrors auto-detect at open");
  media.dispatch(true);
  assert.ok(
    shell.panel.element.classList.contains("pf-compact") !== media.matches,
    "same turn: the crossing is requested, not written - L4 owns the class"
  );
  await settle();
  assert.ok(shell.panel.element.classList.contains("pf-compact"),
    "change event applies the class");
  media.dispatch(false);
  await settle();
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
  await settle();
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

test("stepper format drives display + aria-valuetext while commits stay numeric", async () => {
  installMatchMedia();
  const { shell, teardown } = await makeShell(false);
  await shell.panel.open();

  const parent = document.createElement("div");
  let last = null;
  const stepper = shell.panel.addStepper(parent, {
    label: "Boost",
    min: -10,
    max: 10,
    step: 1,
    value: 0,
    format: (v) => `${v > 0 ? "+" : ""}${v}s`,
    onChange: (v) => { last = v; }
  });
  document.body.appendChild(parent);

  // Display shows the formatter; the numeric aria primitive stays raw.
  assert.equal(stepper.input.value, "0s");
  assert.equal(stepper.input.getAttribute("aria-valuetext"), "0s");
  assert.equal(stepper.input.getAttribute("aria-valuenow"), "0");

  // A nudge round-trips numerically (+1s parses back to 1) and re-renders
  // through the formatter - the internal path never feeds formatted text
  // back into parseFloat blind.
  const upButton = parent.querySelector(".pf-stepper-btn");
  upButton.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    view: window
  }));
  assert.equal(stepper.getValue(), 1);
  assert.equal(last, 1);
  assert.equal(stepper.input.value, "+1s");
  assert.equal(stepper.input.getAttribute("aria-valuetext"), "+1s");
  assert.equal(stepper.input.getAttribute("aria-valuenow"), "1");

  teardown();
});

test("dismissal listeners arm per open and die with the panel", async () => {
  installMatchMedia();
  const { shell, teardown } = await makeShell(false);
  // Let any async construction-time document listeners settle before counting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const realAdd = document.addEventListener.bind(document);
  let keydownAdds = 0;
  let pointerdownAdds = 0;
  document.addEventListener = (type, fn, opts) => {
    if (type === "keydown") keydownAdds++;
    else if (type === "pointerdown") pointerdownAdds++;
    return realAdd(type, fn, opts);
  };

  assert.equal(keydownAdds + pointerdownAdds, 0, "no dismissal listeners before the first open");

  await shell.panel.open();
  assert.equal(keydownAdds, 1, "Esc dismissal armed on open");
  assert.equal(pointerdownAdds, 1, "outside-dismissal armed on open");

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(shell.panel.isOpen, false, "Esc closes the open panel");
  assert.equal(pointerdownAdds, 1, "close never re-arms the dismissal scope");

  await shell.panel.open();
  assert.equal(keydownAdds, 2, "dismissal re-arms for the next open");
  assert.equal(pointerdownAdds, 2, "dismissal re-arms for the next open");

  document.body.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true
  }));
  assert.equal(shell.panel.isOpen, false, "a press outside the shell closes the open panel");

  teardown();
});

test("the UA CloseWatcher dismisses the open panel on the target floor", async () => {
  installMatchMedia();
  const watcher = installCloseWatcher();
  const { shell, teardown } = await makeShell(false);
  await shell.panel.open();
  assert.equal(watcher.instances.length, 1, "opening the panel arms a UA close watcher");

  // Closed by the UA itself (its own Esc dispatch, or the Android back button)
  // - no keydown of ours has to reach the shadow host for this to work.
  watcher.instances[0].requestClose();
  assert.equal(shell.panel.isOpen, false, "the watcher's close event closed the panel");

  teardown();
});

test("closing the panel deactivates its watcher and survives the re-entrant close", async () => {
  installMatchMedia();
  const watcher = installCloseWatcher();
  const { shell, teardown } = await makeShell(false);
  await shell.panel.open();
  const instance = watcher.instances[0];

  // close() fires `close` before deactivating, which re-enters the panel's own
  // close(). The refs are nulled first so that re-entry finds nothing left to
  // tear down; this asserts the panel survives the round trip and can reopen.
  assert.doesNotThrow(() => shell.panel.close());
  assert.equal(instance.closed, true, "the watcher was deactivated with the open state");
  assert.equal(shell.panel.isOpen, false);

  await shell.panel.open();
  assert.equal(shell.panel.isOpen, true, "the panel reopens after the re-entrant close");
  assert.equal(watcher.instances.length, 2, "a fresh watcher arms for the next open");

  teardown();
});

test("a CloseWatcher that cannot be constructed degrades to the keydown path", async () => {
  installMatchMedia();
  const watcher = installCloseWatcher();
  watcher.FakeCloseWatcher.throwOnConstruct = true;
  const { shell, teardown } = await makeShell(false);
  await shell.panel.open();
  assert.equal(watcher.instances.length, 0, "the gated constructor never produced a watcher");
  assert.equal(shell.panel.isOpen, true, "the panel still opened without the watcher");

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(shell.panel.isOpen, false, "the fallback keydown path still dismisses");

  teardown();
});