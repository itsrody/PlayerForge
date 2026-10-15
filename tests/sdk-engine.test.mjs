import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  surveyVideos,
  templateAnchors,
  templateCustomTags,
  resolvePlayer,
  findPlayerForVideo,
  videoFromEvent,
  meetsMinSize,
  rectMeetsMinSize,
  forEachVideoInMutations,
  forEachShadowVideos,
  watchVisibilityOffers,
  MIN_VIDEO_WIDTH,
  MIN_VIDEO_HEIGHT
} from "../src/kernel/sdk.js";

/** The descriptor's container field: what findContainer used to return. */
const containerOf = (video) => findPlayerForVideo(video)?.container ?? null;

const dom = (html) =>
  new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;

test("adopts each framework shape through its structural anchors", () => {
  // [markup, container selector, hops]: the same corpus the named registry
  // used to pin, now asserting placement instead of identity. No names
  // anywhere - the table carries shapes, and the descriptor carries the
  // matched element, not which row it came from.
  const fixtures = [
    ['<div class="jwplayer jw-reset"><video></video></div>', ".jwplayer", 1],
    ['<div class="jw-wrapper"><div class="jwplayer"><video></video></div></div>', ".jwplayer", 1],
    ['<div data-vjs-player><div class="video-js"><video></video></div></div>', ".video-js", 1],
    ['<div data-plyr><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>', ".plyr__video-wrapper", 1],
    ['<div class="art-video-player artplayer"><video></video></div>', ".art-video-player", 1],
    ['<div class="dplayer"><video></video></div>', ".dplayer", 1],
    ['<div class="mejs-container mejs-video"><video></video></div>', ".mejs-container", 1],
    ['<div class="mejs__container"><video></video></div>', ".mejs__container", 1],
    ['<div class="xgplayer xgplayer-desktop"><video></video></div>', ".xgplayer", 1],
    ['<div class="prism-player"><video></video></div>', ".prism-player", 1],
    ['<div class="fluid_video_wrapper fluid_player_layout_default"><video></video></div>', ".fluid_video_wrapper", 1],
    ['<div data-player-id="4c522212"><video></video></div>', "[data-player-id]", 1],
    ['<div class="flowplayer is-ready"><video></video></div>', ".flowplayer", 1],
    ['<div class="fp-player"><div class="fp-ui"></div><video></video></div>', ".fp-player", 1],
    ['<div data-player><video></video></div>', "[data-player]", 1],
    ['<media-player><video slot="media"></video></media-player>', "media-player", 1],
    ['<mux-player><video></video></mux-player>', "mux-player", 1],
    ['<radiant-media-player><video></video></radiant-media-player>', "radiant-media-player", 1],
    ['<div class="shaka-video-container"><video data-shaka-player></video></div>', "video", 0],
    ['<div data-shaka-player-container><video></video></div>', "[data-shaka-player-container]", 1],
    ['<div class="theoplayer-container"><video></video></div>', ".theoplayer-container", 1],
    ['<theoplayer-ui><video></video></theoplayer-ui>', "theoplayer-ui", 1],
    ['<theoplayer-default-ui><video></video></theoplayer-default-ui>', "theoplayer-default-ui", 1],
    ['<div class="plyr"><video data-plyr-config=\'{"title": "x"}\'></video></div>', "video", 0],
    ['<video-js><video></video></video-js>', "video-js", 1]
  ];
  for (const [html, selector, hops] of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    const player = findPlayerForVideo(video);
    assert.ok(player, html);
    assert.equal(player.container, doc.querySelector(selector), `${html} container`);
    assert.equal(player.hops, hops, `${html} hops`);
  }
});

test("descriptors carry structural labels, not names", () => {
  const doc = dom('<div class="jwplayer jw-reset"><video></video></div>');
  assert.equal(findPlayerForVideo(doc.querySelector("video")).label, "div.jwplayer.jw-reset");
  const tag = dom('<video-js><video></video></video-js>');
  assert.equal(findPlayerForVideo(tag.querySelector("video")).label, "video-js");
  const bare = dom('<div class="player"><video></video></div>');
  assert.equal(findPlayerForVideo(bare.querySelector("video")), null);
});

