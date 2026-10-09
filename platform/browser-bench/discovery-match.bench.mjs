/**
 * Discovery-match browser benchmark — which anchor-matching strategy costs
 * least in real Gecko for the SDK detection walk.
 *
 * `src/kernel/sdk.js` resolves each candidate video by walking its composed
 * ancestry and calling `matches()` per anchor with a best-hops bound. Three
 * native-direct alternatives exist: `closest()` with one mega-selector (C++
 * walk, then a short hop-count + tie resolve), an inverted
 * `:has(video)` query (one engine pass returning candidate anchors, then
 * membership walks), and one grouped `:is()` matches per node instead of a
 * per-anchor loop. All three are DOM measurements, so unlike the pure-JS
 * rows in `jit-shape.bench.mjs` the realm caveat applies: they run
 * page-side, while PF runs in the manager's isolated userscript realm, where
 * every DOM touch crosses Xray vision. Direction and touch-count survive
 * that translation (fewer DOM touches is strictly less Xray surface); close
 * ratios do not.
 *
 * The fixture page mixes hits and misses the way a real document does: four
 * SDK players (Plyr, JW, Video.js, DPlayer markup mirroring the sdk-engine
 * fixtures) against twelve unregistered videos in plain divs (the ad-grid
 * shape), plus filler depth and one shadow-hosted player the light-DOM
 * strategies are structurally blind to. Misses take the honest path in each
 * candidate arm: closest-first falls back to the full composed walk (a miss
 * costs the attempt PLUS the walk), and the inverted shape still walks
 * membership per video.
 *
 * Every row is report-only: the ratio between arms is the finding, and no
 * row touches `baseline.json`. A row earns a `src/` change only together
 * with the shadow-fallback accounting its ratio leaves out.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 15;

export default async function runDiscoveryMatchBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await FirefoxDriver.launch({ bundle });
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.eval(PRIME);

    for (const pair of [closestPair(), hasPair(), groupedPair()]) {
      const firstBatches = [];
      const secondBatches = [];
      for (let b = 0; b < BATCHES; b++) {
        const firstSamples = [];
        const secondSamples = [];
        for (let i = 0; i < ITERATIONS; i++) {
          firstSamples.push((await driver.amplifiedEval(null, pair.firstOp, {})).perOp);
          secondSamples.push((await driver.amplifiedEval(null, pair.secondOp, {})).perOp);
        }
        firstBatches.push(median(firstSamples));
        secondBatches.push(median(secondSamples));
      }
      push(results, pair.label + " - " + pair.firstName, firstBatches);
      push(results, pair.label + " - " + pair.secondName, secondBatches);
    }
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Collapse one arm's per-batch medians into a result row, report-only. */
function push(results, name, batchMedians) {
  const sorted = [...batchMedians].sort((a, b) => a - b);
  results.push({
    name,
    medianMsPerOp: sorted[Math.floor(sorted.length / 2)],
    spread: (sorted[sorted.length - 1] - sorted[0]) / sorted[Math.floor(sorted.length / 2)],
    gateable: false,
  });
}

/* ------------------------------------------------------------------ *
 * Fixture page, installed once. Mirror of the sdk-engine fixtures plus
 * miss-heavy ad-grid videos, filler depth, and one shadow player the
 * light-DOM strategies cannot see (kept out of the timed sets; its
 * existence is why every candidate keeps a composed-walk fallback).
 * ------------------------------------------------------------------ */
