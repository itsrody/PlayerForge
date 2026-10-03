/**
 * CSS layout browser benchmark.
 *
 * Measures panel toggle and style recalculation cost in a real Firefox on the 157+ floor.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 40;

export default async function runCssLayoutBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  // The native harness registers the userscript once at startup, so a
  // custom build is chosen at launch rather than injected afterwards.
  const driver = await FirefoxDriver.launch({ bundle });
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
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
    //
    // The op writes --pf-media-paused on the host, which is a real style
    // path in the shipped sheet: a registered @property feeding
    // `opacity: calc(1 - 0.3 * var(--pf-media-paused))` on .pf-visible, so
    // the write invalidates the dependent rule instead of a no-op class. The
    // previous "pf-layout-test" class matched no rule anywhere in src/ or the
    // built CSS, so the row measured an invalidation with nothing behind it.
    //
    // Amplified, and the reason is stability rather than visibility. A single
    // isolated op is only a few clock ticks, so per-shot samples are wildly
    // variable - measured ±1450% across 120 raw samples in the same process -
    // because each sample is a small integer number of ticks and picks up GC
    // and first-call outliers. Divided over a 25ms budget the same op reports
    // ±1-8%, which is the only reason a +/-20% gate is meaningful here.
    //
    // Consequence: the amplified number is a back-to-back average, not the
    // cost of one op in isolation. It is the right quantity to compare
    // against, because the methodology is identical on both sides of a code
    // change, but do not read it as isolated-op latency. Toggle the property
    // back and forth so the op is idempotent and can repeat safely.
    const recalcTimes = [];
    for (let b = 0; b < BATCHES; b++) {
      const timings = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const { perOp } = await driver.amplifiedEval(
          () => {
            document.__pfBenchShell = document.querySelector(".pf-shell");
          },
          () => {
            const host = document.__pfBenchShell;
            host.style.setProperty("--pf-media-paused", "1");
            void host.offsetHeight;
            host.style.setProperty("--pf-media-paused", "0");
            void host.offsetHeight;
          }
        );
        timings.push(perOp);
      }
      const batchMedian = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
      recalcTimes.push(batchMedian);
    }

    recalcTimes.sort((a, b) => a - b);
    results.push({
      name: "forced style recalc + layout (--pf-media-paused write, amplified)",
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
