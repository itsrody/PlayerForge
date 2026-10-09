/**
 * Revisit-offer browser benchmark - what a learned print saves per offer,
 * measured in real Gecko.
 *
 * The end-to-end revisit (navigation to HUD) is wait-dominated: the first
 * visit waits for playback, a gesture, and a re-offer, and the revisit
 * still waits for an offer with the learned state's classes live - a
 * print learned while playing does not match a paused pre-click DOM, by
 * the subset rule's design. An end-to-end row would report ~1.0x and teach
 * nothing. What learning guarantees is cheaper OFFERS: every discovery
 * offer for an unrecognized video otherwise runs the full slow-path
 * measurement - playback-state reads, the activation read, and a
 * container walk where every ancestor pays getBoundingClientRect, i.e. a
 * forced layout - while a learned print resolves with tag/class/id
 * compares and zero rect reads. Offers arrive per mutation, so the layout
 * saving compounds across the document's life, and every DOM touch it
 * removes is also one less Xray crossing in the isolated userscript realm
 * (same translation as the discovery-match rows: direction survives,
 * close ratios do not).
 *
 * The pair reimplements both arms page-side against a fixture of four
 * structural players plus eight ad-grid distractors, with playback state
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
  style.textContent = ".pf-rv-player{width:640px;height:360px}.pf-rv-player video{width:100%;height:100%}.pf-rv-plain{width:640px;height:360px}.pf-rv-plain video{width:100%;height:100%}#pf-revisit-stage.pf-dirty .pf-rvvid{margin-top:1px}";
  document.head.appendChild(style);
  const VIDEOS = [];
  const PRINTS = new Map();
  const playerHtml = (cls, extra) =>
    '<div class="' + cls + '"' + extra + '><video class="pf-rvvid"></video></div>';
  const wrap = (html) => {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    stage.appendChild(holder);
    return holder.firstElementChild;
  };
  // Four remembered players, depths 1-3, shapes a print records.
  const remembered = [
    wrap(playerHtml("pf-rv-player wide", ' id="rv-main"')),
    wrap('<section><div class="pf-rv-player narrow"><video class="pf-rvvid"></video></div></section>').querySelector(".pf-rv-player"),
    wrap('<div><div><div class="pf-rv-player deep"><video class="pf-rvvid"></video></div></div></div>').querySelector(".pf-rv-player"),
    wrap(playerHtml("pf-rv-player", "")),
  ];
  for (const container of remembered) {
    const video = container.querySelector("video");
    VIDEOS.push(video);
    let hops = 0;
    for (let node = video.parentNode; node && node !== container; node = node.parentNode) hops++;
    PRINTS.set(video, {
      tag: container.tagName.toLowerCase(),
      cls: [...container.classList].sort(),
      id: container.id || null,
      depth: hops + 1,
    });
  }
  // Eight distractors: bare videos in plain divs, the ad-grid shape. No
  // print remembers them, so the warm arm walks each to an honest miss.
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
  window.__pfRevisit = { VIDEOS, PRINTS, stage };
`;

function offerPair() {
  return {
    label: "generic offer, unrecognized video",
    firstName: "slow-path measure (gates + rect walk)",
    secondName: "learned print match (tag/class/id walk)",
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
          // resolveGenericContainer: viewport refusal, then the climb
          // with a rect per ancestor (the forced layout per offer).
          const doc = video.ownerDocument;
          const vw = doc?.documentElement?.clientWidth ?? 0;
          const vh = doc?.documentElement?.clientHeight ?? 0;
          if (vw > 0 && vh > 0) {
            if (rect.width >= vw * 0.9 && rect.height >= vh * 0.9) continue;
            if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
          }
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
    secondOp: function printMatch() {
      const { VIDEOS, PRINTS, stage } = window.__pfRevisit;
      // Same dirty tree as the cold arm; class matching reads no layout,
      // so the flush stays pending and unpaid.
      stage.classList.toggle("pf-dirty");
      let acc = 0;
      for (let n = 0; n < 8; n++) {
        for (let v = 0; v < VIDEOS.length; v++) {
          const video = VIDEOS[v];
          const print = PRINTS.get(video);
          if (!print || typeof print !== "object") continue;
          if (!Array.isArray(print.cls) || !Number.isInteger(print.depth)) continue;
          // matchPrints: climb to the recorded depth, then compare. No
          // rect reads anywhere - the print IS the placement answer.
          let node = video;
          for (let hop = 0; hop < print.depth; hop++) {
            node = node.parentNode ?? null;
            if (!node || node.nodeType !== 1) break;
          }
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName.toLowerCase() !== print.tag) continue;
          if (print.id !== null && node.id !== print.id) continue;
          let subset = true;
          for (const cls of print.cls) {
            if (!node.classList.contains(cls)) {
              subset = false;
              break;
            }
          }
          acc += subset ? print.depth + 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}