const PRIME = `
  const stage = document.createElement("div");
  stage.id = "pf-match-stage";
  document.body.appendChild(stage);
  const player = (html) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    stage.appendChild(wrap);
    return wrap;
  };
  // Four SDK hits, shapes copied from the sdk-engine fixtures.
  player('<div class="plyr"><div class="plyr__video-wrapper"><video class="pf-testvid" data-sdk="plyr"></video></div></div>');
  player('<div class="jwplayer"><video class="pf-testvid" data-sdk="jw"></video></div>');
  player('<div data-vjs-player><div class="video-js"><video class="pf-testvid" data-sdk="vjs"></video></div></div>');
  player('<div class="dplayer"><video class="pf-testvid" data-sdk="dplayer"></video></div>');
  // Twelve misses: bare videos in plain divs, the ad-grid shape.
  for (let i = 0; i < 12; i++) {
    const wrap = document.createElement("div");
    wrap.className = "pf-plain-" + i;
    const video = document.createElement("video");
    video.className = "pf-testvid";
    video.dataset.sdk = "none";
    wrap.appendChild(video);
    stage.appendChild(wrap);
  }
  // Filler depth so document-wide queries pay something real.
  for (let i = 0; i < 400; i++) {
    const filler = document.createElement("div");
    filler.className = "pf-filler";
    filler.appendChild(document.createElement("span"));
    stage.appendChild(filler);
  }
  // One shadow-hosted SDK player: closest() and :has() are blind to it.
  const host = document.createElement("div");
  host.className = "plyr";
  stage.appendChild(host);
  host.attachShadow({ mode: "open" }).innerHTML =
    '<div class="plyr__video-wrapper"><video class="pf-testvid" data-sdk="shadow"></video></div>';

  // Groups mirror REGISTRY order (registry, then anchor) for tie-breaking.
  // Keep in sync with src/kernel/sdk.js if anchors move.
  const GROUPS = [
    { name: "JW Player", anchors: [".jwplayer", ".jw-wrapper"] },
    { name: "Video.js", anchors: ["[data-vjs-player]", ".video-js", ".vjs-tech", "video-js"] },
    { name: "Plyr", anchors: ["[data-plyr]", "[data-plyr-config]", ".plyr__video-wrapper", ".plyr"] },
    { name: "ArtPlayer", anchors: [".art-video-player", ".artplayer"] },
    { name: "DPlayer", anchors: [".dplayer"] },
    { name: "MediaElement.js", anchors: [".mejs-container", ".mejs__container"] },
    { name: "XGPlayer", anchors: [".xgplayer"] },
    { name: "Aliplayer", anchors: [".prism-player"] },
    { name: "Fluid Player", anchors: [".fluid_video_wrapper"] },
    { name: "Flowplayer", anchors: [".fp-player", "flowplayer-ui", "[data-player-id]", ".flowplayer"] },
    { name: "Clappr", anchors: ["[data-player]"] },
    { name: "Vidstack", anchors: ["media-player"] },
    { name: "Mux Player", anchors: ["mux-player"] },
    { name: "Radiant Media Player", anchors: ["radiant-media-player"] },
    { name: "Shaka Player", anchors: [".shaka-video-container", "[data-shaka-player]", "[data-shaka-player-container]"] },
    { name: "THEOplayer", anchors: [".theoplayer-container", "theoplayer-ui", "theoplayer-default-ui"] }
  ];
  const seen = new Set();
  const MEGA_PARTS = [];
  for (const group of GROUPS) {
    for (const anchor of group.anchors) {
      if (!seen.has(anchor)) {
        seen.add(anchor);
        MEGA_PARTS.push(anchor);
      }
    }
  }
  const MEGA = MEGA_PARTS.join(",");
  const HAS = MEGA_PARTS.map((anchor) => anchor + ":has(video)").join(",");

  const HITS = [...stage.querySelectorAll(".pf-testvid")].filter((video) => video.dataset.sdk !== "none");
  const MISSES = [...stage.querySelectorAll(".pf-testvid")].filter((video) => video.dataset.sdk === "none");

  window.__pfMatch = { GROUPS, MEGA, HAS, HITS, MISSES };
`;

