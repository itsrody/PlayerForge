import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");

async function makeWakeLockShell({ visualViewportHeight = null } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1",
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.CSSStyleSheet = class { replaceSync() {} };
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    value: [],
    writable: true,
    configurable: true,
  });

  let visualViewport = null;
  if (visualViewportHeight != null) {
    visualViewport = new dom.window.EventTarget();
    visualViewport.height = visualViewportHeight;
    visualViewport.offsetTop = 50;
    Object.defineProperty(dom.window, "visualViewport", {
      value: visualViewport,
      configurable: true,
    });
  }

  // Native wake-lock contract: request("screen", { signal }) - the browser
  // owns release. Aborting a held lock releases it; aborting an in-flight
  // request rejects it with AbortError and no lock is ever formed.
  let seq = 0;
  const released = [];
  const pending = [];
  let requests = 0;
  const wakeLock = {
    released,
    get requests() { return requests; },
    request(_type, { signal }) {
      requests += 1;
      const session = { signal, id: ++seq, lock: null };
      signal.addEventListener("abort", () => {
        if (session.lock) {
          released.push(session.id);
        }
        session.lock = null;
      });
      return new Promise((resolve, reject) => {
        pending.push(() => {
          if (signal.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          } else {
            const lock = { release: () => released.push(session.id) };
            session.lock = lock;
            resolve(lock);
          }
        });
      });
    },
    resolveNext() {
      const settle = pending.shift();
      assert.ok(settle, "a wake-lock request is in flight");
      settle();
    }
  };
  Object.defineProperty(globalThis.navigator, "wakeLock", {
    value: wakeLock,
    configurable: true
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);
  let paused = true;
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
    set: (v) => { paused = !!v; }
  });

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;

  const play = () => video.dispatchEvent(new dom.window.Event("play"));
  const pause = () => video.dispatchEvent(new dom.window.Event("pause"));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { dom, shell, video, wakeLock, play, pause, tick, visualViewport };
}

test("pause aborts an in-flight request; no lock is ever created", async () => {
  const { shell, video, wakeLock, play, pause, tick } = await makeWakeLockShell();
  video.paused = false;
  play(); // acquire in flight
  assert.equal(wakeLock.requests, 1);

  video.paused = true;
  pause(); // abort races the unresolved request
  wakeLock.resolveNext(); // the stale request settles after the pause
  await tick();
  assert.equal(wakeLock.released.length, 0, "the aborted request never forms a lock");
  shell.destroy();
});

test("destroy releases a held lock", async () => {
  const { shell, video, wakeLock, play, tick } = await makeWakeLockShell();
  video.paused = false;
  play();
  wakeLock.resolveNext(); // lock held
  await tick();
  assert.equal(wakeLock.released.length, 0, "lock still held");

  shell.destroy(); // abort tears the held lock down
  await tick();
  assert.equal(wakeLock.released.length, 1, "destroy releases the held lock");
});

test("overlapping acquires: the newer signal wins, pause releases the winner", async () => {
  const { shell, video, wakeLock, play, pause, tick } = await makeWakeLockShell();
  video.paused = false;
  play();
  play(); // second acquire supersedes the first while both are in flight

  wakeLock.resolveNext(); // first settles after being superseded -> AbortError
  await tick();
  assert.equal(wakeLock.released.length, 0, "the superseded request forms no lock");
  wakeLock.resolveNext(); // second settles -> becomes the active lock
  await tick();
  assert.equal(wakeLock.released.length, 0, "winner held, nothing released");

  video.paused = true;
  pause();
  assert.equal(wakeLock.released.length, 1, "pausing releases the held (winner) lock");
  shell.destroy();
});

test("pause when no lock is held is a no-op", async () => {
  const { shell, video, wakeLock, pause } = await makeWakeLockShell();
  video.paused = true;
  pause();
  assert.equal(wakeLock.requests, 0, "no acquire ever happened");
  assert.equal(wakeLock.released.length, 0);
  shell.destroy();
});

test("a media error surfaces a labelled toast", async () => {
  const { dom, shell, video } = await makeWakeLockShell();
  const seen = [];
  shell.toastInfo = (icon, text, group) => seen.push({ icon, text, group });

  Object.defineProperty(video, "error", { configurable: true, value: { code: 3 } });
  video.dispatchEvent(new dom.window.Event("error"));
  assert.deepEqual(seen[0], { icon: "alert", text: "Video could not be decoded", group: "media-error" });

  Object.defineProperty(video, "error", { configurable: true, value: { code: 99 } });
  video.dispatchEvent(new dom.window.Event("error"));
  assert.equal(seen[1].text, "Video playback error", "unknown code falls back to a generic label");

  shell.destroy();
});

test("visualViewport mirrors onto the host as CSS custom properties", async () => {
  const { dom, shell, visualViewport } = await makeWakeLockShell({ visualViewportHeight: 400 });
  const host = shell.shellHost;
  assert.equal(host.style.getPropertyValue("--pf-vv-height"), "400px");
  assert.equal(
    host.style.getPropertyValue("--pf-vv-inset-bottom"),
    `${dom.window.innerHeight - 400 - 50}px`
  );

  visualViewport.height = 300;
  visualViewport.offsetTop = 120;
  visualViewport.dispatchEvent(new dom.window.Event("resize"));
  assert.equal(host.style.getPropertyValue("--pf-vv-height"), "300px");
  assert.equal(
    host.style.getPropertyValue("--pf-vv-inset-bottom"),
    `${dom.window.innerHeight - 300 - 120}px`
  );

  shell.destroy();
});