test("a re-skinned fork still resolves through its behavioral anchors", () => {
  // No .plyr, .video-js or .vjs-* chrome classes anywhere: a fork that
  // restyled everything but kept each framework's own functional markers.
  const plyrFork = dom('<div class="acme-player"><video data-plyr-config=\'{"title": "x"}\'></video></div>');
  const plyrVideo = plyrFork.querySelector("video");
  assert.equal(findPlayerForVideo(plyrVideo)?.container, plyrVideo, "hop-0 data anchor wins");
  assert.equal(findPlayerForVideo(plyrVideo)?.hops, 0);
  // .vjs-tech is written onto the video by the player constructor itself, so
  // it matches at hop 0 even with the wrapper fully renamed.
  const vjsFork = dom('<div class="acme-player"><video class="vjs-tech"></video></div>');
  const vjsVideo = vjsFork.querySelector("video");
  assert.equal(findPlayerForVideo(vjsVideo)?.container, vjsVideo);
});

test("crosses open shadow boundaries to reach custom-element players", () => {
  for (const tag of ["media-player", "mux-player", "radiant-media-player", "flowplayer-ui"]) {
    const doc = dom(`<${tag}></${tag}>`);
    const player = doc.querySelector(tag);
    const video = doc.createElement("video");
    player.attachShadow({ mode: "open" }).append(video);
    const found = findPlayerForVideo(video);
    assert.ok(found, tag);
    assert.equal(found.container, player, tag);
  }
});

test("nearest anchor wins regardless of template order", () => {
  const doc = dom(
    '<div class="jwplayer"><div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div></div>'
  );
  const video = doc.querySelector("video");
  assert.ok(findPlayerForVideo(video));
  assert.equal(containerOf(video), doc.querySelector(".plyr__video-wrapper"));
});

test("template order breaks ties on a shared anchor element", () => {
  const doc = dom('<div class="dplayer jwplayer"><video></video></div>');
  const found = findPlayerForVideo(doc.querySelector("video"));
  assert.equal(found.container, doc.querySelector("div"));
  assert.equal(found.hops, 1);
});

test("framework-free markup stays unmatched", () => {
  const fixtures = [
    '<div class="player"><video></video></div>',
    '<div class="video-container"><div class="video-wrapper"><video></video></div></div>',
    '<div class="bg-black overflow-hidden select-none"><video></video></div>',
    '<main><video></video></main>',
    '<div id="dplayer-wrapper"><video></video></div>',
    // Framework app shells are never template anchors: Inertia marks every page
    // root with data-page, so these claimed every video on the page (and
    // resolved the container to the app root) until the record was dropped.
    '<div id="app" data-page="{}"><div><video></video></div></div>',
    '<div data-page="{}"><div><article><video></video></article></div></div>'
  ];
  for (const html of fixtures) {
    const doc = dom(html);
    const video = doc.querySelector("video");
    assert.equal(findPlayerForVideo(video), null, html);
    assert.equal(containerOf(video), null, html);
  }
});

/**
 * Bespoke Tailwind player on a site-ruled host: no template anchors
 * anywhere (the 71stream embed shape - utilities, Lucide icons, Inertia
 * shell), resolved by the host+path gate to the video's own wrapper.
 * Documents carry their own URL here because the rule reads the video's
 * document, never a global.
 */
function bespokeEmbedDoc(url) {
  return new JSDOM(`<!doctype html><html><body>
    <div id="app" data-page='{"component":"Video/Embed"}'>
      <div class="w-full h-full bg-black relative overflow-hidden select-none text-white group font-sans">
        <div class="absolute inset-0 z-0 w-full h-full"><video class="w-full h-full relative z-0 cursor-pointer object-contain" playsinline></video></div>
      </div>
    </div>
  </body></html>`, { url }).window.document;
}

