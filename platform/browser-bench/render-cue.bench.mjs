/**
 * Render cue browser benchmark.
 *
 * Measures subtitle cue DOM operation cost in Chromium 154.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 9;
const ITERATIONS = 60;

export default async function runRenderCueBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await ChromiumDriver.launch();
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript(bundle);
    await waitForShell(driver, 8000);

    // Benchmark: cue slot create → mutate → remove.
    //
    // Amplified, for stability. An isolated op is a few clock ticks, so
    // per-shot samples are extremely variable (measured ±700% across 120 raw
    // samples in the same process): each sample is a small integer number of
    // ticks and picks up GC and first-call outliers. Over a 25ms budget the
    // same op reports ±10%, which is what makes a ±20% gate meaningful.
    // The figure is a back-to-back average rather than isolated-op latency,
    // but the methodology is identical on both sides of a code change, which
    // is what a regression gate needs.
    //
    // The op is idempotent (each iteration builds and removes its own slot),
    // so it can repeat tens of thousands of times inside one timed region.
    // setup hoists the cueLayer lookup, which is untimed and not part of the
    // op being measured.
    const cueSlotTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const { perOp } = await driver.amplifiedEval(
          (idx) => {
            const host = document.querySelector(".pf-shell");
            document.__pfBenchCueLayer = host?.shadowRoot?.querySelector(".pf-cue-layer");
            document.__pfBenchIdx = idx;
          },
          () => {
            const cueLayer = document.__pfBenchCueLayer;
            const idx = document.__pfBenchIdx;
            const slot = document.createElement("div");
            slot.className = "pf-cue";
            slot.setAttribute("role", "caption");
            slot.textContent = `Cue ${idx}: Some subtitle text here`;
            slot.style.cssText = "position:absolute;bottom:10%;left:50%;transform:translateX(-50%)";
            cueLayer.appendChild(slot);
            void slot.offsetHeight;
            cueLayer.removeChild(slot);
          },
          { args: [i] }
        );
        timings.push(perOp);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      cueSlotTimes.push(batchMedian);
    }

    cueSlotTimes.sort((a, b) => a - b);
    results.push({
      name: "cue slot create → mutate → remove (DOM)",
      medianMsPerOp: cueSlotTimes[Math.floor(cueSlotTimes.length / 2)],
      spread: (cueSlotTimes[cueSlotTimes.length - 1] - cueSlotTimes[0]) / cueSlotTimes[Math.floor(cueSlotTimes.length / 2)],
    });

    // Benchmark: batch cue update (8 slots).
    //
    // Amplified, same reason as the single-slot row above (per-shot samples
    // measured ±367%; amplified ±10%). The timed op is show → text → hide on
    // 8 pre-built slots, which ends hidden every time, so it is idempotent.
    // setup builds the 8 slots once, untimed.
    const batchUpdateTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const { perOp } = await driver.amplifiedEval(
          (idx) => {
            const host = document.querySelector(".pf-shell");
            const cueLayer = host?.shadowRoot?.querySelector(".pf-cue-layer");
            document.__pfBenchCueLayer = cueLayer;
            document.__pfBenchIdx = idx;
            document.__pfBenchSlots = [];
            if (!cueLayer) return;
            for (let j = 0; j < 8; j++) {
              const slot = document.createElement("div");
              slot.className = "pf-cue";
              slot.setAttribute("role", "caption");
              slot.style.cssText = "position:absolute;display:none";
              cueLayer.appendChild(slot);
              document.__pfBenchSlots.push(slot);
            }
          },
          () => {
            const slots = document.__pfBenchSlots;
            const idx = document.__pfBenchIdx;
            for (let j = 0; j < 8; j++) {
              slots[j].style.display = "";
              slots[j].textContent = `Cue ${j}: Updated text at ${idx}`;
            }
            void document.__pfBenchCueLayer.offsetHeight;
            for (let j = 0; j < 8; j++) {
              slots[j].style.display = "none";
            }
          },
          { args: [i] }
        );
        timings.push(perOp);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      batchUpdateTimes.push(batchMedian);
    }

    batchUpdateTimes.sort((a, b) => a - b);
    results.push({
      name: "batch cue update (8 slots, show + text + hide)",
      medianMsPerOp: batchUpdateTimes[Math.floor(batchUpdateTimes.length / 2)],
      spread: (batchUpdateTimes[batchUpdateTimes.length - 1] - batchUpdateTimes[0]) / batchUpdateTimes[Math.floor(batchUpdateTimes.length / 2)],
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}
