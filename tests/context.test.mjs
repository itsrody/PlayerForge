import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  getDomainKey,
  domainsMatch,
  domainScore,
  hashEntry,
  ownPageContext,
  getPageContext,
  createTopFrameResponder,
  createFrameRelay,
  installContextBridge,
  requestFullscreenProvision,
  createTopFrameProvisioner,
  createFrameProvisioner,
  FS_REQUEST_TYPE,
  CTX_REQUEST_TYPE,
  CTX_RESPONSE_TYPE,
  CTX_REQUEST_TIMEOUT_MS
} from "../src/shared/context.js";
import { installVideoProbe } from "../src/kernel/probe.js";
import { installWaapiShim } from "./waapi-shim.mjs";

const dom = (html = "", url = "https://www.youtube.com/watch?v=1") => {
  const jsdom = new JSDOM(`<!doctype html><html><head><title>Page</title></head><body>${html}</body></html>`, { url });
  // jsdom validates addEventListener's `signal` option against its own
  // AbortSignal class, so the production AbortController bindings must resolve
  // to the current window's constructor rather than Node's.
  globalThis.AbortController = jsdom.window.AbortController;
  // The probe (installVideoProbe) gates adoption via meetsMinSize ->
  // checkVisibility() (FF-native); jsdom lacks it, so shim the window.
  installWaapiShim(jsdom.window);
  return jsdom;
};

test("getDomainKey reduces hostnames to registrable keys", () => {
  assert.equal(getDomainKey("www.youtube.com"), "youtube");
  assert.equal(getDomainKey("example.co.uk"), "example");
  assert.equal(getDomainKey("a.b.museum.org"), "museum");
  assert.equal(getDomainKey("localhost"), "localhost");
  assert.equal(getDomainKey("192.168.1.5"), "192-168-1-5");
  assert.equal(getDomainKey("[2001:db8::1]"), "2001-db8-1");
  assert.equal(getDomainKey("[::1]"), "1");
  assert.equal(getDomainKey(""), "");
  assert.equal(getDomainKey("web82518x.faselhdx.life"), "faselhdx");
  assert.equal(getDomainKey("foo.bar.site"), "bar");
  assert.equal(getDomainKey("a.b.work"), "b");
  assert.equal(getDomainKey("a.b.tech"), "b");
  assert.equal(getDomainKey("a.b.club"), "b");
});

test("getDomainKey treats unlisted gTLDs as suffixes instead of keys", () => {
  // No .basketball in the curated TLD lists: the walk must step up one label
  // instead of collapsing every registrable domain under the suffix label.
  assert.equal(getDomainKey("a.basketball"), "a");
  assert.equal(getDomainKey("sub.a.basketball"), "a");
  assert.equal(getDomainKey("b.basketball"), "b");
  assert.notEqual(getDomainKey("a.basketball"), getDomainKey("b.basketball"));
  assert.equal(getDomainKey("a.basketball"), getDomainKey("sub.a.basketball"));
});

test("hashEntry is deterministic and duration-rounding aware", () => {
  assert.equal(hashEntry("yt", "/watch", 611.2), hashEntry("yt", "/watch", 610.9));
  assert.notEqual(hashEntry("yt", "/watch", 611), hashEntry("yt", "/watch", 612));
  assert.notEqual(hashEntry("yt", "/watch", 100), hashEntry("yt", "/other", 100));
  // The domain participates: same path+duration on two sites differ.
  assert.notEqual(hashEntry("yt", "/watch", 600), hashEntry("vimeo", "/watch", 600));
});

test("domainsMatch accepts equality and label boundaries only", () => {
  assert.equal(domainsMatch("youtube", "youtube"), true);
  assert.equal(domainsMatch("tv.apple", "apple"), true);
  assert.equal(domainsMatch("apple", "tv.apple"), true);
  assert.equal(domainsMatch("", "apple"), false);
  assert.equal(domainsMatch("notyoutube", "youtube"), false);
  assert.equal(domainsMatch("espnw", "espn"), false);
});

