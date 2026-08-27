import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// load the module fresh per test so the cached style-load state resets
async function loadInject() {
  const { ensureStyles } = await import(`../src/shell/chrome/inject.js?t=${Date.now()}`);
  return ensureStyles;
}

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.CSSStyleSheet = class {
    constructor() {
      this.css = null;
      this.synced = false;
    }
    replaceSync(css) {
      this.css = css;
      this.synced = true;
    }
  };
  const appends = [];
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    set: (v) => appends.push(v),
    get: () => (appends.length ? appends[appends.length - 1] : []),
    configurable: true
  });
  return { dom, appends };
}

test("ensureStyles loads styles from the @resource text when available", async () => {
  const { appends } = setupDom();
  globalThis.GM_getResourceText = async () => ".pf-shell{}";
  const ensureStyles = await loadInject();
  const sheet = await ensureStyles();

  assert.ok(sheet, "style sheet created");
  assert.equal(sheet.css, ".pf-shell{}", "replaceSync got resource css");
  assert.ok(sheet.synced, "replaceSync called");
  assert.equal(appends.length, 1, "stylesheet adopted once");
  delete globalThis.GM_getResourceText;
});

test("ensureStyles falls back to embedded css when the resource fetch fails", async () => {
  setupDom();
  globalThis.GM_getResourceText = async () => {
    throw new Error("offline");
  };
  const ensureStyles = await loadInject();
  const sheet = await ensureStyles();
  assert.ok(sheet.synced, "fallback sheet synced");
  delete globalThis.GM_getResourceText;
});

test("ensureStyles falls back to embedded css when GM_getResourceText is absent", async () => {
  setupDom();
  delete globalThis.GM_getResourceText;
  const ensureStyles = await loadInject();
  const sheet = await ensureStyles();
  assert.ok(sheet.synced, "fallback sheet synced");
});

test("ensureStyles is idempotent across callers", async () => {
  setupDom();
  delete globalThis.GM_getResourceText;
  const ensureStyles = await loadInject();
  const a = ensureStyles();
  const b = ensureStyles();
  assert.equal(a, b, "same cached promise returned");
  assert.equal(await a, await b, "same sheet resolved");
});
