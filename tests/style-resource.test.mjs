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

test("resource upgrade is deferred until browser idle, not applied on fetch", async () => {
  setupDom(".pf-shell{}");
  // Controllable idle scheduler: park callbacks until the test pumps them,
  // mirroring the real `{ timeout }` contract where a served-free frame fires
  // the callback and the browser force-fires it by didTimeout past the cap.
  const idle = [];
  globalThis.requestIdleCallback = (cb, opts) => {
    idle.push({ cb, opts });
    return idle.length;
  };
  try {
    const { warmStyles, ensureStyles } = await loadInject();
    const live = warmStyles();
    const pending = ensureStyles();
    // Let the fetch resolve; the swap must NOT run while main thread stays busy.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(live.css, "", "upgrade kept in idle, not applied on fetch resolve");
    assert.equal(idle.length, 1, "idle callback registered exactly once");
    assert.equal(idle[0].opts.timeout, 1500, "didTimeout cap parked the swap");
    idle[0].cb({ didTimeout: false, timeRemaining: () => 50 });
    const sheet = await pending;
    assert.equal(sheet, live, "same sheet instance upgraded at idle");
    assert.equal(live.css, ".pf-shell{}", "replaceSync ran only once idle arrived");
  } finally {
    delete globalThis.requestIdleCallback;
  }
});

test("the timeout cap force-fires the upgrade when idle never arrives", async () => {
  setupDom(".pf-shell{}");
  const idle = [];
  globalThis.requestIdleCallback = (cb, opts) => {
    idle.push({ cb, opts });
    return idle.length;
  };
  try {
    const { warmStyles, ensureStyles } = await loadInject();
    const live = warmStyles();
    const pending = ensureStyles();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No turn ever frees up; the browser's timeout obligation fires with
    // didTimeout=true (the `{ timeout: 1500 }` contract) so the parcel is
    // never stranded waiting for idle that won't come.
    idle[0].cb({ didTimeout: true, timeRemaining: () => 0 });
    const sheet = await pending;
    assert.equal(sheet, live, "timeout-forced fire completed the upgrade");
    assert.equal(live.css, ".pf-shell{}", "swap applied via the didTimeout fire");
  } finally {
    delete globalThis.requestIdleCallback;
  }
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
