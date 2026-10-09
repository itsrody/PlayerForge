import test from "node:test";
import assert from "node:assert/strict";

// shouldSkipUrl() reads `location` and `window.top` as bare globals, so each
// case installs them on globalThis and restores them afterwards. The module is
// re-imported per case so no early return can be cached across setups.
function withLocation(href, topHref, run) {
  const savedLocation = globalThis.location;
  const savedTop = globalThis.top;
  const loc = (value) => ({ href: value, hostname: new URL(value).hostname });
  const local = loc(href);
  const topLoc = loc(topHref);
  globalThis.location = local;
  globalThis.top = { location: topLoc };
  globalThis.window = { top: globalThis.top };
  try {
    return run();
  } finally {
    globalThis.location = savedLocation;
    globalThis.top = savedTop;
    globalThis.window = globalThis.window;
  }
}

const check = (href, topHref = href) => async () => {
  const { shouldSkipUrl } = await import("../src/kernel/discovery.js");
  return withLocation(href, topHref, shouldSkipUrl);
};

test("about:blank and data: frames are skipped without a hostname parse", async () => {
  assert.equal(await check("about:blank")(), true);
  assert.equal(await check("data:text/html,<video>")(), true);
});

test("ad and captcha hosts are skipped, including subdomains", async () => {
  assert.equal(await check("https://doubleclick.net/pf")(), true);
  assert.equal(await check("https://ad.doubleclick.net/pf")(), true);
  assert.equal(await check("https://pagead2.googlesyndication.com/pf")(), true);
  assert.equal(await check("https://adservice.google.com/x")(), true);
  assert.equal(await check("https://hcaptcha.com/x")(), true);
  assert.equal(await check("https://www.recaptcha.net/x")(), true);
});

test("an ad domain in the path or query does not skip a real player", async () => {
  // The reason the match is hostname-anchored rather than a substring test
  // over href: these are legitimate pages.
  assert.equal(await check("https://example.com/doubleclick-interview")(), false);
  assert.equal(await check("https://example.com/watch?ref=taboola.com")(), false);
});

test("ordinary hosts are not skipped", async () => {
  assert.equal(await check("https://www.youtube.com/watch?v=1")(), false);
  assert.equal(await check("https://player.vimeo.com/video/1")(), false);
});

test("a cross-origin top frame on an ad host skips the child frame", async () => {
  // The child's own host is clean, but it is a tracking frame under one.
  assert.equal(await check("https://example.com/frame", "https://adnxs.com/track")(), true);
  assert.equal(await check("https://example.com/frame", "https://www.youtube.com/")(), false);
});

test("an unreadable top frame does not skip a clean child frame", async () => {
  // Cross-origin access to window.top.location throws; that must fall through
  // to "do not skip" rather than dropping a real player.
  const { shouldSkipUrl } = await import("../src/kernel/discovery.js");
  const savedLocation = globalThis.location;
  const savedWindow = globalThis.window;
  const hostileTop = {
    get location() {
      throw new Error("Permission denied to access property \"location\"");
    }
  };
  globalThis.location = { href: "https://example.com/frame", hostname: "example.com" };
  globalThis.top = hostileTop;
  globalThis.window = { top: hostileTop };
  try {
    assert.equal(shouldSkipUrl(), false);
  } finally {
    globalThis.location = savedLocation;
    globalThis.window = savedWindow;
  }
});

/* --- installVideoProbe handoff: what surfaced and how --- */

test("a sized video in the parsed DOM hands over a static candidate", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const savedDocument = globalThis.document;
  globalThis.document = dom.window.document;
  Object.defineProperty(dom.window.document, "readyState", { value: "complete", configurable: true });
  try {
    const { installVideoProbe } = await import("../src/kernel/discovery.js");
    const video = dom.window.document.createElement("video");
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
    video.checkVisibility = () => true;
    dom.window.document.body.appendChild(video);

    let handed = null;
    const stop = installVideoProbe({
      minWidth: 100,
      minHeight: 60,
      onCandidate: (hints) => { handed = hints; }
    });
    try {
      assert.ok(handed, "the static sweep finishes synchronously");
      assert.equal(handed.origin, "static");
      assert.equal(handed.videos.length, 1, "what surfaced, in discovery order");
      assert.equal(handed.videos[0].video, video, "identity, not a re-query");
      assert.equal(handed.videos[0].shadow, false);
    } finally {
      stop();
    }
  } finally {
    globalThis.document = savedDocument;
  }
});

test("a media event hands over with a media origin", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const savedDocument = globalThis.document;
  const savedResizeObserver = globalThis.ResizeObserver;
  const savedMutationObserver = globalThis.MutationObserver;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  // The unsized video escalates (observer + gate watch) instead of finishing.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(dom.window.document, "readyState", { value: "complete", configurable: true });
  try {
    const { installVideoProbe } = await import("../src/kernel/discovery.js");
    const video = dom.window.document.createElement("video");
    video.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    video.checkVisibility = () => true;
    dom.window.document.body.appendChild(video);

    let handed = null;
    const stop = installVideoProbe({
      minWidth: 100,
      minHeight: 60,
      onCandidate: (hints) => { handed = hints; }
    });
    try {
      assert.equal(handed, null, "an unsized video does not finish the probe");
      video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
      video.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));
      assert.ok(handed, "the media event finishes it");
      assert.equal(handed.origin, "media");
      assert.equal(handed.videos[0].video, video);
    } finally {
      stop();
    }
  } finally {
    globalThis.document = savedDocument;
    if (savedMutationObserver === undefined) {
      delete globalThis.MutationObserver;
    } else {
      globalThis.MutationObserver = savedMutationObserver;
    }
    if (savedResizeObserver === undefined) {
      delete globalThis.ResizeObserver;
    } else {
      globalThis.ResizeObserver = savedResizeObserver;
    }
  }
});
