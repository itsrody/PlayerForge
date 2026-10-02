import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findSdkForVideo,
  videoFromEvent,
  meetsMinSize,
  createLayoutGate,
  createOnScreenGate,
  isOnScreen,
  watchMediaEvents,
  MIN_VIDEO_WIDTH,
  MIN_VIDEO_HEIGHT
} from "../src/kernel/sdk.js";

const dom = (html) =>
  new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;

test("adopts each registered SDK via its namespaced anchor", () => {
  const fixtures = [
    ['<div class="jwplayer jw-reset"><video></video></div>', "JW Player"],
    ['<div class="jw-wrapper"><div class="jwplayer"><video></video></div></div>', "JW Player"],
    ['<div data-vjs-player><div class="video-js"><video></video></div></div>', "Video.js"],
    ['<div data-plyr><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>', "Plyr"],
    ['<div class="art-video-player artplayer"><video></video></div>', "ArtPlayer"],
    ['<div class="dplayer"><video></video></div>', "DPlayer"],
    ['<div class="mejs-container mejs-video"><video></video></div>', "MediaElement.js"],
    ['<div class="mejs__container"><video></video></div>', "MediaElement.js"],
    ['<div class="xgplayer xgplayer-desktop"><video></video></div>', "XGPlayer"],
    ['<div class="prism-player"><video></video></div>', "Aliplayer"],
    ['<div class="fluid_video_wrapper fluid_player_layout_default"><video></video></div>', "Fluid Player"],
    ['<div data-player-id="4c522212"><video></video></div>', "Flowplayer"],
    ['<div class="flowplayer is-ready"><video></video></div>', "Flowplayer"],
    ['<div class="fp-player"><div class="fp-ui"></div><video></video></div>', "Flowplayer"],
    ['<div data-player><video></video></div>', "Clappr"],
    ['<media-player><video slot="media"></video></media-player>', "Vidstack"],
    ['<mux-player><video></video></mux-player>', "Mux Player"],
    ['<radiant-media-player><video></video></radiant-media-player>', "Radiant Media Player"]
  ];
  for (const [html, expected] of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    assert.equal(findSdkForVideo(video)?.name, expected, html);
  }
});

test("crosses open shadow boundaries to reach custom-element players", () => {
  for (const tag of ["media-player", "mux-player", "radiant-media-player", "flowplayer-ui"]) {
    const doc = dom(`<${tag}></${tag}>`);
    const player = doc.querySelector(tag);
    const video = doc.createElement("video");
    player.attachShadow({ mode: "open" }).append(video);
    assert.equal(findSdkForVideo(video)?.name, doc.querySelector(tag) && {
      "media-player": "Vidstack",
      "mux-player": "Mux Player",
      "radiant-media-player": "Radiant Media Player",
      "flowplayer-ui": "Flowplayer"
    }[tag], tag);
    assert.equal(findSdkForVideo(video)?.container, player, tag);
  }
});

