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
 *  return the wall time through the microtask checkpoint that flushes the
 *  observer. The double continuation guarantees the MutationObserver callback
 *  queued by this burst has run before the clock stops (the second chain runs
 *  after the observer's microtask). */
const burstTiming = (churn) => driver.eval(
  (n) => new Promise((resolve) => {
    const t0 = performance.now();
    const host = document.createElement("div");
    host.className = "pf-bench-churn";
    for (let i = 0; i < n; i++) {
      host.appendChild(document.createElement("div"));
    }
    document.body.appendChild(host);
    Promise.resolve().then(() => Promise.resolve()).then(() => {
      host.remove();
      resolve(performance.now() - t0);
    });
  }),
  churn
);

/** Batch/iteration loop mirroring the other browser benches: per-batch median
 *  burst time, then median + spread across batches. */
async function measureBurst(churn) {
  const samples = [];
  for (let b = 0; b < BATCHES; b++) {
    const timings = [];
    for (let i = 0; i < ITERATIONS; i++) {
      timings.push(await burstTiming(churn));
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
    await driver.eval(() => {
      for (let i = 0; i < FRAME_COUNT; i++) {
        const f = document.createElement("iframe");
        f.setAttribute("data-pf-bench-frame", "");
        f.style.display = "none";
        document.body.appendChild(f);
      }
    });
    results.push({
      name: `mutation burst, no PF (${suffix}, ${FRAME_COUNT} iframes)`,
      ...(await measureBurst(CHURN_NODES)),
    });

    // Active: the bundle's bridge installs the iframe-cache observer; the
    // frame set populates the cache so the sweep/scan has entries to process.
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript(bundle);
    results.push({
      name: `mutation burst, PF iframe cache live (${suffix}, ${FRAME_COUNT} iframes)`,
      ...(await measureBurst(CHURN_NODES)),
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}