test("a site-ruled bespoke embed resolves to the video wrapper", () => {
  const doc = bespokeEmbedDoc("https://71stream.one/embed/l5KJMAN1ra");
  const video = doc.querySelector("video");
  const found = findPlayerForVideo(video);
  assert.ok(found, "host+path gate claims the bespoke video");
  assert.equal(found.container, video.parentNode, "the wrapper is structural, not a selector");
  assert.equal(found.hops, 1);
});

test("the site rule holds its gates: other hosts and paths stay unmatched", () => {
  for (const url of ["https://example.com/embed/l5KJMAN1ra", "https://71stream.one/dashboard", "https://71stream.one/"]) {
    const doc = bespokeEmbedDoc(url);
    const video = doc.querySelector("video");
    assert.equal(findPlayerForVideo(video), null, url);
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

test("rectMeetsMinSize answers the box alone, visibility aside", () => {
  const doc = dom("");
  assert.equal(rectMeetsMinSize(sizedVideo(doc, { width: 200, height: 100 })), true);
  assert.equal(rectMeetsMinSize(sizedVideo(doc, { width: 50, height: 50 })), false);
  const hidden = sizedVideo(doc, { width: 800, height: 450 });
  hidden.checkVisibility = () => false;
  assert.equal(rectMeetsMinSize(hidden), true, "invisible but rect-sized enrolls");
  const broken = doc.createElement("video");
  broken.getBoundingClientRect = () => {
    throw new Error("unreadable");
  };
  assert.equal(rectMeetsMinSize(broken), false);
});

/** Controllable IntersectionObserver: the loader's no-op shim never fires. */
function installFiringObserver() {
  const instances = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.dead = false;
      instances.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    unobserve(target) {
      this.targets = this.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.dead = true;
    }
  };
  return {
    instances,
    fire(video, isIntersecting) {
      for (const io of instances) {
        if (!io.dead && io.targets.includes(video)) {
          io.cb([{ isIntersecting, target: video }]);
        }
      }
    },
    restore() {
      if (descriptor) {
        Object.defineProperty(globalThis, "IntersectionObserver", descriptor);
      } else {
        delete globalThis.IntersectionObserver;
      }
    }
  };
}

test("visibility offers fire on entering, never on exiting", () => {
  const rig = installFiringObserver();
  try {
    const doc = dom('<div class="dplayer"><video></video></div>');
    const video = doc.querySelector("video");
    const seen = [];
    const watch = watchVisibilityOffers((v) => seen.push(v));
    watch.observe(video);
    rig.fire(video, false);
    assert.deepEqual(seen, [], "an exit cannot newly qualify a video");
    rig.fire(video, true);
    assert.deepEqual(seen, [video], "a crossing re-offers");
    watch.unobserve(video);
    rig.fire(video, true);
    assert.deepEqual(seen, [video], "unobserved videos stay silent");
    watch.dispose();
  } finally {
    rig.restore();
  }
});

test("visibility offers degrade to a no-op handle without the API", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  delete globalThis.IntersectionObserver;
  try {
    const doc = dom('<div class="dplayer"><video></video></div>');
    const video = doc.querySelector("video");
    const watch = watchVisibilityOffers(() => {
      throw new Error("must never fire without the API");
    });
    watch.observe(video);
    watch.unobserve(video);
    watch.dispose();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "IntersectionObserver", descriptor);
    }
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

test("findPlayerForVideo returns a cached descriptor with container and hops", () => {
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div>');
  const video = doc.querySelector("video");
  const sdk = findPlayerForVideo(video);
  assert.ok(sdk);
  assert.equal(sdk.label, "div.plyr__video-wrapper");
  assert.equal(sdk.container, containerOf(video));
  // Hops = distance video -> container.
  assert.equal(sdk.hops >= 1, true);
  // Every re-query returns the identical cached object - no per-call churn.
  assert.equal(findPlayerForVideo(video), sdk);
});

test("the memo survives a re-query that changes nothing", () => {
  const doc = dom('<div class="dplayer"><video></video></div>');
  const video = doc.querySelector("video");
  const first = findPlayerForVideo(video);
  // Warm the positive memo, then re-query: freshness must not re-wrap, or the
  // "same object per video" contract above silently regressed into a re-scan.
  assert.equal(findPlayerForVideo(video), first);
  assert.equal(findPlayerForVideo(video), first);
});

test("re-parenting out of a template invalidates the positive memo", () => {
  const doc = dom(
    '<div class="dplayer"><div id="slot"><video></video></div></div>' +
    '<div class="plain"><div id="target"></div></div>'
  );
  const video = doc.querySelector("video");
  assert.ok(findPlayerForVideo(video));

  // Same element, new ancestry: the WeakMap key survives, so an unvalidated
  // memo would keep reporting the wrapper the video just left.
  doc.querySelector("#target").append(video);
  assert.equal(findPlayerForVideo(video), null, "stale descriptor survived re-parenting");
});

test("re-parenting into a template is detected on re-query", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div data-vjs-player id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findPlayerForVideo(video), null, "precondition: unregistered to start");

  doc.querySelector("#target").append(video);
  assert.ok(findPlayerForVideo(video), "stale null survived re-parenting");
});

