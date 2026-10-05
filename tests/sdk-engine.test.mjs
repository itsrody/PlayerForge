import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findSdkForVideo,
  findContainer,
  resolveContainer,
  videoFromEvent,
  meetsMinSize,
  forEachVideoInMutations,
  forEachShadowVideos,
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
  assert.equal(sdk.container, findContainer(video));
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

test("re-parenting into an SDK invalidates the negative memo", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div data-vjs-player id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findSdkForVideo(video), null, "precondition: unregistered to start");

  doc.querySelector("#target").append(video);
  assert.equal(findSdkForVideo(video).name, "Video.js", "stale null survived re-parenting");
});

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

test("a negative memo is re-checked after the video is detached entirely", () => {
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
