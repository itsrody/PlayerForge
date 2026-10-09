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

// Parking focus on the host must never move the viewport: adopting a
// below-fold player with a bare focus() scrolls the page to it on boot and
// on every outside click after. jsdom ignores focus options, so the call is
// observed through a spy rather than through scroll position.
test("boot parks focus without scrolling the page", async () => {
  const { dom, container, video } = makeRealm();
  const calls = [];
  const proto = dom.window.HTMLElement.prototype;
  const native = proto.focus;
  proto.focus = function (options) {
    calls.push(options);
    return native.call(this, options);
  };
  try {
    const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
    await shell.ready;
    assert.ok(calls.length > 0, "boot focuses the host");
    for (const options of calls) {
      assert.equal(options?.preventScroll, true, "every host focus carries preventScroll");
    }
    shell.destroy();
  } finally {
    proto.focus = native;
    delete globalThis.CSSStyleSheet;
  }
});

// The overlay host carries z-index INT32_MAX, which escapes the player into
// the page's own stacking context unless the container contains it.
test("boot contains the overlay paint order on the container", async () => {
  const { container, video } = makeRealm();
  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  try {
    assert.equal(
      container.style.getPropertyValue("isolation"),
      "isolate",
      "the container becomes a stacking context for the overlay"
    );
  } finally {
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  }
});

// A page script can overwrite document.adoptedStyleSheets wholesale, silently
// dropping every document-realm rule (tokens, the :fullscreen fix, the
// occlusion gate) while the shadow HUD keeps working. Shell injection
// re-asserts the adoption, so the loss is repaired on the next shell.
test("injection repairs a clobbered document stylesheet adoption", async () => {
  const { dom, container, video } = makeRealm();
  const { warmStyles, injectShell } = await import("../src/shell/chrome/inject.js");
  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  try {
    const sheet = warmStyles();
    assert.ok(dom.window.document.adoptedStyleSheets.includes(sheet), "precondition: sheet is adopted");
    dom.window.document.adoptedStyleSheets = [];
    const fresh = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(fresh);
    injectShell(fresh);
    assert.ok(
      dom.window.document.adoptedStyleSheets.includes(sheet),
      "injection re-adopted the sheet the page dropped"
    );
  } finally {
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  }
});

// A video reparented between adoption and mount must abort placement instead
// of stranding the host in the abandoned container: the settle guard ran
// before the build, and the prep plus the yields since span the exact window
// SDKs re-parent in. The throw rides the constructor rollback and the
// kernel's re-arm, exactly like any other boot failure.
test("a video moved mid-boot aborts placement without stranding the host", async () => {
  const { dom, container, video } = makeRealm();
  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  // Synchronous with construction - long before the post-prep verify runs.
  const elsewhere = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(elsewhere);
  elsewhere.appendChild(video);
  await assert.rejects(shell.ready, /placement lost mid-boot/);

  assert.equal(container.querySelector(".pf-shell"), null,
    "no host stranded in the abandoned container");
  assert.equal(video.hasAttribute(SHELL_MARKER), false, "the video gave up its shell claim");
  assert.equal(container.hasAttribute(SHELL_MARKER), false, "the container gave up its shell claim");
  delete globalThis.CSSStyleSheet;
});

// The parasite watchdog fights SDK evictions back - unless the shell is dead,
// in which case the eviction is the teardown landing, not a fight to pick.
// Re-appending a host the removal watch just decided to destroy is a race
// decided by microtask order; the liveness predicate decides it outright.
test("the watchdog re-attaches while alive and yields once dead", async () => {
  const { container } = makeRealm();
  const { injectShell, watchShellHost } = await import("../src/shell/chrome/inject.js");
  const { DOMManager } = await import("../src/shared/dom-manager.js");
  const { host } = injectShell(container);
  assert.ok(host, "the host mounted");
  const mgr = new DOMManager();
  let alive = true;
  watchShellHost(container, host, mgr, () => alive);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  host.remove();
  await tick();
  assert.equal(host.parentElement, container, "a live shell fights the eviction back");

  alive = false;
  host.remove();
  await tick();
  assert.equal(host.parentElement, null, "a dead shell lets the teardown land");
  mgr.destroy();
  delete globalThis.CSSStyleSheet;
});