test("domainScore ranks without fuzzy promotion", () => {
  assert.equal(domainScore("youtube", "youtube"), 3);
  assert.equal(domainScore("tv.apple", "apple"), 2);
  assert.equal(domainScore("youtub", "youtube"), 2);
  assert.equal(domainScore("xyz", "youtube"), 0);
  assert.equal(domainScore("", "youtube"), 0);
});

test("getPageContext reads the top window directly", async () => {
  const { window } = dom("<p>hi</p>");
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.deepEqual(context, { domain: "youtube", path: "/watch", title: "Page" });
});

test("getPageContext strips non-Latin scripts but keeps typographic punctuation", async () => {
  const { window } = dom("");
  window.document.title = "Arabic Text فلم here | more عربي stuff";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "Arabic Text here | more stuff");
});

test("getPageContext keeps hyphen in mixed-script titles", async () => {
  const { window } = dom("");
  window.document.title = " التلاعب بالخيوط Pull Strings - الحلقة 1 ";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "Pull Strings - 1");
});

test("getPageContext strips bracketed tags and dash-prefixed tags from titles", async () => {
  const { window } = dom("");
  window.document.title = "Show-Name [Reducing Mosaic] -Uncensored-Leaked [English Subtitle] - Episode 1";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "Show-Name - Episode 1");
});

test("getPageContext keeps a leading recording-code bracket and strips its qualifier", async () => {
  const { window } = dom("");
  window.document.title = "[MIMK-278-SUBS] Repentance";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "[MIMK-278] Repentance");
});

test("getPageContext trims any qualifier off the leading code bracket (e.g. [C-123-MR])", async () => {
  const { window } = dom("");
  window.document.title = "[ABC-123-MR] Episode Title";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "[ABC-123] Episode Title");
});

test("getPageContext keeps a plain leading code bracket with no qualifier", async () => {
  const { window } = dom("");
  window.document.title = "[ABC-123] A Show";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "[ABC-123] A Show");
});

test("getPageContext does not strip title words separated by dash-space", async () => {
  const { window } = dom("");
  window.document.title = "My-Show - Episode 1 - Something";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "My-Show - Episode 1 - Something");
});

test("getPageContext keeps original when title is entirely non-ASCII", async () => {
  const { window } = dom("");
  window.document.title = "فلم عربي كامل";
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.document = window.document;
  const context = await getPageContext();
  assert.equal(context.title, "فلم عربي كامل");
});

test("ownPageContext resolves context from the given window without a bridge", () => {
  const { window: win } = dom("<p>hi</p>");
  assert.deepEqual(ownPageContext(win), { domain: "youtube", path: "/watch", title: "Page" });
});

// jsdom's `window.top` is non-configurable, so an unreachable ancestor is
// simulated with a Proxy whose `top` exposes only an unreadable location
// (SecurityError), exactly like a cross-origin top from inside a frame.
const crossOriginFrame = (win) => new Proxy(win, {
  get(target, prop, receiver) {
    if (prop === "top") {
      const opaque = {};
      Object.defineProperty(opaque, "location", {
        get() {
          const err = new Error("cross-origin top");
          err.name = "SecurityError";
          throw err;
        }
      });
      return opaque;
    }
    return Reflect.get(target, prop, receiver);
  }
});

test("getPageContext bridges through a parent when the top frame is unreachable", async () => {
  const { window: win } = dom("<p>hi</p>");
  globalThis.window = crossOriginFrame(win);
  globalThis.location = win.location;
  globalThis.document = win.document;

  let requestNonce = null;
  const originalPost = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = (msg) => { requestNonce = msg.nonce; };
  try {
    const contextPromise = getPageContext();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(requestNonce, "bridge request posted to the parent");

    win.dispatchEvent(new win.MessageEvent("message", {
      data: { type: CTX_RESPONSE_TYPE, nonce: requestNonce, domain: "hub", path: "/legal", title: "Legal Co" },
      origin: "https://hub.test",
      source: win.parent
    }));

    assert.deepEqual(await contextPromise, { domain: "hub", path: "/legal", title: "Legal Co" });
  } finally {
    win.parent.postMessage = originalPost;
  }
});

