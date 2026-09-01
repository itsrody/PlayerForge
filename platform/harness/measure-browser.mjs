/**
 * Browser-side benchmark harness for ChromiumDriver integration.
 *
 * Mirrors the adaptive calibration + multi-batch sampling strategy from
 * bench/lib.mjs but runs inside the browser page via Runtime.evaluate.
 * Reports median ms/op (not ns/op) since browser timing has higher variance.
 *
 * Usage:
 *   import { measureBrowser } from "./harness/measure-browser.mjs";
 *   const results = await measureBrowser(driver, [
 *     measureBrowser.case("shell boot", async () => {
 *       await driver.injectScript(bundle);
 *       return performance.now() - t0;
 *     }),
 *   ]);
 */
const BATCHES = 7;
const WARMUP_MS = 30;
const BATCH_TARGET_MS = 50;

/**
 * Calibrate iteration count in the browser for one benchmark case.
 */
async function calibrateBrowser(driver, fn, iters) {
  const result = await driver.eval(
    (fnStr, n) => {
      const fn = new Function("return (" + fnStr + ")")();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      return performance.now() - t0;
    },
    fn.toString(),
    iters
  );
  return result;
}

/**
 * Run a browser benchmark case with adaptive calibration.
 *
 * @param {import('./chromium.mjs').ChromiumDriver} driver
 * @param {string} name
 * @param {string} fnStr - Function source that returns a measurable value.
 * @param {object} [options]
 * @param {number} [options.warmupMs=WARMUP_MS]
 * @param {number} [options.batches=BATCHES]
 * @returns {Promise<{name: string, medianMsPerOp: number, spread: number}>}
 */
export async function measureBrowserCase(driver, name, fnStr, options = {}) {
  const { warmupMs = WARMUP_MS, batches = BATCHES } = options;

  // Warmup: run for warmupMs to let V8 JIT compile.
  await driver.eval(
    (src, ms) => {
      const fn = new Function("return (" + src + ")")();
      const deadline = performance.now() + ms;
      do { fn(); } while (performance.now() < deadline);
    },
    fnStr,
    warmupMs
  );

  // Calibration: find iterations per batch.
  let iters = 1;
  for (let i = 0; i < 20; i++) {
    const ms = await calibrateBrowser(driver, fnStr, iters);
    if (ms >= BATCH_TARGET_MS) break;
    iters = Math.min(2 ** 24, Math.ceil((iters * BATCH_TARGET_MS * 1.3) / Math.max(ms, 0.01)));
  }

  // Sampling: run batches and collect timings.
  const samples = [];
  for (let b = 0; b < batches; b++) {
    const ms = await driver.eval(
      (src, n) => {
        const fn = new Function("return (" + src + ")")();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        return performance.now() - t0;
      },
      fnStr,
      iters
    );
    samples.push(ms / iters);
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const spread = (samples[samples.length - 1] - samples[0]) / median;

  return { name, medianMsPerOp: median, spread };
}

/**
 * Helper to create a benchmark case descriptor.
 */
export function browserBenchCase(name, fn) {
  return { name, fn };
}
