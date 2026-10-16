import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { resolvePlayer, findPlayerForVideo } from "../src/kernel/sdk.js";

/**
 * Seeded property fuzz over the resolve: randomized class/attribute soup
 * asserting the resolve's structural contracts hold for every shape, not
 * just the pinned fixtures. Deterministic by construction (mulberry32 on
 * a fixed seed) - no flaky randomness, no timers, jsdom only.
 *
 * What it pins that fixtures cannot: termination on hostile soup, exactly
 * one winner per video with hops inside the chain, memo identity across
 * re-resolves, freshness after re-parenting, and the site gates (host +
 * path must BOTH match or the rule never fires).
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ANCHORS = [
  ".jwplayer",
  ".video-js",
  ".vjs-tech",
  "[data-plyr]",
  ".plyr__video-wrapper",
  ".dplayer",
  ".xgplayer",
  "[data-player]",
  "media-player",
];
const JUNK_CLASSES = ["player", "container", "wrapper", "foo", "bar", "media", "holder", "box"];
const JUNK_ATTRS = ["data-x", "data-foo", "title", "data-count"];
const HOSTS = ["example.com", "71stream.one", "www.71stream.one", "evil71stream.one.com", "cdn.example.com"];
const PATHS = ["/", "/embed/l5KJMAN1ra", "/dashboard", "/embed/", "/watch/1"];

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

function randomTree(rand, url) {
  const doc = new JSDOM("<!doctype html><html><body></body></html>", { url }).window.document;
  // Depth 1-4 of nested divs with soup classes/attrs, video at the bottom.
  const depth = 1 + Math.floor(rand() * 4);
  let parent = doc.body;
  for (let d = 0; d < depth; d++) {
    const div = doc.createElement("div");
    // At most one custom-element wrapper per level: a second tag roll
    // would move this div into a new host and re-attach that host under
    // the div itself - a cycle. Extra tag rolls are dropped instead.
    let customLinked = false;
    const rolls = Math.floor(rand() * 3);
    for (let r = 0; r < rolls; r++) {
      if (rand() < 0.45) {
        const anchor = pick(rand, ANCHORS);
        if (anchor.startsWith(".")) {
          div.classList.add(anchor.slice(1));
        } else if (anchor.startsWith("[")) {
          div.setAttribute(anchor.slice(1, -1), "x");
        } else if (!customLinked) {
          // Custom-element tag anchors need a real element of that name:
          // wrap this level's div so the ancestry stays a straight chain.
          const host = doc.createElement(anchor);
          host.appendChild(div);
          parent.appendChild(host);
          parent = div;
          customLinked = true;
        }
      } else if (rand() < 0.5) {
        div.classList.add(pick(rand, JUNK_CLASSES));
      } else {
        div.setAttribute(pick(rand, JUNK_ATTRS), "x");
      }
    }
    if (!customLinked) {
      parent.appendChild(div);
      parent = div;
    }
  }
  const video = doc.createElement("video");
  parent.appendChild(video);
  return { doc, video };
}

function chainOf(video) {
  const chain = [];
  for (let node = video; node; node = node.parentNode ?? null) {
    if (node.nodeType === 1) {
      chain.push(node);
    }
  }
  return chain;
}

const ITERATIONS = 150;

test("fuzzed soup always resolves to a valid descriptor or null", () => {
  const rand = mulberry32(0xc10c);
  for (let i = 0; i < ITERATIONS; i++) {
    const url = `https://${pick(rand, HOSTS)}${pick(rand, PATHS)}`;
    const { video } = randomTree(rand, url);
    const found = findPlayerForVideo(video);
    if (found === null) {
      continue;
    }
    const chain = chainOf(video);
    assert.ok(chain.includes(found.container), `iteration ${i}: container is in the composed chain`);
    assert.ok(Number.isInteger(found.hops) && found.hops >= 0 && found.hops < chain.length, `iteration ${i}: hops inside the chain`);
    assert.equal(typeof found.label, "string", `iteration ${i}: label is structural text`);
  }
});

test("fuzzed resolves are deterministic per tree", () => {
  const rand = mulberry32(0xf00d);
  for (let i = 0; i < ITERATIONS; i++) {
    const url = `https://${pick(rand, HOSTS)}${pick(rand, PATHS)}`;
    const first = randomTree(rand, url);
    const a = findPlayerForVideo(first.video);
    const b = findPlayerForVideo(first.video);
    assert.equal(b, a, `iteration ${i}: memo identity on re-resolve`);
  }
});

test("the site rule fires only on host+path match", () => {
  // Bare videos under bare divs: no template can claim them, so any
  // descriptor must come from the site rule - which must fire exactly
  // when host AND path both match.
  const rand = mulberry32(0x71ea);
  for (let i = 0; i < ITERATIONS; i++) {
    const host = pick(rand, HOSTS);
    const path = pick(rand, PATHS);
    const doc = new JSDOM("<!doctype html><html><body><div><video></video></div></body></html>", {
      url: `https://${host}${path}`,
    }).window.document;
    const video = doc.querySelector("video");
    const found = findPlayerForVideo(video);
    const gated = host === "71stream.one" || host.endsWith(".71stream.one");
    const pathed = /^\/embed\//.test(path);
    if (gated && pathed) {
      assert.ok(found, `iteration ${i}: ${host}${path} must resolve by site rule`);
      assert.equal(found.container, video.parentNode, `iteration ${i}: site container is the wrapper`);
    } else {
      assert.equal(found, null, `iteration ${i}: ${host}${path} must not resolve (evil71stream.one.com and non-embed paths stay out)`);
    }
  }
});

test("fuzzed re-parenting never serves a stale descriptor", () => {
  const rand = mulberry32(0xbeef);
  for (let i = 0; i < 60; i++) {
    const url = `https://${pick(rand, HOSTS)}${pick(rand, PATHS)}`;
    const { doc, video } = randomTree(rand, url);
    const before = findPlayerForVideo(video);
    const slot = doc.createElement("div");
    doc.body.appendChild(slot);
    slot.appendChild(video);
    const after = findPlayerForVideo(video);
    if (before === null) {
      continue;
    }
    // Moved out of every anchor: the memo must not survive the move.
    if (after !== null) {
      assert.ok(chainOf(video).includes(after.container), `iteration ${i}: re-resolved container is current`);
    }
  }
});