test("nearest anchor wins regardless of registry order", () => {
  const doc = dom(
    '<div class="jwplayer"><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video)?.name, "Plyr");
  assert.equal(findSdkForVideo(video)?.container, doc.querySelector(".plyr__video-wrapper"));
});

test("registry order breaks ties on a shared anchor element", () => {
  const doc = dom('<div class="dplayer jwplayer"><video></video></div>');
  assert.equal(findSdkForVideo(doc.querySelector("video"))?.name, "JW Player");
});

test("generic player markup stays unrecognized", () => {
  const fixtures = [
    '<div class="player"><video></video></div>',
    '<div class="video-container"><div class="video-wrapper"><video></video></div></div>',
    '<div class="bg-black overflow-hidden select-none"><video></video></div>',
    '<main><video></video></main>',
    '<div id="dplayer-wrapper"><video></video></div>'
  ];
  for (const html of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    assert.equal(findSdkForVideo(video), null, html);
    assert.equal(findSdkForVideo(video)?.container ?? null, null, html);
  }
});

test("findSdkForVideo resolves the nearest matched anchor as the container", () => {
  const doc = dom('<div data-vjs-player><div class="video-js"><video></video></div></div>');
  assert.equal(findSdkForVideo(doc.querySelector("video")).container, doc.querySelector(".video-js"));
});

test("video size gates stay intact", () => {
  assert.equal(MIN_VIDEO_WIDTH, 100);
  assert.equal(MIN_VIDEO_HEIGHT, 60);
});

function sizedVideo(doc, rect) {
  const video = doc.createElement("video");
  video.getBoundingClientRect = () => rect;
  return video;
}

test("meetsMinSize falls back to the rect gate without checkVisibility", () => {
  const doc = dom("");
  assert.equal(meetsMinSize(sizedVideo(doc, { width: 200, height: 100 })), true);
  assert.equal(meetsMinSize(sizedVideo(doc, { width: 50, height: 50 })), false);
});

test("meetsMinSize rejects hidden players before paying for layout", () => {
  const doc = dom("");
  const video = sizedVideo(doc, { width: 800, height: 450 });
  video.checkVisibility = () => false;
  assert.equal(meetsMinSize(video), false, "hidden player rejected despite size");
});

test("meetsMinSize rejects content-visibility:auto skipped players", () => {
  const doc = dom("");
  const video = sizedVideo(doc, { width: 800, height: 450 });
  let seen = null;
  video.checkVisibility = (options) => {
    seen = options;
    return false;
  };
  assert.equal(meetsMinSize(video), false);
  assert.equal(seen.contentVisibilityAuto, true, "contentVisibilityAuto is consulted");
});

test("meetsMinSize still size-gates after a visibility pass", () => {
  const doc = dom("");
  const big = sizedVideo(doc, { width: 800, height: 450 });
  big.checkVisibility = () => true;
  assert.equal(meetsMinSize(big), true, "visible oversized player admitted");

  const small = sizedVideo(doc, { width: 40, height: 40 });
  small.checkVisibility = () => true;
  assert.equal(meetsMinSize(small), false, "visible undersized player still rejected");
});

test("watchMediaEvents taps loadedmetadata, loadeddata and play", () => {
  const doc = dom('<video id="v"></video>');
  const RealDoc = globalThis.document;
  globalThis.document = doc;
  try {
    const seen = [];
    const off = watchMediaEvents((el) => seen.push(el));
    const video = doc.querySelector("video");
    for (const type of ["loadedmetadata", "loadeddata", "play"]) {
      video.dispatchEvent(new (doc.defaultView.Event)(type));
    }
    assert.equal(seen.length, 3, "all three media signals reach the tap");
    assert.equal(seen.every((entry) => entry === video), true);
    off();
    video.dispatchEvent(new (doc.defaultView.Event)("play"));
    assert.equal(seen.length, 3, "teardown silences the tap");
  } finally {
    globalThis.document = RealDoc;
  }
});

test("videoFromEvent prefers an explicit video target", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  assert.equal(videoFromEvent({ target: video }), video);
});

test("videoFromEvent unwraps retargeted shadow events", () => {
  const doc = dom('<div class="host"></div>');
  const host = doc.querySelector(".host");
  const video = doc.createElement("video");
  assert.equal(videoFromEvent({ target: host, composedPath: () => [host, video] }), video);
});

test("videoFromEvent yields null without any video in the path", () => {
  const doc = dom('<div class="host"></div>');
  const host = doc.querySelector(".host");
  assert.equal(videoFromEvent({ target: host, composedPath: () => [host] }), null);
  assert.equal(videoFromEvent({ target: host }), null);
});

test("findSdkForVideo defaults the container to the matched element", () => {
  const doc = dom('<div class="plyr"><video></video></div>');
  const registry = [{ name: "Plyr", anchors: [".plyr"] }];
  assert.equal(findSdkForVideo(doc.querySelector("video"), registry).container, doc.querySelector(".plyr"));
});

test("findSdkForVideo honors a host override targeting an ancestor", () => {
  const doc = dom('<div class="site-player"><div class="plyr"><video></video></div></div>');
  const registry = [{ name: "Plyr", anchors: [".plyr"], host: ".site-player" }];
  assert.equal(
    findSdkForVideo(doc.querySelector("video"), registry).container,
    doc.querySelector(".site-player")
  );
});

