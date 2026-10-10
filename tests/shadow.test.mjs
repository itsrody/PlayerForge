import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/"
});
globalThis.window = window;
globalThis.document = window.document;

const { deepestActiveElement, eventHitsControl } = await import("../src/shared/shadow.js");

test("focus on the shadow host itself reports the host, not null", () => {
  // A null inner focus used to walk the pierce loop past the host into
  // null, contradicting isInsideShell's own "or is the host itself" and
  // costing host-focused players their keyboard-ranking focus bonus.
  const host = document.createElement("div");
  host.tabIndex = -1;
  host.attachShadow({ mode: "open" });
  document.body.appendChild(host);
  host.focus();
  try {
    assert.equal(deepestActiveElement(host), host);
  } finally {
    host.remove();
  }
});

test("focus inside the shadow reports the inner element", () => {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  shadow.appendChild(button);
  document.body.appendChild(host);
  button.focus();
  try {
    assert.equal(deepestActiveElement(host), button);
  } finally {
    host.remove();
  }
});

test("light-DOM focus passes document.activeElement through", () => {
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  try {
    assert.equal(deepestActiveElement(null), button);
  } finally {
    button.remove();
  }
});

test("a native-controls video counts as SDK chrome", () => {
  // The UA renders native controls in a closed shadow: taps target the
  // video, so without this the bare-surface rules would own a stream meant
  // for native UI. Registry players never carry the attribute.
  const plain = document.createElement("video");
  const controlled = document.createElement("video");
  controlled.setAttribute("controls", "");
  const pathFor = (video) => ({ composedPath: () => [video] });
  assert.equal(eventHitsControl(pathFor(plain)), false, "bare video stays a gesture surface");
  assert.equal(eventHitsControl(pathFor(controlled)), true, "native controls route natively");
});
