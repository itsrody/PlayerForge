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

// The default-on fallback announces itself exactly once: the first generic
// adoption gets a hint pointing at its toggle, later ones stay silent.
test("the first generic adoption shows the fallback notice once", async () => {
  const savedGet = globalThis.GM_getValue;
  const savedSet = globalThis.GM_setValue;
  const stored = {};
  globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
  globalThis.GM_setValue = (key, value) => { stored[key] = value; };
  const { Shell: ShellCtor } = await import("../src/shell/shell.js");
  const hints = [];
  const origHint = ShellCtor.prototype.toastHint;
  ShellCtor.prototype.toastHint = function (icon, text) {
    hints.push(text);
    return origHint.call(this, icon, text);
  };
  try {
    const first = makeRealm();
    const shell1 = new ShellCtor({
      video: first.video,
      container: first.container,
      sdk: { name: "test-sdk", source: "generic" }
    });
    await shell1.ready;
    assert.equal(hints.length, 1, "the first measured guess announces itself");
    assert.equal(stored["pf:generic-notice"], true, "the flag lands in the same adoption");
    shell1.destroy();

    const second = makeRealm();
    const shell2 = new ShellCtor({
      video: second.video,
      container: second.container,
      sdk: { name: "test-sdk", source: "generic" }
    });
    await shell2.ready;
    assert.equal(hints.length, 1, "later adoptions stay silent");
    shell2.destroy();

    const third = makeRealm();
    const shell3 = new ShellCtor({
      video: third.video,
      container: third.container,
      sdk: { name: "test-sdk", source: "registry" }
    });
    await shell3.ready;
    assert.equal(hints.length, 1, "anchored players never announced themselves anyway");
    shell3.destroy();
  } finally {
    ShellCtor.prototype.toastHint = origHint;
    globalThis.GM_getValue = savedGet;
    globalThis.GM_setValue = savedSet;
    delete globalThis.CSSStyleSheet;
  }
});

test("a shell inside a shadow root re-offers late shadow videos", async () => {
  const { dom } = makeRealm();
  const doc = dom.window.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = doc.createElement("div");
  shadow.appendChild(container);
  const video = doc.createElement("video");
  container.appendChild(video);

  const reoffered = [];
  const shell = new Shell({
    video,
    container,
    sdk: { name: "test-sdk" },
    reoffer: (v) => reoffered.push(v)
  });
  await shell.ready;
  assert.deepEqual(reoffered, [], "boot offers nothing by itself");

  const late = doc.createElement("video");
  shadow.appendChild(late);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(reoffered.includes(late), "a video appended to the adopted root is re-offered");
  assert.ok(!reoffered.includes(video), "the shell never re-offers its own video");
  shell.destroy();
  delete globalThis.CSSStyleSheet;
});

test("a light-DOM shell arms no shadow watch", async () => {
  const { container, video } = makeRealm();
  const reoffered = [];
  const shell = new Shell({
    video,
    container,
    sdk: { name: "test-sdk" },
    reoffer: (v) => reoffered.push(v)
  });
  await shell.ready;
  const late = document.createElement("video");
  document.body.appendChild(late);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(reoffered, [], "the document feed owns light-DOM videos, not the shell");
  late.remove();
  shell.destroy();
  delete globalThis.CSSStyleSheet;
});

test("prep that shifts the player aborts the mount without stranding", async () => {
  const { container, video } = makeRealm();
  // The snapshot reads the settled box; the verify re-read must see drift.
  const box = (w) => ({ width: w, height: 360, x: 0, y: 0, top: 0, left: 0, right: w, bottom: 360 });
  let reads = 0;
  video.getBoundingClientRect = () => box(++reads === 1 ? 640 : 700);
  container.getBoundingClientRect = () => box(640);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  const err = await shell.ready.then(() => null, (e) => e);
  assert.match(String(err), /placement shifted under prep/);
  assert.equal(err?.transient, true, "timing noise must not spend the defect retry");
  assert.equal(container.querySelector(".pf-shell"), null, "no host stranded by a disturbed mount");
  assert.equal(video.hasAttribute(SHELL_MARKER), false, "the video gave up its shell claim");
  assert.equal(container.hasAttribute(SHELL_MARKER), false, "the container gave up its shell claim");
  delete globalThis.CSSStyleSheet;
});