test("findSdkForVideo falls back to the matched element when the host selector matches nothing", () => {
  const doc = dom('<div class="plyr"><div class="site-player"><video></video></div></div>');
  const registry = [{ name: "Plyr", anchors: [".plyr"], host: ".missing" }];
  assert.equal(findSdkForVideo(doc.querySelector("video"), registry).container, doc.querySelector(".plyr"));
});

test("findSdkForVideo crosses open shadow boundaries for a host override", () => {
  const doc = dom("<site-player></site-player>");
  const host = doc.querySelector("site-player");
  const wrap = doc.createElement("div");
  wrap.className = "plyr";
  const video = doc.createElement("video");
  wrap.appendChild(video);
  host.attachShadow({ mode: "open" }).append(wrap);
  const registry = [{ name: "Plyr", anchors: [".plyr"], host: "site-player" }];
  assert.equal(findSdkForVideo(video, registry).container, host);
});

test("findSdkForVideo returns a cached descriptor with anchor and hops", () => {
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div>');
  const video = doc.querySelector("video");
  const sdk = findSdkForVideo(video);
  assert.equal(sdk.name, "Plyr");
  assert.equal(sdk.host, null);
  assert.equal(sdk.container, doc.querySelector(".plyr__video-wrapper"));
  // anchor is the actually-matched element; hops = distance video -> anchor.
  assert.equal(sdk.anchor, doc.querySelector(".plyr__video-wrapper"));
  assert.equal(sdk.hops >= 1, true);
  // Every re-query returns the identical cached object - no per-call churn.
  assert.equal(findSdkForVideo(video), sdk);
});

test("findSdkForVideo re-scans a bare video once an SDK wraps it", () => {
  const doc = dom('<div id="host"></div>');
  const video = doc.createElement("video");
  doc.querySelector("#host").appendChild(video);
  // Seen before the SDK builds: remembered as unrecognised for this ancestry.
  assert.equal(findSdkForVideo(video), null);

  // Video.js/MediaElement-style progressive enhancement: the existing <video>
  // node is moved into a newly built SDK container.
  const wrapper = doc.createElement("div");
  wrapper.className = "plyr";
  doc.querySelector("#host").appendChild(wrapper);
  wrapper.appendChild(video);

  assert.equal(findSdkForVideo(video)?.name, "Plyr", "re-parented video is re-detected");
});

test("findSdkForVideo follows a re-parent to the new container", () => {
  const doc = dom('<div class="plyr"><video></video></div>');
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video).container, doc.querySelector(".plyr"));

  // SPA re-render: a fresh wrapper adopts the same video element.
  const next = doc.createElement("div");
  next.className = "plyr";
  doc.body.appendChild(next);
  next.appendChild(video);

  assert.equal(
    findSdkForVideo(video).container,
    next,
    "container tracks the live ancestry instead of a detached node"
  );
});

/** Controllable ResizeObserver so the gate can be driven without a real
 *  layout engine; mirrors the browser by delivering entries with the observer
 *  instance as the second callback argument. */
function fakeResizeObserver() {
  const Real = globalThis.ResizeObserver;
  const state = { cb: null, instance: null, observed: new Set(), observedPeak: 0 };
  class FakeRO {
    constructor(cb) {
      state.cb = cb;
      state.instance = this;
    }
    observe(el) {
      state.observed.add(el);
      state.observedPeak = Math.max(state.observedPeak, state.observed.size);
    }
    unobserve(el) {
      state.observed.delete(el);
    }
    disconnect() {
      state.observed.clear();
    }
  }
  globalThis.ResizeObserver = FakeRO;
  return {
    state,
    emit(entries) {
      state.cb(entries, state.instance);
    },
    restore() {
      globalThis.ResizeObserver = Real;
    }
  };
}

