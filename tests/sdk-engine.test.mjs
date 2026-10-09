import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findSdkForVideo,
  findGenericPlayer,
  fingerprintFor,
  matchPrints,
  resolveContainer,
  videoFromEvent,
  meetsMinSize,
  forEachVideoInMutations,
  forEachShadowVideos,
  MIN_VIDEO_WIDTH,
  MIN_VIDEO_HEIGHT
} from "../src/kernel/sdk.js";

/** The descriptor's container field: what findContainer used to return. */
const containerOf = (video) => findSdkForVideo(video)?.container ?? null;

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
    ['<radiant-media-player><video></video></radiant-media-player>', "Radiant Media Player"],
    ['<div class="shaka-video-container"><video data-shaka-player></video></div>', "Shaka Player"],
    ['<div data-shaka-player-container><video></video></div>', "Shaka Player"],
    ['<div class="theoplayer-container"><video></video></div>', "THEOplayer"],
    ['<theoplayer-ui><video></video></theoplayer-ui>', "THEOplayer"],
    ['<theoplayer-default-ui><video></video></theoplayer-default-ui>', "THEOplayer"],
    ['<div class="plyr"><video data-plyr-config=\'{"title": "x"}\'></video></div>', "Plyr"],
    ['<video-js><video></video></video-js>', "Video.js"]
  ];
  for (const [html, expected] of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    assert.equal(findSdkForVideo(video)?.name, expected, html);
  }
});

test("a re-skinned fork still resolves through its behavioral anchors", () => {
  // No .plyr, .video-js or .vjs-* chrome classes anywhere: a fork that
  // restyled everything but kept each SDK's own functional markers.
  const plyrFork = dom('<div class="acme-player"><video data-plyr-config=\'{"title": "x"}\'></video></div>');
  assert.equal(findSdkForVideo(plyrFork.querySelector("video"))?.name, "Plyr");
  // .vjs-tech is written onto the video by the player constructor itself, so
  // it matches at hop 0 even with the wrapper fully renamed.
  const vjsFork = dom('<div class="acme-player"><video class="vjs-tech"></video></div>');
  assert.equal(findSdkForVideo(vjsFork.querySelector("video"))?.name, "Video.js");
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
    assert.equal(containerOf(video), player, tag);
  }
});

test("nearest anchor wins regardless of registry order", () => {
  const doc = dom(
    '<div class="jwplayer"><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video)?.name, "Plyr");
  assert.equal(containerOf(video), doc.querySelector(".plyr__video-wrapper"));
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
    '<div id="dplayer-wrapper"><video></video></div>',
    // Framework app shells are never SDK anchors: Inertia marks every page
    // root with data-page, so these claimed every video on the page (and
    // resolved the container to the app root) until the record was dropped.
    '<div id="app" data-page="{}"><div><video></video></div></div>',
    '<div data-page="{}"><div><article><video></video></article></div></div>'
  ];
  for (const html of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    assert.equal(findSdkForVideo(video), null, html);
    assert.equal(containerOf(video), null, html);
  }
});