test("getPageContext dedupes in-flight bridge requests across callers", async () => {
  const { window: win } = dom();
  globalThis.window = crossOriginFrame(win);
  globalThis.location = win.location;
  globalThis.document = win.document;

  let requests = 0;
  let requestNonce = null;
  const originalPost = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = (msg) => { requests++; requestNonce = msg.nonce; };
  try {
    const t0 = getPageContext();
    const t1 = getPageContext();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests, 1, "concurrent shells share one bridge round-trip");

    win.dispatchEvent(new win.MessageEvent("message", {
      data: { type: CTX_RESPONSE_TYPE, nonce: requestNonce, domain: "hub", path: "/", title: "Hub" },
      origin: "https://hub.test",
      source: win.parent
    }));

    const [c0, c1] = await Promise.all([t0, t1]);
    assert.deepEqual(c0, { domain: "hub", path: "/", title: "Hub" });
    assert.deepEqual(c1, c0);
  } finally {
    win.parent.postMessage = originalPost;
  }
});

test("getPageContext falls back to the frame's own context when no frame answers", async () => {
  const { window: win } = dom("<p>hi</p>");
  globalThis.window = crossOriginFrame(win);
  globalThis.location = win.location;
  globalThis.document = win.document;

  const originalPost = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = () => {}; // no ancestor ever answers
  try {
    const context = await getPageContext();
    assert.deepEqual(context, ownPageContext(win), "bridgeless embeds resume from their own frame");
  } finally {
    win.parent.postMessage = originalPost;
  }
});

test("top-frame responder validates shape and answers with fresh context", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const iframe = win.document.createElement("iframe");
  win.document.body.append(iframe);
  let sent = null;
  const post = (source, msg, target) => { sent = { msg, target, source }; };

  let calls = 0;
  const respond = createTopFrameResponder(() => {
    calls++;
    return { domain: "example", path: "/v/1", title: "T" };
  }, "https://site.test", post);

  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "n1" }, origin: "https://embed.net", source: iframe.contentWindow });
  assert.equal(calls, 1);
  assert.equal(sent.source, iframe.contentWindow);
  assert.deepEqual(sent.msg, { type: CTX_RESPONSE_TYPE, nonce: "n1", domain: "example", path: "/v/1", title: "T" });
  assert.equal(sent.target, "https://embed.net");

  sent = null; calls = 0;
  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "n4" }, origin: "https://site.test", source: {} });
  assert.equal(calls, 1);

  sent = null;
  respond({ data: { type: CTX_REQUEST_TYPE }, origin: "https://embed.net", source: iframe.contentWindow });
  respond({ data: { type: "other", nonce: "n2" }, origin: "https://embed.net", source: iframe.contentWindow });
  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "n3" }, origin: "https://embed.net", source: null });
  respond(null);
  assert.equal(sent, null);
});

test("top-frame responder rejects foreign frames on foreign origins", () => {
  let sent = null;
  const stranger = { postMessage: (msg) => { sent = msg; } };
  const respond = createTopFrameResponder(() => ({ domain: "x", path: "/", title: "" }), "https://site.test");
  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "nx" }, origin: "https://evil.test", source: stranger });
  assert.equal(sent, null);
});

test("top-frame responder vouches for grandchildren through readable frame trees", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.document = win.document;

  // child iframe with its own nested grandchild - jsdom documents stay
  // same-origin readable, mirroring an accessible middle layer. The blank
  // frame document exists synchronously after insertion.
  const child = win.document.createElement("iframe");
  const grandchild = win.document.createElement("iframe");
  win.document.body.append(child);
  child.contentDocument.body.append(grandchild);

  let sent = null;
  const post = (source, msg, target) => { sent = { msg, target, source }; };
  const respond = createTopFrameResponder(() => ({ domain: "x", path: "/", title: "" }), "https://site.test", post);

  // Grandchild is not a direct iframe child but sits in the visible tree.
  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "g1" }, origin: "https://embed.net", source: grandchild.contentWindow });
  assert.equal(sent.source, grandchild.contentWindow);
  assert.equal(sent.msg.nonce, "g1");

  // A stranger window still gets nothing.
  sent = null;
  respond({ data: { type: CTX_REQUEST_TYPE, nonce: "g2" }, origin: "https://evil.test", source: { postMessage() {} } });
  assert.equal(sent, null);
});

