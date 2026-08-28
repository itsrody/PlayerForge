import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { iconMarkup, createIconElement } = await import("../src/shell/chrome/icons.js");

function makeDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://example.com/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

test("iconMarkup returns an svg string for a known icon", () => {
  makeDom();
  const markup = iconMarkup("play");
  assert.ok(typeof markup === "string");
  assert.ok(markup.startsWith('<svg'));
  assert.match(markup, /viewBox="0 0 512 512"/);
  assert.match(markup, /<path d="/);
});

test("iconMarkup resolves aliases to the canonical icon", () => {
  makeDom();
  assert.equal(iconMarkup("gear"), iconMarkup("settings"));
  assert.equal(iconMarkup("playing"), iconMarkup("pause"));
});

test("iconMarkup returns null for an unknown icon", () => {
  makeDom();
  assert.equal(iconMarkup("does-not-exist"), null);
});

test("every icon markup carries aria-hidden, focusable=false, and the pf-icon class", () => {
  makeDom();
  for (const name of ["volume-1", "play", "captions", "settings", "trash", "lock", "reload", "fullscreen", "resume", "color", "link"]) {
    const markup = iconMarkup(name);
    assert.ok(markup, `icon ${name} exists`);
    assert.match(markup, /aria-hidden="true"/, `${name}: aria-hidden`);
    assert.match(markup, /focusable="false"/, `${name}: focusable`);
    assert.match(markup, /class="pf-icon"/, `${name}: pf-icon class`);
  }
});

test("createIconElement clones cached elements and returns detached copies", () => {
  const dom = makeDom();
  const a = createIconElement("settings");
  const b = createIconElement("settings");
  assert.ok(a instanceof dom.window.SVGElement || a instanceof dom.window.Element, "svg element returned");
  assert.notEqual(a, b, "each call returns a fresh clone");
  assert.equal(a.ownerDocument, dom.window.document, "element belongs to the target document");
});

test("createIconElement returns null for unknown icons", () => {
  makeDom();
  assert.equal(createIconElement("nope"), null);
});

test("createIconElement and iconMarkup agree on the icon set via aliases", () => {
  makeDom();
  const el = createIconElement("down");
  assert.ok(el, "alias 'down' resolves");
  assert.equal(iconMarkup("down"), iconMarkup("chevron-down"));
});