test("the descriptor container is the nearest matched anchor", () => {
  const doc = dom('<div data-vjs-player><div class="video-js"><video></video></div></div>');
  assert.equal(containerOf(doc.querySelector("video")), doc.querySelector(".video-js"));
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

test("meetsMinSize still size-gates after a visibility pass", () => {
  const doc = dom("");
  const big = sizedVideo(doc, { width: 800, height: 450 });
  big.checkVisibility = () => true;
  assert.equal(meetsMinSize(big), true, "visible oversized player admitted");

  const small = sizedVideo(doc, { width: 40, height: 40 });
  small.checkVisibility = () => true;
  assert.equal(meetsMinSize(small), false, "visible undersized player still rejected");
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
  assert.equal(sdk.container, containerOf(video));
  // anchor is the actually-matched element; hops = distance video -> anchor.
  assert.equal(sdk.anchor, doc.querySelector(".plyr__video-wrapper"));
  assert.equal(sdk.hops >= 1, true);
  // Every re-query returns the identical cached object - no per-call churn.
  assert.equal(findSdkForVideo(video), sdk);
});

test("the memo survives a re-query that changes nothing", () => {
  const doc = dom('<div class="dplayer"><video></video></div>');
  const video = doc.querySelector("video");
  const first = findSdkForVideo(video);
  // Warm the positive memo, then re-query: freshness must not re-wrap, or the
  // "same object per video" contract above silently regressed into a re-scan.
  assert.equal(findSdkForVideo(video), first);
  assert.equal(findSdkForVideo(video), first);
});

test("re-parenting out of an SDK invalidates the positive memo", () => {
  const doc = dom(
    '<div class="dplayer"><div id="slot"><video></video></div></div>' +
    '<div class="plain"><div id="target"></div></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video).name, "DPlayer");

  // Same element, new ancestry: the WeakMap key survives, so an unvalidated
  // memo would keep reporting the wrapper the video just left.
  doc.querySelector("#target").append(video);
  assert.equal(findSdkForVideo(video), null, "stale descriptor survived re-parenting");
});

test("re-parenting into an SDK is detected on re-query", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div data-vjs-player id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video), null, "precondition: unregistered to start");

  doc.querySelector("#target").append(video);
  assert.equal(findSdkForVideo(video).name, "Video.js", "stale null survived re-parenting");
});

test("a subtree grafted under an SDK is detected on re-query", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div class="dplayer" id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video), null, "precondition: unregistered to start");

  // Move the video AND its parent together: the direct parent never changes,
  // so a parent-only freshness check keeps reporting the stale null for the
  // life of the document while the video sits inside a real player.
  doc.querySelector("#target").append(doc.querySelector("#slot"));
  assert.equal(findSdkForVideo(video)?.name, "DPlayer", "stale null survived a subtree graft");
});

test("a graft that adds no SDK still answers null", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div class="plain" id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video), null);

  doc.querySelector("#target").append(doc.querySelector("#slot"));
  assert.equal(findSdkForVideo(video), null, "a graft without an SDK must not resurrect a match");
});

/* - SDK-independent slow path - */

/**
 * Installs the navigator for the generic path and restores it after: Node's
 * own navigator has no userActivation, which reads as "not activated" - the
 * safe direction - so every generic case below installs the activated shape
 * explicitly.
 */
function withActivation(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const fake = value
    ? { userActivation: { hasBeenActive: true, isActive: false } }
    : undefined;
  Object.defineProperty(globalThis, "navigator", {
    value: fake, writable: true, configurable: true
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
    } else {
      delete globalThis.navigator;
    }
  }
}

/** A playing, sized video in a similar-sized wrapper: the qualifying shape. */
function genericFixture({ wrapperRect = { width: 640, height: 360 }, videoRect = { width: 640, height: 360 }, paused = false } = {}) {
  const doc = dom('<div id="player"><video></video></div>');
  const wrapper = doc.querySelector("#player");
  const video = doc.querySelector("video");
  wrapper.getBoundingClientRect = () => ({ ...wrapperRect, top: 0, left: 0, right: wrapperRect.width, bottom: wrapperRect.height });
  video.getBoundingClientRect = () => ({ ...videoRect, top: 0, left: 0, right: videoRect.width, bottom: videoRect.height });
  Object.defineProperty(video, "paused", { value: paused, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  return { doc, wrapper, video };
}

test("a positive memo is invalidated when the matched wrapper is replaced in place", () => {
  // The parent check alone cannot see this one: the video's own parent is
  // untouched, so only re-verifying the anchor at its recorded hop catches it.
  const doc = dom('<div id="slot"><div class="dplayer"><video></video></div></div>');
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video).name, "DPlayer");

  const slot = doc.querySelector("#slot");
  slot.textContent = "";
  slot.append(video);

  assert.equal(findSdkForVideo(video), null, "stale descriptor survived wrapper replacement");
});