test("createLayoutGate qualifies from the delivered observer box, not a rect read", () => {
  const doc = dom("");
  // The synchronous rect stays tiny; only the observer's box is player-sized,
  // proving the gate reads the observation instead of forcing layout.
  const video = sizedVideo(doc, { width: 10, height: 10 });
  const fake = fakeResizeObserver();
  try {
    let qualified = 0;
    const gate = createLayoutGate({ minWidth: 100, minHeight: 60 });
    gate.watch(video, () => qualified++);
    assert.equal(qualified, 0, "unqualified until an observation arrives");

    fake.emit([{ target: video, contentRect: { width: 200, height: 100 } }]);
    assert.equal(qualified, 1, "qualified from the delivered box");
    assert.equal(fake.state.observed.has(video), false, "qualified target unobserved");

    fake.emit([{ target: video, contentRect: { width: 200, height: 100 } }]);
    assert.equal(qualified, 1, "a qualified element is not re-armed");
    gate.stop();
  } finally {
    fake.restore();
  }
});

test("createLayoutGate ignores a box that fails the CSS-presence check", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  video.checkVisibility = () => false;
  const fake = fakeResizeObserver();
  try {
    let qualified = 0;
    const gate = createLayoutGate({ minWidth: 100, minHeight: 60 });
    gate.watch(video, () => qualified++);
    fake.emit([{ target: video, contentRect: { width: 200, height: 100 } }]);
    assert.equal(qualified, 0, "a hidden box never qualifies");
    assert.equal(fake.state.observed.has(video), true, "still watched for a later reveal");
    gate.stop();
  } finally {
    fake.restore();
  }
});

test("createLayoutGate waits for the delivered box to reach player size", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  const fake = fakeResizeObserver();
  try {
    let qualified = 0;
    const gate = createLayoutGate({ minWidth: 100, minHeight: 60 });
    gate.watch(video, () => qualified++);
    fake.emit([{ target: video, contentRect: { width: 50, height: 30 } }]);
    assert.equal(qualified, 0, "undersized delivered box rejected");
    fake.emit([{ target: video, contentRect: { width: 100, height: 60 } }]);
    assert.equal(qualified, 1, "exactly-at-threshold box qualifies");
    gate.stop();
  } finally {
    fake.restore();
  }
});

test("createLayoutGate dedupes repeat watches per element", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  const fake = fakeResizeObserver();
  try {
    const gate = createLayoutGate();
    gate.watch(video, () => {});
    gate.watch(video, () => {});
    assert.equal(fake.state.observedPeak, 1, "one observe per element");
    gate.stop();
  } finally {
    fake.restore();
  }
});

test("createLayoutGate stop disconnects the observer", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  const fake = fakeResizeObserver();
  try {
    const gate = createLayoutGate();
    gate.watch(video, () => {});
    gate.stop();
    assert.equal(fake.state.observed.size, 0, "stop drops every observed target");
  } finally {
    fake.restore();
  }
});

test("createLayoutGate falls back to the synchronous rect gate without ResizeObserver", () => {
  const Real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined;
  try {
    const doc = dom("");
    let qualified = 0;
    createLayoutGate({ minWidth: 100, minHeight: 60 }).watch(
      sizedVideo(doc, { width: 200, height: 100 }),
      () => qualified++
    );
    assert.equal(qualified, 1, "sized video qualifies immediately");
    createLayoutGate({ minWidth: 100, minHeight: 60 }).watch(
      sizedVideo(doc, { width: 50, height: 50 }),
      () => qualified++
    );
    assert.equal(qualified, 1, "undersized video never qualifies");
  } finally {
    globalThis.ResizeObserver = Real;
  }
});

test("createLayoutGate re-qualifies a content-visibility reveal", () => {
  const doc = dom("");
  const win = doc.defaultView;
  const video = doc.createElement("video");
  doc.body.appendChild(video);
  let rect = { width: 10, height: 10 };
  video.getBoundingClientRect = () => rect;
  const fake = fakeResizeObserver();
  const RealDoc = globalThis.document;
  const realWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = win;
  try {
    let qualified = 0;
    const gate = createLayoutGate({ minWidth: 100, minHeight: 60 });
    gate.watch(video, () => qualified++);
    assert.equal(qualified, 0, "unqualified until a signal arrives");
    // The reveal changes layout but delivers no ResizeObserver entry (the
    // placeholder box was already non-zero); the native event is the signal.
    rect = { width: 200, height: 100 };
    video.dispatchEvent(new win.Event("contentvisibilityautostatechange"));
    assert.equal(qualified, 1, "reveal event re-qualifies");
    assert.equal(fake.state.observed.has(video), false, "qualified target unobserved");
    gate.stop();
  } finally {
    fake.restore();
    globalThis.document = RealDoc;
    globalThis.window = realWindow;
  }
});

