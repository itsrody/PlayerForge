import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EventBus } from "../src/kernel/bus.js";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");

/**
 * SpyBus wraps the real EventBus so we can count how many listeners are
 * registered per event type. SubtitlesSection uses addEventListener with
 * { signal } so we track both add and remove counts.
 */
class SpyBus extends EventBus {
  #counts = new Map();

  addEventListener(type, fn, opts) {
    super.addEventListener(type, fn, opts);
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1);
  }

  removeEventListener(type, fn) {
    super.removeEventListener(type, fn);
    const n = this.#counts.get(type) ?? 0;
    if (n <= 1) this.#counts.delete(type);
    else this.#counts.set(type, n - 1);
  }

  count(type) {
    return this.#counts.get(type) ?? 0;
  }
}

function makeShell() {
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

  const bus = new SpyBus();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({
    id: "lazy-test",
    video,
    container,
    sdk: {},
    sdkName: "test-sdk",
    bus,
  });

  return { dom, shell, bus, container, video };
}

test("no timeupdate subscription when no track is loaded", () => {
  const { shell, bus, video } = makeShell();

  assert.equal(bus.count("pf:shell-timeupdate"), 0, "idle shell has no tick listener");

  bus.emit("pf:shell-timeupdate", {
    shellId: shell.id,
    event: { type: "timeupdate" },
    video,
  });

  assert.equal(bus.count("pf:shell-timeupdate"), 0, "still no subscription after void emit");
  shell.destroy();
});

test("track load subscribes, destroy removes subscription", async () => {
  const { shell, bus, container, dom } = makeShell();

  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello";
  const file = new File([vtt], "sub.vtt", { type: "text/vtt" });

  // Bypass jsdom's missing DataTransfer — the file-input change handler
  // reads input.files?.[0] then calls this.load(file). A plain array
  // satisfies the optional-chain; the File.text() API is native in Node.
  const input = container.querySelector('input[type="file"]');
  assert.ok(input, "file input present");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change"));

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bus.count("pf:shell-timeupdate"), 1, "subscribed after track load");

  shell.destroy();
  assert.equal(bus.count("pf:shell-timeupdate"), 0, "subscription removed on destroy");
});