test("detachment rescans to null without throwing", () => {
  const doc = dom('<div class="plain"><video></video></div>');
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video), null);

  video.remove();
  assert.equal(findSdkForVideo(video), null, "detachment must not throw or resurrect a match");
});

test("forEachVideoInMutations reaches a video inside an added host's open shadow root", () => {
  const doc = dom("");
  const host = doc.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const video = doc.createElement("video");
  shadow.appendChild(video);

  const found = [];
  forEachVideoInMutations([{ addedNodes: [host] }], (v) => found.push(v));
  assert.deepEqual(found, [video], "the shadow-hosted video was discovered");
});

test("forEachVideoInMutations reaches a shadow video when only the light wrapper is added", () => {
  // The live repro shape: the mutation record carries the light wrapper the
  // page appended; the host and its shadow video hang somewhere below it.
  const doc = dom("");
  const wrap = doc.createElement("div");
  wrap.className = "plyr";
  wrap.setAttribute("data-plyr", "");
  const host = doc.createElement("x-holder");
  wrap.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const video = doc.createElement("video");
  shadow.appendChild(video);

  const found = [];
  forEachVideoInMutations([{ addedNodes: [wrap] }], (v) => found.push(v));
  assert.deepEqual(found, [video], "the deep shadow video was discovered");
});

test("forEachVideoInMutations descends into nested shadow roots", () => {
  const doc = dom("");
  const outer = doc.createElement("x-outer");
  const outerShadow = outer.attachShadow({ mode: "open" });
  const inner = doc.createElement("x-inner");
  outerShadow.appendChild(inner);
  const innerShadow = inner.attachShadow({ mode: "open" });
  const video = doc.createElement("video");
  innerShadow.appendChild(video);

  const found = [];
  forEachVideoInMutations([{ addedNodes: [outer] }], (v) => found.push(v));
  assert.deepEqual(found, [video], "the depth-2 shadow video was discovered");
});

test("closed shadow roots stay out of the walk", () => {
  const doc = dom("");
  const host = doc.createElement("x-closed");
  const shadow = host.attachShadow({ mode: "closed" });
  const video = doc.createElement("video");
  shadow.appendChild(video);

  const found = [];
  forEachVideoInMutations([{ addedNodes: [host] }], (v) => found.push(v));
  assert.deepEqual(found, [], "closed roots are unreachable by design");
});

test("forEachVideoInMutations keeps its light-DOM behavior and element guard", () => {
  const doc = dom("");
  const direct = doc.createElement("video");
  const wrap = doc.createElement("div");
  const inner = doc.createElement("video");
  wrap.appendChild(inner);

  const found = [];
  forEachVideoInMutations(
    [{ addedNodes: [doc.createTextNode("x"), direct, wrap] }],
    (v) => found.push(v)
  );
  assert.deepEqual(found, [direct, inner], "direct and light-descendant videos still visit; text skipped");
});

test("forEachShadowVideos sweeps shadow trees and leaves light videos to the caller", () => {
  // Split contract: the light qSA("video") pass belongs to the call site
  // (present in all three shipped callers), so this helper must return only
  // what that pass cannot see.
  const doc = dom('<video></video>');
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const shadowVideo = doc.createElement("video");
  shadow.appendChild(shadowVideo);

  const found = [];
  forEachShadowVideos(doc, (v) => found.push(v));
  assert.deepEqual(found, [shadowVideo], "only the shadow video, not the light one");
});

test("findSdkForVideo matches an SDK anchor across a shadow boundary", () => {
  const doc = dom('<div data-plyr><div class="plyr__video-wrapper"><x-holder></x-holder></div></div>');
  const host = doc.querySelector("x-holder");
  const shadow = host.attachShadow({ mode: "open" });
  const video = doc.createElement("video");
  shadow.appendChild(video);

  const match = findSdkForVideo(video);
  assert.equal(match?.name, "Plyr", "composed chain crossed the boundary via .host");
  assert.equal(match?.container, doc.querySelector(".plyr__video-wrapper"), "container resolves in the light tree");
});