function closestPair() {
  return {
    label: "anchor match, mixed hits and misses",
    firstName: "composed walk + per-anchor matches",
    secondName: "closest() + verify, full walk on miss",
    firstOp: function walkMatches() {
      const { GROUPS, HITS, MISSES } = window.__pfMatch;
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        for (let v = 0; v < videos.length; v++) {
          const video = videos[v];
          const chain = [];
          for (let node = video; node;) {
            if (node.nodeType === 1) chain.push(node);
            node = node.parentNode || null;
          }
          let best = null;
          for (let r = 0; r < GROUPS.length; r++) {
            const anchors = GROUPS[r].anchors;
            for (let a = 0; a < anchors.length; a++) {
              const limit = best ? best.hops : chain.length;
              for (let hop = 0; hop < limit; hop++) {
                if (chain[hop].matches(anchors[a])) {
                  if (!best || hop < best.hops) best = { hops: hop };
                  break;
                }
              }
            }
          }
          acc += best ? best.hops + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function closestVerify() {
      const { GROUPS, MEGA, HITS, MISSES } = window.__pfMatch;
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        for (let v = 0; v < videos.length; v++) {
          const video = videos[v];
          const hit = video.closest(MEGA);
          if (hit === null) {
            const chain = [];
            for (let node = video; node;) {
              if (node.nodeType === 1) chain.push(node);
              node = node.parentNode || null;
            }
            let best = null;
            for (let r = 0; r < GROUPS.length; r++) {
              const anchors = GROUPS[r].anchors;
              for (let a = 0; a < anchors.length; a++) {
                const limit = best ? best.hops : chain.length;
                for (let hop = 0; hop < limit; hop++) {
                  if (chain[hop].matches(anchors[a])) {
                    if (!best || hop < best.hops) best = { hops: hop };
                    break;
                  }
                }
              }
            }
            continue;
          }
          let hops = 0;
          for (let node = video; node !== hit; node = node.parentNode) hops++;
          let won = null;
          for (let r = 0; r < GROUPS.length && won === null; r++) {
            const anchors = GROUPS[r].anchors;
            for (let a = 0; a < anchors.length; a++) {
              if (hit.matches(anchors[a])) {
                won = GROUPS[r].name;
                break;
              }
            }
          }
          acc += hops + (won ? 1 : 0);
        }
      }
      window.__pfJitSink = acc;
    },
  };
}

function hasPair() {
  return {
    label: "anchor match, inverted :has() query",
    firstName: "composed walk + per-anchor matches",
    secondName: ":has() query + membership walks",
    firstOp: function walkMatchesHas() {
      const { GROUPS, HITS, MISSES } = window.__pfMatch;
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        for (let v = 0; v < videos.length; v++) {
          const video = videos[v];
          const chain = [];
          for (let node = video; node;) {
            if (node.nodeType === 1) chain.push(node);
            node = node.parentNode || null;
          }
          let best = null;
          for (let r = 0; r < GROUPS.length; r++) {
            const anchors = GROUPS[r].anchors;
            for (let a = 0; a < anchors.length; a++) {
              const limit = best ? best.hops : chain.length;
              for (let hop = 0; hop < limit; hop++) {
                if (chain[hop].matches(anchors[a])) {
                  if (!best || hop < best.hops) best = { hops: hop };
                  break;
                }
              }
            }
          }
          acc += best ? best.hops + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function hasQuery() {
      const { HAS, HITS, MISSES } = window.__pfMatch;
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        const hits = new Set(document.querySelectorAll(HAS));
        for (let v = 0; v < videos.length; v++) {
          let found = null;
          for (let node = videos[v]; node; node = node.parentNode) {
            if (hits.has(node)) {
              found = node;
              break;
            }
          }
          acc += found ? 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}

function groupedPair() {
  return {
    label: "anchor match, grouped selector",
    firstName: "per-anchor matches() loop",
    secondName: "single :is() matches() per node",
    firstOp: function perAnchor() {
      const { GROUPS, HITS, MISSES } = window.__pfMatch;
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        for (let v = 0; v < videos.length; v++) {
          const chain = [];
          for (let node = videos[v]; node;) {
            if (node.nodeType === 1) chain.push(node);
            node = node.parentNode || null;
          }
          let best = null;
          for (let r = 0; r < GROUPS.length; r++) {
            const anchors = GROUPS[r].anchors;
            for (let a = 0; a < anchors.length; a++) {
              const limit = best ? best.hops : chain.length;
              for (let hop = 0; hop < limit; hop++) {
                if (chain[hop].matches(anchors[a])) {
                  if (!best || hop < best.hops) best = { hops: hop };
                  break;
                }
              }
            }
          }
          acc += best ? best.hops + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function groupedIs() {
      const { GROUPS, MEGA, HITS, MISSES } = window.__pfMatch;
      const grouped = ":is(" + MEGA + ")";
      let acc = 0;
      const videos = HITS.concat(MISSES);
      for (let n = 0; n < 16; n++) {
        for (let v = 0; v < videos.length; v++) {
          const chain = [];
          for (let node = videos[v]; node;) {
            if (node.nodeType === 1) chain.push(node);
            node = node.parentNode || null;
          }
          let best = null;
          for (let hop = 0; hop < (best ? best.hops : chain.length); hop++) {
            if (chain[hop].matches(grouped)) {
              for (let r = 0; r < GROUPS.length; r++) {
                const anchors = GROUPS[r].anchors;
                for (let a = 0; a < anchors.length; a++) {
                  if (chain[hop].matches(anchors[a])) {
                    if (!best || hop < best.hops) best = { hops: hop, name: GROUPS[r].name };
                    break;
                  }
                }
                if (best && best.hops === hop) break;
              }
            }
          }
          acc += best ? best.hops + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}