test("every sync cadence event reaches the OS session through status", async () => {
  // The shell drives sync() from status commits (plus the clock and a
  // seeked exception), never from per-event listeners: dispatching each
    // cadence event must still move the session. Position bumps force past
    // the bridge's dedup so every sync is observable as a write - kept small
    // because the bridge clamps position to duration, and a bump past the end
    // of the timeline would dedup against the clamp instead of writing.
  const { dom, container, video } = makeRealm();
  const writes = [];
  const states = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaSession: {
        setActionHandler() {},
        set playbackState(value) {
          states.push(value);
        },
        set metadata(value) {},
        setPositionState(state) {
          writes.push({ ...state });
        }
      }
    },
    writable: true,
    configurable: true
  });
  const MediaMetadataDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaMetadata");
  globalThis.MediaMetadata = class MediaMetadata {
    constructor(options) {
      this._captured = options;
    }
  };
  try {
    Object.defineProperty(video, "duration", { value: 120, configurable: true });
    Object.defineProperty(video, "paused", { value: true, configurable: true, writable: true });
    Object.defineProperty(video, "ended", { value: false, configurable: true, writable: true });
    Object.defineProperty(video, "currentTime", { value: 0, configurable: true, writable: true });
    const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
    await shell.ready;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    let time = 0;
    const bump = () => {
      time += 1;
      Object.defineProperty(video, "currentTime", { value: time, configurable: true });
    };
    const fire = (type) => {
      bump();
      video.dispatchEvent(new dom.window.Event(type));
    };
    const written = () => writes.length;

    video.paused = false;
    fire("playing");
    await tick();
    assert.ok(states.includes("playing"), "play transition reaches the session");
    const afterPlaying = written();
    assert.ok(afterPlaying > 0, "position rides the same commit");

    video.paused = true;
    fire("pause");
    await tick();
    assert.ok(states.includes("paused"));

    video.muted = true;
    fire("volumechange");
    await tick();
    assert.ok(written() > afterPlaying, "volume transition syncs");

    Object.defineProperty(video, "playbackRate", { value: 1.5, configurable: true });
    fire("ratechange");
    await tick();
    assert.ok(written() > afterPlaying, "rate transition syncs");

    Object.defineProperty(video, "duration", { value: 180, configurable: true });
    fire("durationchange");
    await tick();
    assert.ok(written() > afterPlaying, "duration transition syncs");

    fire("seeked");
    await tick();
    assert.ok(written() > afterPlaying, "the position exception syncs seek-only moves");

    fire("loadedmetadata");
    await tick();
    assert.ok(written() > afterPlaying, "metadata arrival syncs");

    video.ended = true;
    fire("ended");
    await tick();
    assert.ok(written() > afterPlaying, "end-of-stream syncs");

    fire("emptied");
    await tick();
    assert.ok(written() > afterPlaying, "emptying syncs");

    // A bare play request with nothing behind it syncs nothing: the request
    // was accepted but no frame rendered, and observed-not-optimistic means
    // the OS surface must not claim motion that never started.
    const silent = written();
    video.paused = false;
    fire("play");
    await tick();
    assert.equal(written(), silent, "no transition, no sync - dedup equivalence holds");

    // The clock still ticks while playing: attach it, then timeupdate moves.
    // (ended resets first - the activity gates on motion, not on the flag
    // the previous step left behind.)
    video.ended = false;
    fire("playing");
    await tick();
    const clocked = written();
    fire("timeupdate");
    await tick();
    assert.ok(written() > clocked, "the media clock drives position between transitions");

    shell.destroy();
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    if (MediaMetadataDescriptor) {
      Object.defineProperty(globalThis, "MediaMetadata", MediaMetadataDescriptor);
    } else {
      delete globalThis.MediaMetadata;
    }
    delete globalThis.CSSStyleSheet;
  }
});

test("backdrop presses never reach the SDK as taps", async () => {
  // The panel root stops five event types from crossing into the SDK; the
  // backdrop used to stop pointerdown only, so dismissing the panel doubled
  // as a tap on whatever press dismissed it.
  const { dom, container, video } = makeRealm();
  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  try {
    let taps = 0;
    container.addEventListener("click", () => taps++);
    const backdrop = shell.shellDom.hudLayer.querySelector(".pf-panel-backdrop");
    backdrop.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.equal(taps, 0, "backdrop click died at the shield");
    video.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.equal(taps, 1, "ordinary clicks still bubble");
  } finally {
    shell.destroy();
    delete globalThis.CSSStyleSheet;
  }
});
