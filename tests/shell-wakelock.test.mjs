import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");

async function makeWakeLockShell() {
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

  const released = [];
  let seq = 0;
  const pending = [];
  let requests = 0;
  const wakeLock = {
    released,
    get requests() { return requests; },
    async request() {
      requests += 1;
      return new Promise((resolve) => pending.push((id) => resolve({ release: () => released.push(id) })));
    },
    resolveNext() {
      const settle = pending.shift();
      assert.ok(settle, "a wake-lock request is in flight");
      settle(++seq);
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
  return { dom, shell, video, wakeLock, play, pause, tick };
}

test("wake lock resolved after pause releases itself (no stranded lock)", async () => {
  const { shell, video, wakeLock, play, pause, tick } = await makeWakeLockShell();
  video.paused = false;
  play(); // acquire in flight
  assert.equal(wakeLock.released.length, 0);

  video.paused = true;
  pause(); // release runs while the request is unresolved
  assert.equal(wakeLock.released.length, 0, "nothing to release yet");

  wakeLock.resolveNext(); // the stale request settles after the pause
  await tick();
  assert.equal(wakeLock.released.length, 1, "the late lock drops itself instead of lighting the screen");
  shell.destroy();
});

test("wake lock resolved after destroy releases itself", async () => {
  const { shell, video, wakeLock, play, tick } = await makeWakeLockShell();
  video.paused = false;
  play();
  shell.destroy();
  wakeLock.resolveNext();
  await tick();
  assert.equal(wakeLock.released.length, 1, "a lock that lands after teardown is discarded");
});

test("overlapping acquires: the newer lock wins, the older one is dropped", async () => {
  const { shell, video, wakeLock, play, pause, tick } = await makeWakeLockShell();
  video.paused = false;
  play();
  play(); // second acquire supersedes the first while both are in flight

  wakeLock.resolveNext(); // first settles and becomes the active lock
  await tick();
  assert.equal(wakeLock.released.length, 0, "the first lock holds until the winner lands");
  wakeLock.resolveNext(); // second settles and supersedes the first
  await tick();
  assert.equal(wakeLock.released.length, 1, "the superseded first lock is released on arrival");

  video.paused = true;
  pause();
  assert.equal(wakeLock.released.length, 2, "pausing releases the held (winner) lock");
  shell.destroy();
});