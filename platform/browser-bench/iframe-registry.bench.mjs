/**
 * Iframe-registry mutation cost browser benchmark.
 *
 * The frame bridge keeps a live iframe cache (src/shared/context.js) backed by
 * a document-wide childList+subtree observer that lives for the whole page.
 * This benchmark drives non-iframe mutation bursts over a page hosting several
 * iframes and times the microtask checkpoint that flushes the cache's diff,
 * against a no-script control page running the identical protocol.
 *
 * The delta between the two rows is the steady-state cost the observer pays
 * per mutation batch on SPA-style churn - the number the differential diff
 * (scoped added-subtree scans instead of a full-document reseed) is meant to
 * shrink toward zero.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 8;
const FRAME_COUNT = 8;
const CHURN_NODES = 120;

/** One churn burst: append + remove a subtree of `churn` unrelated nodes and
 *  resolve after the microtask checkpoint that flushes the observer. The
 *  double continuation guarantees the MutationObserver callback queued by this
 *  burst has run before the promise settles (the second chain runs after the
 *  observer's microtask). The burst is idempotent - it removes exactly what it
 *  appended - so it can be repeated inside one amplified timed region. */
const burstOp = (churn) => new Promise((resolve) => {
  const host = document.createElement("div");
  host.className = "pf-bench-churn";
  for (let i = 0; i < churn; i++) {
    host.appendChild(document.createElement("div"));
  }
  document.body.appendChild(host);
  Promise.resolve().then(() => Promise.resolve()).then(() => {
    host.remove();
    resolve();
  });
});

/** Batch/iteration loop mirroring the other browser benches: per-batch median
 *  burst time, then median + spread across batches.
 *
 *  Amplified: the bare burst is ~0.1ms, i.e. at the 100us Chromium
 *  performance.now() tick, so isolated samples quantise to 0 and the row
 *  collapsed to 0.00. The op is async (it must yield for the observer's
 *  microtask), so it runs through amplifiedEvalAsync: the op is awaited tens
 *  of times per 25ms sample and the elapsed time divided back down. */
async function measureBurst(driver, churn) {
  const samples = [];
  for (let b = 0; b < BATCHES; b++) {
    const timings = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { perOp } = await driver.amplifiedEvalAsync(null, burstOp, { args: [churn] });
      timings.push(perOp);
    }
    timings.sort((a, b) => a - b);
    samples.push(timings[Math.floor(timings.length / 2)]);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return {
    medianMsPerOp: median,
    spread: (samples[samples.length - 1] - samples[0]) / median,
  };
}

export default async function runIframeRegistryBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await ChromiumDriver.launch();
  const results = [];
  const suffix = `${CHURN_NODES} nodes/burst`;

  try {
    // Control: identical protocol, no userscript - isolates pure DOM churn.
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.eval((frameCount) => {
      for (let i = 0; i < frameCount; i++) {
        const f = document.createElement("iframe");
        f.setAttribute("data-pf-bench-frame", "");
        f.style.display = "none";
        document.body.appendChild(f);
      }
    }, FRAME_COUNT);
    results.push({
      name: `mutation burst, no PF (${suffix}, ${FRAME_COUNT} iframes)`,
      ...(await measureBurst(driver, CHURN_NODES)),
    });

    // Active: the bundle's bridge installs the iframe-cache observer; the
    // frame set populates the cache so the sweep/scan has entries to process.
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript(bundle);
    results.push({
      name: `mutation burst, PF iframe cache live (${suffix}, ${FRAME_COUNT} iframes)`,
      ...(await measureBurst(driver, CHURN_NODES)),
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}