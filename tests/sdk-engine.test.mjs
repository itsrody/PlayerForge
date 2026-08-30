import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  findSdkForVideo,
  findContainer,
  resolveContainer,
  videoFromEvent,
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

test("findSdkForVideo returns a structured descriptor with container and host", () => {
  const doc = dom('<div class="plyr__video-wrapper"><video></video></div>');
  const video = doc.querySelector("video");
  const sdk = findSdkForVideo(video);
  assert.equal(sdk.name, "Plyr");
  assert.equal(sdk.host, null);
  assert.equal(sdk.container, findContainer(video));
});