test("a playing video with no record qualifies generically on an activated page", () => {
  const { wrapper, video } = genericFixture();
  withActivation(true, () => {
    const sdk = findGenericPlayer(video);
    assert.equal(sdk?.name, "Custom player");
    assert.equal(sdk?.container, wrapper, "the similar-sized wrapper hosts the shell");
    assert.equal(sdk?.hops, 1);
    assert.equal(sdk?.host, null);
  });
});

test("the generic path climbs nested similar wrappers to the outermost", () => {
  const doc = dom('<div id="outer"><div id="mid"><video></video></div></div>');
  const outer = doc.querySelector("#outer");
  const video = doc.querySelector("video");
  const box = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  outer.getBoundingClientRect = () => box(640, 360);
  doc.querySelector("#mid").getBoundingClientRect = () => box(640, 360);
  video.getBoundingClientRect = () => box(640, 360);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  withActivation(true, () => {
    const sdk = findGenericPlayer(video);
    assert.equal(sdk?.container, outer, "the outermost player-like box wins");
    assert.equal(sdk?.hops, 2);
  });
});

test("a diverging parent refuses generic placement", () => {
  // A video sitting directly in a layout context (here 4x wider) has no
  // player-like box to host the shell - claim nothing rather than the page.
  const { video } = genericFixture({
    wrapperRect: { width: 2560, height: 1440 },
    videoRect: { width: 640, height: 360 }
  });
  withActivation(true, () => {
    assert.equal(findGenericPlayer(video), null);
  });
});

test("a video directly under body has no generic container", () => {
  const doc = dom("<video></video>");
  const video = doc.querySelector("video");
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  doc.body.appendChild(video);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  withActivation(true, () => {
    assert.equal(findGenericPlayer(video), null, "full-bleed ambient video is not a player");
  });
});

test("the generic path stays off without sticky activation", () => {
  const { video } = genericFixture();
  withActivation(false, () => {
    assert.equal(findGenericPlayer(video), null, "autoplay ads on fresh pages never qualify");
  });
});

test("the generic path stays off for paused video", () => {
  const { video } = genericFixture({ paused: true });
  withActivation(true, () => {
    assert.equal(findGenericPlayer(video), null, "poster frames and paused embeds never qualify");
  });
});

test("full-bleed and off-viewport video refuse generic placement", () => {
  // jsdom reports no viewport (clientWidth 0), so these branches need one.
  const doc = dom('<div id="player"><video></video></div>');
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1280, configurable: true });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 720, configurable: true });
  const wrapper = doc.querySelector("#player");
  const video = doc.querySelector("video");
  wrapper.getBoundingClientRect = () => ({ width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 });
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  withActivation(true, () => {
    video.getBoundingClientRect = () => ({ width: 1280, height: 700, top: 0, left: 0, right: 1280, bottom: 700 });
    assert.equal(findGenericPlayer(video), null, "ambient full-bleed background is not a player");
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 2000, left: 0, right: 640, bottom: 2360 });
    assert.equal(findGenericPlayer(video), null, "below-fold video waits for a viewport crossing");
  });
});

test("a zero-size wrapper is skipped, not adopted or blocking", () => {
  // display:contents wrappers report a zero box while the video inside them
  // renders. Adopting one hosts the shell in a box nobody can see - yet the
  // climb must continue past it, because stopping there strands the real
  // player box above it just the same.
  const doc = dom('<div id="outer"><div id="mid"><video></video></div></div>');
  const video = doc.querySelector("video");
  const box = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  doc.querySelector("#outer").getBoundingClientRect = () => box(2000, 1200);
  doc.querySelector("#mid").getBoundingClientRect = () => box(0, 0);
  video.getBoundingClientRect = () => box(640, 360);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  withActivation(true, () => {
    // The layout context above diverges, so there is no player-like box:
    // refuse, instead of adopting the invisible middle one.
    assert.equal(findGenericPlayer(video), null);
  });
});

