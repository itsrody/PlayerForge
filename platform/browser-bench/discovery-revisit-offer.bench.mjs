/**
 * Revisit-offer browser benchmark - what template matching saves per offer,
 * measured in real Gecko.
 *
 * The end-to-end revisit (navigation to HUD) is wait-dominated: the first
 * visit waits for playback, a gesture, and a re-offer. What the anchor
 * tables guarantee is cheaper OFFERS: every discovery offer for an
 * unmatched video runs the full fallback measurement - playback-state
 * reads, the activation read, and a container walk where every ancestor
 * pays getBoundingClientRect, i.e. a forced layout - while a repeat offer
 * for a templated video answers from the descriptor memo (one WeakMap
 * lookup plus a freshness re-walk of the recorded anchor, zero rect
 * reads). Offers arrive per mutation, so the layout saving compounds
 * across the document's life, and every DOM touch it removes is also one
 * less Xray crossing in the isolated userscript realm (same translation
 * as the discovery-match rows: direction survives, close ratios do not).
 *
 * The pair reimplements both arms page-side against a fixture of four
 * templated players plus eight ad-grid distractors, with playback state
 * stubbed on the elements (the ops under test read page-side, so the
 * stubs are visible to them; the realm caveat above is the price). Each
 * op call starts by toggling a geometry-affecting class on the stage -
 * the same shape of mutation whose offer this prices - so the cold arm's
 * rect walk pays a genuine post-mutation layout flush instead of reading
 * a clean tree. Both rows are report-only: the ratio between arms is the
 * finding, and no row touches baseline.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 15;

export default async function runDiscoveryRevisitOfferBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await FirefoxDriver.launch({ bundle });
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.eval(PRIME);

    const pair = offerPair();
    const coldBatches = [];
    const warmBatches = [];
    for (let b = 0; b < BATCHES; b++) {
      const coldSamples = [];
      const warmSamples = [];
      for (let i = 0; i < ITERATIONS; i++) {
        coldSamples.push((await driver.amplifiedEval(null, pair.firstOp, {})).perOp);
        warmSamples.push((await driver.amplifiedEval(null, pair.secondOp, {})).perOp);
      }
      coldBatches.push(median(coldSamples));
      warmBatches.push(median(warmSamples));
    }
    push(results, pair.label + " - " + pair.firstName, coldBatches);
    push(results, pair.label + " - " + pair.secondName, warmBatches);
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
 * Fixture page. Four structural players the prints remember, eight
 * ad-grid distractors that walk to a miss, all sized from parse so the
 * size gate is green the way a real above-the-fold player is. Playback
 * state is stubbed per element and sticky activation is shadowed onto
 * the instance: without them the cold arm early-exits before the layout
 * work this bench exists to price, which would report the gate order,
 * not the measurement. PRIME throws if either stub fails to take, so a
 * silent early-exit cannot masquerade as a fast slow path.
 * ------------------------------------------------------------------ */
const PRIME = `
  const stage = document.createElement("div");
  stage.id = "pf-revisit-stage";
  document.body.appendChild(stage);
  const style = document.createElement("style");
  style.textContent = ".pf-rv-player{width:640px;height:360px}.pf-rv-player video{width:100%;height:100%}.pf-rv-plain{width:640px;height:360px}.pf-rv-plain video{width:100%;height:100%}#pf-revisit-stage.pf-dirty .pf-rvvid{margin-top:1px}.jwplayer,.plyr__video-wrapper,.video-js,.xgplayer{width:640px;height:360px}.jwplayer video,.plyr__video-wrapper video,.video-js video,.xgplayer video{width:100%;height:100%}";
  document.head.appendChild(style);
  const VIDEOS = [];
  const playerHtml = (cls, extra) =>
    '<div class="' + cls + '"' + extra + '><video class="pf-rvvid"></video></div>';
  const wrap = (html) => {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    stage.appendChild(holder);
    return holder.firstElementChild;
  };
  // Four templated players, depths 1-3, shapes copied from the sdk-engine
  // fixtures (and from src/kernel/sdk.js TEMPLATES, the source of truth).
  const remembered = [
    wrap(playerHtml("jwplayer", "")),
    wrap('<div class="plyr"><div class="plyr__video-wrapper"><video class="pf-rvvid"></video></div></div>').querySelector(".plyr__video-wrapper"),
    wrap('<div><div class="video-js"><video class="pf-rvvid vjs-tech"></video></div></div>').querySelector(".video-js"),
    wrap('<div><div><div class="xgplayer"><video class="pf-rvvid"></video></div></div></div>').querySelector(".xgplayer"),
  ];
  for (const container of remembered) {
    const video = container.querySelector("video");
    VIDEOS.push(video);
  }
  // Eight distractors: bare videos in plain divs, the ad-grid shape. No
  // template anchors them, so the warm arm walks each to an honest miss.
  for (let i = 0; i < 8; i++) {
    const plain = document.createElement("div");
    plain.className = "pf-rv-plain pf-rv-ad-" + i;
    const video = document.createElement("video");
    video.className = "pf-rvvid";
    plain.appendChild(video);
    stage.appendChild(plain);
    VIDEOS.push(video);
  }
  // Filler weight so the post-mutation flush has a document to chew:
  // the arms never query it, but layout does not skip it.
  for (let i = 0; i < 1500; i++) {
    const filler = document.createElement("div");
    filler.className = "pf-rv-filler";
    filler.appendChild(document.createElement("span"));
    stage.appendChild(filler);
  }
  // Playback-state stubs: playing, sized, with metadata, not ended.
  for (const video of VIDEOS) {
    Object.defineProperties(video, {
      paused: { value: false, configurable: true },
      ended: { value: false, configurable: true },
      readyState: { value: 4, configurable: true },
    });
  }
  // Sticky activation shadowed onto the instance (prototype attributes
  // stay untouched). Without a real gesture this is the only way the
  // cold arm reaches past its activation early-exit.
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive: false, hasBeenActive: true },
    configurable: true,
  });
  // Fail loudly if a stub did not take: an early-exiting cold arm would
  // otherwise report gate order as measurement cost.
  if (VIDEOS[0].paused !== false || VIDEOS[0].readyState !== 4) {
    throw new Error("revisit fixture: playback stubs did not take");
  }
  if (navigator.userActivation?.hasBeenActive !== true) {
    throw new Error("revisit fixture: activation stub did not take");
  }
  window.__pfRevisit = { VIDEOS, stage, MEMO: new Map() };
`;

