import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findSdkForVideo,
  findContainer,
  resolveContainer,
  videoFromEvent,
  meetsMinSize,
  createLayoutGate,
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
    assert.equal(findContainer(video), player, tag);
  }
});

test("nearest anchor wins regardless of registry order", () => {
  const doc = dom(
    '<div class="jwplayer"><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video)?.name, "Plyr");
  assert.equal(findContainer(video), doc.querySelector(".plyr__video-wrapper"));
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
    assert.equal(findContainer(video), null, html);
  }
});

test("findContainer returns the nearest matched anchor", () => {
  const doc = dom('<div data-vjs-player><div class="video-js"><video></video></div></div>');
  assert.equal(findContainer(doc.querySelector("video")), doc.querySelector(".video-js"));
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

test("resolveContainer defaults to the matched element without a host override", () => {
  const doc = dom('<div class="plyr__video-wrapper"><video></video></div>');
  const el = doc.querySelector(".plyr__video-wrapper");
  assert.equal(resolveContainer({ record: { name: "Plyr" }, el }), el);
});

test("resolveContainer honors a host override targeting an ancestor", () => {
  const doc = dom('<div class="site-player"><div class="plyr"><video></video></div></div>');
  const el = doc.querySelector(".plyr");
  const host = doc.querySelector(".site-player");
  assert.equal(resolveContainer({ record: { name: "Plyr", host: ".site-player" }, el }), host);
});

test("resolveContainer falls back to the matched element when host is absent", () => {
  const doc = dom('<div class="plyr"><div class="site-player"><video></video></div></div>');
  const el = doc.querySelector(".plyr");
  assert.equal(resolveContainer({ record: { name: "Plyr", host: ".missing" }, el }), el);
});

test("resolveContainer crosses open shadow boundaries for a host override", () => {
  const doc = dom("<site-player></site-player>");
  const host = doc.querySelector("site-player");
  const video = doc.createElement("video");
  host.attachShadow({ mode: "open" }).append(video);
  assert.equal(resolveContainer({ record: { name: "Plyr", host: "site-player" }, el: video }), host);
});

test("findSdkForVideo returns a cached descriptor with anchor and hops", () => {
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div>');
  const video = doc.querySelector("video");
  const sdk = findSdkForVideo(video);
  assert.equal(sdk.name, "Plyr");
  assert.equal(sdk.host, null);
  assert.equal(sdk.container, findContainer(video));
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
