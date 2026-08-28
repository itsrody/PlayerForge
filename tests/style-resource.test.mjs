import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// load the module fresh per test so the cached style-load state resets
async function loadInject() {
  const { warmStyles, ensureStyles } = await import(`../src/shell/chrome/inject.js?t=${Date.now()}`);
  return { warmStyles, ensureStyles };
}

function setupDom(resourceCss) {
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
  if (resourceCss !== undefined) {
    globalThis.GM_getResourceText = async (name) => {
      if (name === "pfStyle") {
        return resourceCss;
      }
      throw new Error("unknown resource");
    };
  } else {
    delete globalThis.GM_getResourceText;
  }
  const appends = [];
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    set: (v) => appends.push(v),
    get: () => (appends.length ? appends[appends.length - 1] : []),
    configurable: true
  });
  return { dom, appends };
}

test("warmStyles applies embedded css synchronously (no network block)", async () => {
  const { appends } = setupDom(".pf-other{}");
  const { warmStyles } = await loadInject();
  const sheet = warmStyles();
  // Synchronous: live sheet returned immediately without awaiting the resource.
  assert.ok(sheet.synced, "embedded sheet synced synchronously");
  assert.equal(sheet.css, "", "embedded css is the empty-string test-hook value");
  assert.equal(appends.length, 1, "sheet adopted into the document synchronously");
});

test("resource text upgrades the embedded sheet in place", async () => {
  setupDom(".pf-shell{}");
  const { warmStyles, ensureStyles } = await loadInject();
  const live = warmStyles();
  assert.equal(live.css, "", "starts with embedded css");
  const authoritative = await ensureStyles();
  assert.equal(authoritative, live, "upgrade happens on the SAME sheet instance");
  assert.equal(live.css, ".pf-shell{}", "replaceSync upgraded in place, adopted refs update");
});

test("ensureStyles falls back to embedded css when the resource fetch fails", async () => {
  setupDom(null);
  globalThis.GM_getResourceText = async () => {
    throw new Error("offline");
  };
  const { warmStyles, ensureStyles } = await loadInject();
  warmStyles();
  const sheet = await ensureStyles();
  assert.ok(sheet.synced, "fallback sheet synced");
  assert.equal(sheet.css, "", "kept embedded css on failure");
});

test("ensureStyles falls back to embedded css when GM_getResourceText is absent", async () => {
  setupDom(undefined);
  const { warmStyles, ensureStyles } = await loadInject();
  warmStyles();
  const sheet = await ensureStyles();
  assert.ok(sheet.synced, "fallback sheet synced");
});

test("ensureStyles is idempotent across callers", async () => {
  setupDom(undefined);
  const { warmStyles, ensureStyles } = await loadInject();
  const a = warmStyles();
  const b = warmStyles();
  assert.equal(a, b, "same cached sheet returned");
  assert.equal(await ensureStyles(), a, "same authoritative sheet resolved");
  assert.equal(await ensureStyles(), a, "repeated ensureStyles stable");
});

test("empty @resource text never clobbers the embedded sheet", async () => {
  setupDom("");
  const { warmStyles, ensureStyles } = await loadInject();
  warmStyles();
  const sheet = await ensureStyles();
  assert.equal(sheet.css, "", "kept embedded css when resource is empty");
});

test("whitespace-only @resource text is rejected (no blank upgrade)", async () => {
  setupDom("   \n\t  ");
  const { warmStyles, ensureStyles } = await loadInject();
  warmStyles();
  const sheet = await ensureStyles();
  assert.equal(sheet.css, "", "whitespace-only resource left embedded css intact");
});

test("malformed @resource text that throws on replaceSync keeps embedded css", async () => {
  setupDom(".pf-shell{}");
  // Fail only the SECOND replaceSync (the resource upgrade, not the trusted
  // embedded sync at warmStyles()): simulates invalid CSS the sheet rejects.
  const original = globalThis.CSSStyleSheet.prototype.replaceSync;
  let calls = 0;
  globalThis.CSSStyleSheet.prototype.replaceSync = function (css) {
    calls++;
    if (calls === 1) {
      return original.call(this, css);
    }
    throw new Error("invalid css");
  };
  try {
    const { warmStyles, ensureStyles } = await loadInject();
    warmStyles();
    const sheet = await ensureStyles();
    assert.equal(sheet.css, "", "failed replaceSync preserved embedded css");
  } finally {
    globalThis.CSSStyleSheet.prototype.replaceSync = original;
  }
});
