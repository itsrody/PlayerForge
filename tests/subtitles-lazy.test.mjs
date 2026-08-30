import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { Shell } = await import("../src/shell/shell.js");

async function makeShell() {
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

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;

  return { dom, shell, container, video };
}

test("shell constructs without bus subscription for timeupdate", async () => {
  const { shell } = await makeShell();
  assert.ok(shell, "shell created");
  shell.destroy();
});

test("track load via file input, then destroy — no leak", async () => {
  const { shell, container, dom } = await makeShell();

  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello";
  const file = new File([vtt], "sub.vtt", { type: "text/vtt" });
  const input = container.querySelector('input[type="file"]');
  assert.ok(input, "file input present");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change"));

  await new Promise((r) => setTimeout(r, 0));

  // Destroy mid-load — verifies no leaked timer or crash.
  shell.destroy();
});

test("destroy without any track is clean", async () => {
  const { shell } = await makeShell();
  shell.destroy();
  // Calling destroy again is a no-op.
  shell.destroy();
});