test("frame relay forwards own-child requests up and routes answers back down", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const childFrame = win.document.createElement("iframe");
  win.document.body.append(childFrame);
  const child = childFrame.contentWindow;

  let relayedUp = null;
  const originalPost = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = (msg, target) => { relayedUp = { msg, target }; };
  const originalChildPost = child.postMessage.bind(child);
  child.postMessage = (msg, target) => { child.sent = { msg, target }; };

  try {
    const relay = createFrameRelay();

    relay({ data: { type: CTX_REQUEST_TYPE, nonce: "r1" }, origin: "https://kid.test", source: child });
    assert.deepEqual(relayedUp.msg, { type: CTX_REQUEST_TYPE, nonce: "r1" });

    // Answers are only accepted from the parent this hop relayed to.
    const answer = { type: CTX_RESPONSE_TYPE, nonce: "r1", domain: "site", path: "/", title: "" };
    const impostor = { postMessage: () => { throw new Error("impostor answered"); } };
    relay({ data: answer, origin: "https://top.test", source: impostor });
    assert.equal(child.sent, undefined);

    relay({ data: answer, origin: "https://top.test", source: win.parent });
    assert.deepEqual(child.sent.msg, { type: CTX_RESPONSE_TYPE, nonce: "r1", domain: "site", path: "/", title: "" });
    assert.equal(child.sent.target, "https://kid.test");

    child.sent = null;
    relay({ data: { type: CTX_RESPONSE_TYPE, nonce: "unknown", domain: "site", path: "/", title: "" }, origin: "https://top.test", source: win.parent });
    assert.equal(child.sent, null);

    // A request from a window this document does not host is dropped entirely.
    relayedUp = null;
    relay({ data: { type: CTX_REQUEST_TYPE, nonce: "rx" }, origin: "https://evil.test", source: { postMessage() {} } });
    assert.equal(relayedUp, null);
  } finally {
    win.parent.postMessage = originalPost;
    child.postMessage = originalChildPost;
  }
});

test("nested relays address every down-leg with its own requester origin", () => {
  // Chain under test, all origins distinct:
  //   leaf(kid) -> relayInner -> inner window -> relayOuter -> top
  // The top answer must reach the leaf with targetOrigin "kid" at the final
  // hop even though every upstream leg carries foreign origins. Windows are
  // REAL jsdom frames (leaf inside the inner document, inner window inside the
  // outer document) so each relay's own-child vouch legitimately passes.
  const { window: outerWin } = dom();
  const innerNode = outerWin.document.createElement("iframe");
  outerWin.document.body.append(innerNode);
  const innerWin = innerNode.contentWindow;
  const leafNode = innerWin.document.createElement("iframe");
  innerWin.document.body.append(leafNode);
  const leaf = leafNode.contentWindow;

  const setGlobals = (win) => {
    globalThis.window = win;
    globalThis.parent = win.parent;
    globalThis.location = win.location;
    globalThis.document = win.document;
  };

  const outerUp = [];
  const innerUp = [];
  const originalOuterPost = outerWin.postMessage.bind(outerWin);
  const originalInnerPost = innerWin.postMessage.bind(innerWin);
  outerWin.postMessage = (msg, target) => { outerUp.push({ msg, target }); };
  innerWin.postMessage = (msg, target) => { innerUp.push({ msg, target }); };

  try {
    const relayOuter = createFrameRelay();
    const relayInner = createFrameRelay();

    // Leaf asks up through the inner relay (inner globals active). Vouched:
    // leaf is a direct <iframe> child of the inner document. The hop forwards
    // to innerWin.parent (the outer window) - captured in outerUp.
    setGlobals(innerWin);
    const request = { type: CTX_REQUEST_TYPE, nonce: "nn" };
    relayInner({ data: request, origin: "https://kid.test", source: leaf });
    assert.equal(outerUp.length, 1);
    assert.deepEqual(outerUp[0].msg, request);

    // Inner window's message arrives at the outer relay - reactivate the outer
    // globals first, since relays read window.parent per event.
    setGlobals(outerWin);
    relayOuter({ data: request, origin: "https://inner.test", source: innerWin });
    assert.equal(outerUp.length, 2, "outer relay forwarded to its own parent");

    // Top answers; each relay routes down with the origin it stored per hop.
    const answer = { type: CTX_RESPONSE_TYPE, nonce: "nn", domain: "site", path: "/", title: "" };
    relayOuter({ data: answer, origin: "https://top.test", source: outerWin.parent });
    assert.equal(innerUp.length, 1);
    assert.equal(innerUp[0].target, "https://inner.test");

    setGlobals(innerWin);
    const originalLeafPost = leaf.postMessage.bind(leaf);
    leaf.postMessage = (msg, target) => { leaf.sent = { msg, target }; };
    relayInner({ data: answer, origin: "https://inner.test", source: innerWin.parent });
    assert.equal(leaf.sent.target, "https://kid.test");
    assert.deepEqual(leaf.sent.msg, answer);
    leaf.postMessage = originalLeafPost;
  } finally {
    innerWin.postMessage = originalInnerPost;
    outerWin.postMessage = originalOuterPost;
  }
});

