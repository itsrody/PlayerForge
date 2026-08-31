import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { ensureViewportFitCover } = await import("../src/shell/chrome/viewport.js");

function makeDom(headHtml = "") {
  const dom = new JSDOM(`<!doctype html><html><head>${headHtml}</head><body></body></html>`, {
    url: "https://www.youtube.com/watch?v=1"
  });
  return dom;
}

function viewportMeta(dom) {
  return dom.window.document.querySelector('meta[name="viewport"]');
}

test("adds a viewport-fit=cover meta when none exists", () => {
  const dom = makeDom();
  ensureViewportFitCover(dom.window.document);
  const meta = viewportMeta(dom);
  assert.ok(meta, "meta created");
  const content = meta.getAttribute("content");
  assert.match(content, /width=device-width/);
  assert.match(content, /viewport-fit=cover/);
});

test("merges viewport-fit=cover into an existing meta that lacks it", () => {
  const dom = makeDom('<meta name="viewport" content="width=device-width, user-scalable=no">');
  ensureViewportFitCover(dom.window.document);
  const content = viewportMeta(dom).getAttribute("content");
  assert.match(content, /width=device-width/);
  assert.match(content, /user-scalable=no/);
  assert.match(content, /viewport-fit=cover/);
});

test("forces viewport-fit=cover over a conflicting fit value", () => {
  const dom = makeDom('<meta name="viewport" content="width=device-width, viewport-fit=contain">');
  ensureViewportFitCover(dom.window.document);
  const content = viewportMeta(dom).getAttribute("content");
  assert.match(content, /viewport-fit=cover/);
  assert.doesNotMatch(content, /viewport-fit=contain/);
});

test("is idempotent - does not duplicate the fit key on repeated calls", () => {
  const dom = makeDom('<meta name="viewport" content="width=device-width">');
  ensureViewportFitCover(dom.window.document);
  ensureViewportFitCover(dom.window.document);
  const content = viewportMeta(dom).getAttribute("content");
  const matches = content.match(/viewport-fit=cover/g) || [];
  assert.equal(matches.length, 1, "fit key present exactly once");
});