test("a subtree grafted under a template is detected on re-query", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div class="dplayer" id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findPlayerForVideo(video), null, "precondition: unregistered to start");

  // Move the video AND its parent together: the direct parent never changes,
  // so a parent-only freshness check keeps reporting the stale null for the
  // life of the document while the video sits inside a real player.
  doc.querySelector("#target").append(doc.querySelector("#slot"));
  assert.ok(findPlayerForVideo(video), "stale null survived a subtree graft");
});

test("a graft that adds no template still answers null", () => {
  const doc = dom(
    '<div class="plain"><div id="slot"><video></video></div></div>' +
    '<div class="plain" id="target"></div>'
  );
  const video = doc.querySelector("video");
  assert.equal(findPlayerForVideo(video), null);

  doc.querySelector("#target").append(doc.querySelector("#slot"));
  assert.equal(findPlayerForVideo(video), null, "a graft without a template must not resurrect a match");
});

test("a positive memo is invalidated when the matched wrapper is replaced in place", () => {
  // The parent check alone cannot see this one: the video's own parent is
  // untouched, so only re-verifying the anchor at its recorded hop catches it.
  const doc = dom('<div id="slot"><div class="dplayer"><video></video></div></div>');
  const video = doc.querySelector("video");
  assert.ok(findPlayerForVideo(video));

  const slot = doc.querySelector("#slot");
  slot.textContent = "";
  slot.append(video);

  assert.equal(findPlayerForVideo(video), null, "stale descriptor survived wrapper replacement");
});