test("installContextBridge registers a top-frame message listener", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.document = win.document;

  let captured = null;
  win.addEventListener("message", (event) => { captured = event; });

  const stop = installContextBridge();

  const request = new win.MessageEvent("message", {
    data: { type: CTX_REQUEST_TYPE, nonce: "z9" },
    origin: "null",
    source: win
  });
  win.dispatchEvent(request);
  assert.ok(captured);

  stop();
});

test("presence probe fires once on the first qualifying insertion", async () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.MutationObserver = win.MutationObserver;

  let fires = 0;
  installVideoProbe({ minWidth: 0, minHeight: 0, onCandidate: () => fires++ });

  win.document.body.append(win.document.createElement("video"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fires, 1);

  win.document.body.append(win.document.createElement("video"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fires, 1);
});

test("stopped presence probe never fires", async () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.MutationObserver = win.MutationObserver;

  let fires = 0;
  const stop = installVideoProbe({ minWidth: 0, minHeight: 0, onCandidate: () => fires++ });
  stop();

  win.document.body.append(win.document.createElement("video"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fires, 0);
});

test("video-less documents never open a mutation observer", async () => {
  const { window: win } = dom("<p>no player here</p>", "https://example.com/article");
  globalThis.window = win;
  globalThis.document = win.document;

  // Instrument: any full-document observer dom-watch would create shows up here.
  const RealMO = win.MutationObserver;
  let constructions = 0;
  class CountingMO extends RealMO {
    constructor(cb) {
      super(cb);
      constructions++;
    }
  }
  globalThis.MutationObserver = CountingMO;
  win.MutationObserver = CountingMO;

  let fires = 0;
  installVideoProbe({ minWidth: 100, minHeight: 60, onCandidate: () => fires++ });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(fires, 0, "no candidate on a video-less page");
  assert.equal(constructions, 0, "two-phase probe stays in cheap phase - no observer opened");
});

test("a present-but-small video commits the probe to the observer", async () => {
  const { window: win } = dom("<video></video>", "https://example.com/player");
  globalThis.window = win;
  globalThis.document = win.document;

  const RealMO = win.MutationObserver;
  let constructions = 0;
  class CountingMO extends RealMO {
    constructor(cb) {
      super(cb);
      constructions++;
    }
  }
  globalThis.MutationObserver = CountingMO;
  win.MutationObserver = CountingMO;

  let fires = 0;
  // min sizes above jsdom's always-0 rect -> the static video never qualifies,
  // so the probe escalates (opens the observer) rather than closing early.
  installVideoProbe({ minWidth: 100, minHeight: 60, onCandidate: () => fires++ });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fires, 0, "no candidate - video never reaches player size");
  assert.ok(constructions >= 1, "present video escalated the probe to the observer");
});

