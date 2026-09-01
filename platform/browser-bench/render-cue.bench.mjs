/**
 * Render cue browser benchmark.
 *
 * Measures subtitle cue DOM operation cost in Chromium 152.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 50;

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
    const cueSlotTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval((idx) => {
          const host = document.querySelector(".pf-shell");
          const shadow = host?.shadowRoot;
          const cueLayer = shadow?.querySelector(".pf-cue-layer");
          if (!cueLayer) return 0;
          const t0 = performance.now();
          const slot = document.createElement("div");
          slot.className = "pf-cue";
          slot.setAttribute("role", "caption");
          slot.textContent = `Cue ${idx}: Some subtitle text here`;
          slot.style.cssText = "position:absolute;bottom:10%;left:50%;transform:translateX(-50%)";
          cueLayer.appendChild(slot);
          void slot.offsetHeight;
          cueLayer.removeChild(slot);
          return performance.now() - t0;
        }, i);
        timings.push(elapsed);
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
    const batchUpdateTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval((idx) => {
          const host = document.querySelector(".pf-shell");
          const shadow = host?.shadowRoot;
          const cueLayer = shadow?.querySelector(".pf-cue-layer");
          if (!cueLayer) return 0;
          const slots = [];
          for (let j = 0; j < 8; j++) {
            const slot = document.createElement("div");
            slot.className = "pf-cue";
            slot.setAttribute("role", "caption");
            slot.style.cssText = "position:absolute;display:none";
            cueLayer.appendChild(slot);
            slots.push(slot);
          }
          const t0 = performance.now();
          for (let j = 0; j < 8; j++) {
            slots[j].style.display = "";
            slots[j].textContent = `Cue ${j}: Updated text at ${idx}`;
          }
          void cueLayer.offsetHeight;
          for (let j = 0; j < 8; j++) {
            slots[j].style.display = "none";
          }
          const elapsed = performance.now() - t0;
          for (const slot of slots) cueLayer.removeChild(slot);
          return elapsed;
        }, i);
        timings.push(elapsed);
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