test("the climb continues past a zero-size wrapper to a real box", () => {
  const doc = dom('<div id="outer"><div id="mid"><video></video></div></div>');
  const outer = doc.querySelector("#outer");
  const video = doc.querySelector("video");
  const box = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  outer.getBoundingClientRect = () => box(640, 360);
  doc.querySelector("#mid").getBoundingClientRect = () => box(0, 0);
  video.getBoundingClientRect = () => box(640, 360);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  withActivation(true, () => {
    const sdk = findGenericPlayer(video);
    assert.equal(sdk?.container, outer, "the zero box is passed through, not adopted");
    assert.equal(sdk?.hops, 2, "the depth cap still covers the true chain");
  });
});

/* - Learned fingerprints - */

test("fingerprintFor records tag, classes, id and depth", () => {
  const doc = dom('<div id="player" class="player wide"><video></video></div>');
  const wrapper = doc.querySelector("#player");
  const video = doc.querySelector("video");
  assert.deepEqual(fingerprintFor(video, wrapper, 2), {
    tag: "div",
    cls: ["player", "wide"],
    id: "player",
    depth: 2
  });
});

test("matchPrints resolves the recorded container", () => {
  const doc = dom('<div id="player" class="player"><video></video></div>');
  const wrapper = doc.querySelector("#player");
  const video = doc.querySelector("video");
  const hit = matchPrints(video, fingerprintFor(video, wrapper, 1));
  assert.equal(hit?.el, wrapper);
  assert.equal(hit?.hops, 1);
});

test("matchPrints tolerates state classes gained later", () => {
  const doc = dom('<div class="player"><video></video></div>');
  const wrapper = doc.querySelector("div");
  const video = doc.querySelector("video");
  const print = fingerprintFor(video, wrapper, 1);
  wrapper.classList.add("playing", "open");
  assert.equal(matchPrints(video, print)?.el, wrapper, "subset still matches after state churn");
});

test("matchPrints refuses dropped markers, moved depth and wrong tags", () => {
  const doc = dom('<div class="player"><div id="slot"><video></video></div></div>');
  const video = doc.querySelector("video");
  const print = fingerprintFor(video, doc.querySelector("#slot"), 1);
  doc.querySelector("#slot").removeAttribute("id");
  assert.equal(matchPrints(video, print), null, "a dropped marker is a different player");
  assert.equal(matchPrints(video, { tag: "section", cls: [], id: null, depth: 1 }), null);
  assert.equal(matchPrints(video, { tag: "div", cls: [], id: null, depth: 5 }), null);
});

test("matchPrints rejects malformed prints without throwing", () => {
  const doc = dom('<div><video></video></div>');
  const video = doc.querySelector("video");
  for (const bad of [null, undefined, [], "div", { tag: "div" }, { tag: "div", cls: "x", depth: 1 }]) {
    assert.equal(matchPrints(video, bad), null);
  }
});

test("the fallback admits only player-sized boxes, not thumbnails", () => {
  // The anchorless guess pays for its uncertainty with a stricter box than
  // the registry's 100x60: preview tiles and spacers stay out.
  const doc = dom('<div id="tile"><video></video></div><div id="player"><video></video></div>');
  const tile = doc.querySelector("#tile video");
  const player = doc.querySelector("#player video");
  const box = (w, h) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h });
  doc.querySelector("#tile").getBoundingClientRect = () => box(150, 90);
  tile.getBoundingClientRect = () => box(150, 90);
  doc.querySelector("#player").getBoundingClientRect = () => box(640, 360);
  player.getBoundingClientRect = () => box(640, 360);
  for (const video of [tile, player]) {
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    Object.defineProperty(video, "ended", { value: false, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }
  withActivation(true, () => {
    assert.equal(findGenericPlayer(tile), null, "a 150px tile is not a player");
    assert.ok(findGenericPlayer(player), "a 640px player still qualifies");
  });
});
