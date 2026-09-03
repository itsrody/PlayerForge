/**
 * CSS layout browser benchmark.
 *
 * Measures panel toggle and style recalculation cost in Firefox 155.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GeckoDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 10;

export default async function runCssLayoutBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript(bundle);
    await waitForShell(driver, 8000);
    await waitForPanel(driver, 8000);

    // Benchmark: panel toggle open/close cycle.
    const toggleTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval(() => {
          return new Promise((resolve) => {
            const host = document.querySelector(".pf-shell");
            const t0 = performance.now();
            host.dispatchEvent(new CustomEvent("pf:gesture-panel", { bubbles: true }));
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                host.dispatchEvent(new CustomEvent("pf:gesture-panel", { bubbles: true }));
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    resolve(performance.now() - t0);
                  });
                });
              });
            });
          });
        });
        timings.push(elapsed);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      toggleTimes.push(batchMedian);
    }

    toggleTimes.sort((a, b) => a - b);
    results.push({
      name: "panel toggle open/close (2 rAF cycles)",
      medianMsPerOp: toggleTimes[Math.floor(toggleTimes.length / 2)],
      spread: (toggleTimes[toggleTimes.length - 1] - toggleTimes[0]) / toggleTimes[Math.floor(toggleTimes.length / 2)],
    });

    // Benchmark: forced style recalculation.
    const recalcTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval(() => {
          const host = document.querySelector(".pf-shell");
          const t0 = performance.now();
          host.classList.toggle("pf-layout-test");
          void host.offsetHeight;
          host.classList.toggle("pf-layout-test");
          void host.offsetHeight;
          return performance.now() - t0;
        });
        timings.push(elapsed);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      recalcTimes.push(batchMedian);
    }

    recalcTimes.sort((a, b) => a - b);
    results.push({
      name: "forced style recalculation (classList toggle + offsetHeight)",
      medianMsPerOp: recalcTimes[Math.floor(recalcTimes.length / 2)],
      spread: (recalcTimes[recalcTimes.length - 1] - recalcTimes[0]) / recalcTimes[Math.floor(recalcTimes.length / 2)],
    });

    // Benchmark: adopted stylesheet swap.
    const swapTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await driver.eval(() => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(".pf-bench-swap { color: red; }");
          const t0 = performance.now();
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          void document.body.offsetHeight;
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
          return performance.now() - t0;
        });
        timings.push(elapsed);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      swapTimes.push(batchMedian);
    }

    swapTimes.sort((a, b) => a - b);
    results.push({
      name: "adopted stylesheet add/remove cycle",
      medianMsPerOp: swapTimes[Math.floor(swapTimes.length / 2)],
      spread: (swapTimes[swapTimes.length - 1] - swapTimes[0]) / swapTimes[Math.floor(swapTimes.length / 2)],
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}