test("createLayoutGate ignores a reveal that is still undersized", () => {
  const doc = dom("");
  const win = doc.defaultView;
  const video = doc.createElement("video");
  doc.body.appendChild(video);
  video.getBoundingClientRect = () => ({ width: 10, height: 10 });
  const fake = fakeResizeObserver();
  const RealDoc = globalThis.document;
  const realWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = win;
  try {
    let qualified = 0;
    const gate = createLayoutGate({ minWidth: 100, minHeight: 60 });
    gate.watch(video, () => qualified++);
    video.dispatchEvent(new win.Event("contentvisibilityautostatechange"));
    assert.equal(qualified, 0, "an undersized reveal never qualifies");
    assert.equal(fake.state.observed.has(video), true, "still watched for a later reveal");
    gate.stop();
  } finally {
    fake.restore();
    globalThis.document = RealDoc;
    globalThis.window = realWindow;
  }
});

test("isOnScreen is permissive when no viewport size is resolvable", () => {
  const doc = dom("");
  const video = sizedVideo(doc, { top: 9000, bottom: 9020, left: 0, right: 300 });
  const realWindow = globalThis.window;
  globalThis.window = undefined;
  try {
    assert.equal(isOnScreen(video), true, "unknown viewport defers to present");
  } finally {
    globalThis.window = realWindow;
  }
});

test("isOnScreen defers below-the-fold but honors the lookahead margin", () => {
  const doc = dom("");
  const realWindow = globalThis.window;
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  try {
    const below = sizedVideo(doc, { top: 2000, bottom: 2020, left: 0, right: 300 });
    assert.equal(isOnScreen(below), false, "far below the viewport");
    const near = sizedVideo(doc, { top: 1000, bottom: 1020, left: 0, right: 300 });
    assert.equal(isOnScreen(near), true, "within the lookahead margin");
    const onscreen = sizedVideo(doc, { top: 100, bottom: 400, left: 0, right: 300 });
    assert.equal(isOnScreen(onscreen), true, "inside the viewport");
  } finally {
    globalThis.window = realWindow;
  }
});

/** Controllable IntersectionObserver mirroring the browser's entry callback. */
function fakeIntersectionObserver() {
  const Real = globalThis.IntersectionObserver;
  const state = { cb: null, observed: new Set() };
  class FakeIO {
    constructor(cb) {
      state.cb = cb;
    }
    observe(el) {
      state.observed.add(el);
    }
    unobserve(el) {
      state.observed.delete(el);
    }
    disconnect() {
      state.observed.clear();
    }
  }
  globalThis.IntersectionObserver = FakeIO;
  return {
    state,
    emit(entries) {
      state.cb(entries);
    },
    restore() {
      globalThis.IntersectionObserver = Real;
    }
  };
}

test("createOnScreenGate defers until the first intersection, once per element", () => {
  const doc = dom("");
  const video = doc.createElement("video");
  const fake = fakeIntersectionObserver();
  try {
    let entered = 0;
    const gate = createOnScreenGate();
    gate.watch(video, () => entered++);
    gate.watch(video, () => entered++);
    assert.equal(entered, 0, "off-screen defers");
    assert.equal(fake.state.observed.has(video), true, "watched for entry");

    fake.emit([{ target: video, isIntersecting: false }]);
    assert.equal(entered, 0, "a non-intersecting entry never fires");
    fake.emit([{ target: video, isIntersecting: true }]);
    assert.equal(entered, 1, "fires once on entry");
    assert.equal(fake.state.observed.has(video), false, "unobserved after entry");
    gate.stop();
  } finally {
    fake.restore();
  }
});

test("createOnScreenGate passes straight through without IntersectionObserver", () => {
  const Real = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = undefined;
  try {
    let entered = 0;
    createOnScreenGate().watch({}, () => entered++);
    assert.equal(entered, 1, "no observer - eager behavior preserved");
  } finally {
    globalThis.IntersectionObserver = Real;
  }
});