test("context timeout constant stays sane", () => {
  assert.ok(CTX_REQUEST_TIMEOUT_MS >= 1000 && CTX_REQUEST_TIMEOUT_MS <= 10000);
});

test("requestFullscreenProvision posts a provisioning request to the parent", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  let sent = null;
  const original = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = (msg, target) => { sent = { msg, target }; };
  try {
    requestFullscreenProvision();
    assert.deepEqual(sent.msg, { type: FS_REQUEST_TYPE });
    // Granting is a one-shot, idempotent operation per frame: repeat calls
    // must not replay the hops.
    sent = null;
    requestFullscreenProvision();
    requestFullscreenProvision();
    assert.equal(sent, null);
  } finally {
    win.parent.postMessage = original;
  }
});

test("top-frame provisioner grants allowfullscreen on the direct child only and halts", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const child = win.document.createElement("iframe");
  win.document.body.append(child);

  let forwarded = false;
  const original = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = () => { forwarded = true; };
  try {
    const provision = createTopFrameProvisioner();

    provision({ data: { type: FS_REQUEST_TYPE }, source: child.contentWindow, origin: "https://kid.test" });
    assert.equal(child.hasAttribute("allowfullscreen"), true);
    assert.match(child.getAttribute("allow"), /\bfullscreen\b/);
    // The forwarded flag must stay false: the top frame has no parent to relay to.
    assert.equal(forwarded, false);
  } finally {
    win.parent.postMessage = original;
  }
});

test("top-frame provisioner ignores a foreign window not owned by this document", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const stranger = { postMessage() {} };
  const provision = createTopFrameProvisioner();
  provision({ data: { type: FS_REQUEST_TYPE }, source: stranger, origin: "https://evil.test" });
  assert.equal(win.document.querySelectorAll("iframe").length, 0);
});

test("relay provisioner grants on its child then forwards up to the parent", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const videoFrame = win.document.createElement("iframe");
  win.document.body.append(videoFrame);

  let relayed = null;
  const original = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = (msg, target) => { relayed = { msg, target }; };
  try {
    const provision = createFrameProvisioner();
    provision({ data: { type: FS_REQUEST_TYPE }, source: videoFrame.contentWindow, origin: "https://video.test" });
    assert.equal(videoFrame.hasAttribute("allowfullscreen"), true);
    assert.match(videoFrame.getAttribute("allow"), /\bfullscreen\b/);
    assert.deepEqual(relayed.msg, { type: FS_REQUEST_TYPE });
  } finally {
    win.parent.postMessage = original;
  }
});

test("relay provisioner does not forward for an unowned source", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  let relayed = false;
  const original = win.parent.postMessage.bind(win.parent);
  win.parent.postMessage = () => { relayed = true; };
  try {
    const provision = createFrameProvisioner();
    provision({ data: { type: FS_REQUEST_TYPE }, source: { postMessage() {} }, origin: "https://evil.test" });
    assert.equal(relayed, false);
  } finally {
    win.parent.postMessage = original;
  }
});

test("granting is idempotent and merges into an existing allow list", () => {
  const { window: win } = dom();
  globalThis.window = win;
  globalThis.parent = win.parent;
  globalThis.location = win.location;
  globalThis.document = win.document;

  const child = win.document.createElement("iframe");
  child.setAttribute("allow", "autoplay");
  win.document.body.append(child);

  const provision = createTopFrameProvisioner();
  provision({ data: { type: FS_REQUEST_TYPE }, source: child.contentWindow });
  provision({ data: { type: FS_REQUEST_TYPE }, source: child.contentWindow });

  assert.equal(child.hasAttribute("allowfullscreen"), true);
  const tokens = child.getAttribute("allow").split(/\s+/);
  assert.ok(tokens.includes("autoplay"));
  assert.equal(tokens.filter((t) => t === "fullscreen").length, 1);
});