test("detachment rescans to null without throwing", () => {
  const doc = dom('<div class="plain"><video></video></div>');
  const video = doc.querySelector("video");
  assert.equal(findPlayerForVideo(video), null);

  video.remove();
  assert.equal(findPlayerForVideo(video), null, "detachment must not throw or resurrect a match");
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

test("findPlayerForVideo matches a template anchor across a shadow boundary", () => {
  const doc = dom('<div data-plyr><div class="plyr__video-wrapper"><x-holder></x-holder></div></div>');
  const host = doc.querySelector("x-holder");
  const shadow = host.attachShadow({ mode: "open" });
  const video = doc.createElement("video");
  shadow.appendChild(video);

  const match = findPlayerForVideo(video);
  assert.ok(match, "composed chain crossed the boundary via .host");
  assert.equal(match?.container, doc.querySelector(".plyr__video-wrapper"), "container resolves in the light tree");
});

/* - Resolve: templates only, unmatched stays unmatched - */

test("resolvePlayer answers templates and null", () => {
  // A templated player resolves by anchor; a bare video resolves to null -
  // there is no second tier, so no option to enable one.
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div><div id="open"><video></video></div>');
  const templated = doc.querySelector(".plyr video");
  const bare = doc.querySelector("#open video");
  assert.equal(resolvePlayer(templated)?.container, doc.querySelector(".plyr__video-wrapper"));
  assert.equal(resolvePlayer(bare), null, "unmatched stays unmatched");
});

/* - Resolve-path invariants: what each probe may cost - */

test("anchor matching reads no boxes", () => {
  // The shared fill walks pointers, never boxes: matches() costs no layout,
  // so resolves must complete without a single getBoundingClientRect
  // anywhere on the chain - hit or miss alike, since misses no longer
  // fall through to a measuring probe.
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div><div id="open"><video></video></div>');
  const plyrVideo = doc.querySelector(".plyr video");
  const openVideo = doc.querySelector("#open video");
  const box = { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 };
  let rectReads = 0;
  for (const el of [plyrVideo, openVideo, ...doc.querySelectorAll("div"), doc.body, doc.documentElement]) {
    el.getBoundingClientRect = () => {
      rectReads++;
      return { ...box };
    };
  }
  assert.ok(resolvePlayer(plyrVideo), "template hit");
  assert.equal(resolvePlayer(openVideo), null, "template miss");
  assert.equal(rectReads, 0, "anchor matching reads no boxes on either path");
});

test("a template re-resolve returns the same descriptor object", () => {
  const doc = dom('<div class="plyr"><div class="plyr__video-wrapper"><video></video></div></div>');
  const video = doc.querySelector("video");
  const first = resolvePlayer(video);
  assert.ok(first);
  assert.equal(resolvePlayer(video), first, "memo identity survived the unification");
});

/* - Unified survey: one walk, informative, non-destructive - */

test("surveyVideos reports every video with its context, light and shadow", () => {
  const doc = dom('<div id="plain"><video></video></div>');
  const plain = doc.querySelector("#plain video");
  Object.defineProperty(plain, "paused", { value: false, configurable: true });
  Object.defineProperty(plain, "ended", { value: false, configurable: true });
  plain.setAttribute("src", "https://example.com/v.mp4");
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div id="framed"><video></video></div>';
  const framed = shadow.querySelector("video");
  Object.defineProperty(framed, "paused", { value: true, configurable: true });

  const found = surveyVideos(doc);
  assert.equal(found.length, 2, "light and shadow videos in one pass");
  const [first, second] = found;
  assert.equal(first.video, plain);
  assert.equal(first.shadow, false);
  assert.equal(first.hasSrc, true, "the src attribute counts as sourced");
  assert.equal(first.playing, true);
  assert.equal(second.video, framed);
  assert.equal(second.shadow, true, "the shadow pass marks its own");
  assert.equal(second.hasSrc, false);
  assert.equal(second.playing, false);
});

test("surveyVideos reads no boxes", () => {
  const doc = dom('<div id="plain"><video></video></div>');
  const plain = doc.querySelector("#plain video");
  let rectReads = 0;
  for (const el of [plain, doc.querySelector("#plain"), doc.body, doc.documentElement]) {
    el.getBoundingClientRect = () => {
      rectReads++;
      return { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 };
    };
  }
  const found = surveyVideos(doc);
  assert.equal(found.length, 1);
  assert.equal(rectReads, 0, "surveying is property reads only - placement stays in resolve");
});

test("templateCustomTags derives exactly the custom-element anchors", () => {
  const tags = templateCustomTags();
  assert.ok(tags.includes("video-js"), "the tech tag is watched");
  assert.ok(tags.includes("theoplayer-ui"), "the UI tag is watched");
  for (const tag of tags) {
    assert.match(tag, /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/, `${tag} is a valid custom-element name`);
  }
});

test("every anchor stays a simple compound for :is() grouping", () => {
  // The grouped pre-check matches each chain node against all anchors at
  // once, which preserves meaning only for single-node compounds: a
  // combinator or pseudo would silently change what the group matches
  // versus the per-anchor loop it gates. Only classes, attributes and
  // custom-element tags may enter the table.
  for (const anchor of templateAnchors()) {
    assert.match(
      anchor,
      /^(?:\.[A-Za-z0-9_-]+|\[[^\[\]]+\]|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/,
      `${anchor} must stay a simple compound`
    );
  }
});