function offerPair() {
  return {
    label: "revisit offer, templated video",
    firstName: "fallback measure (gates + rect walk)",
    secondName: "template memo hit (freshness re-walk)",
    firstOp: function slowMeasure() {
      const { VIDEOS, stage } = window.__pfRevisit;
      // The mutation whose offer this prices: add or remove, either way
      // the tree needs a flush, which the rect walk below pays.
      stage.classList.toggle("pf-dirty");
      let acc = 0;
      for (let n = 0; n < 8; n++) {
        for (let v = 0; v < VIDEOS.length; v++) {
          const video = VIDEOS[v];
          // findGenericPlayer gate order: playback, activation, size.
          if (video.paused || video.ended || !(video.readyState >= 1)) continue;
          if (!navigator.userActivation || navigator.userActivation.hasBeenActive !== true) continue;
          let rect;
          try {
            rect = video.getBoundingClientRect();
          } catch {
            continue;
          }
          if (!(rect.width > 0) || !(rect.height > 0)) continue;
          // resolveGenericContainer: straight into the climb with a rect
          // per ancestor (the forced layout per offer). No viewport
          // consult anywhere - where the box sits is not an input.
          const doc = video.ownerDocument;
          let container = null;
          let hops = 0;
          let node = video.parentNode ?? null;
          while (node) {
            if (node.nodeType === 1) {
              if (node === doc?.body || node === doc?.documentElement) break;
              hops += 1;
              let box;
              try {
                box = node.getBoundingClientRect();
              } catch {
                break;
              }
              if (box.width <= 0 || box.height <= 0) {
                node = node.parentNode;
                continue;
              }
              const same =
                Math.abs(box.width - rect.width) < 2 && Math.abs(box.height - rect.height) < 2;
              if (!same) {
                container = node;
                break;
              }
            }
            node = node.parentNode;
          }
          acc += container ? hops + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function templateMemoHit() {
      const { VIDEOS, stage, MEMO } = window.__pfRevisit;
      // Same dirty tree as the cold arm. Mirrors resolvePlayer's memo: a
      // per-video entry holding the anchor, its hop distance and the video's
      // parent, re-verified per offer with pointer reads only - no layout
      // anywhere, on hit or miss alike.
      const GROUP = ":is(.jwplayer,.jw-wrapper,[data-vjs-player],.video-js,.vjs-tech,video-js,[data-plyr],[data-plyr-config],.plyr__video-wrapper,.plyr,.art-video-player,.artplayer,.dplayer,.mejs-container,.mejs__container,.xgplayer,.prism-player,.fluid_video_wrapper,.fp-player,flowplayer-ui,[data-player-id],.flowplayer,[data-player],media-player,mux-player,radiant-media-player,.shaka-video-container,[data-shaka-player],[data-shaka-player-container],.theoplayer-container,theoplayer-ui,theoplayer-default-ui)";
      stage.classList.toggle("pf-dirty");
      let acc = 0;
      for (let n = 0; n < 8; n++) {
        for (let v = 0; v < VIDEOS.length; v++) {
          const video = VIDEOS[v];
          const cached = MEMO.get(video);
          if (cached && cached.parent === video.parentNode) {
            let node = video;
            let seen = 0;
            let fresh = false;
            while (node) {
              if (node.nodeType === 1) {
                if (seen === cached.hops) {
                  fresh = node === cached.el;
                  break;
                }
                seen++;
              }
              node = node.parentNode ?? null;
            }
            if (fresh) {
              acc += 1;
              continue;
            }
          }
          let node = video;
          let hops = 0;
          while (node) {
            if (node.nodeType === 1) {
              if (node.matches(GROUP)) {
                MEMO.set(video, { el: node, hops, parent: video.parentNode });
                acc += hops + 1;
                break;
              }
              hops++;
            }
            node = node.parentNode ?? null;
          }
        }
      }
      window.__pfJitSink = acc;
    },
  };
}
