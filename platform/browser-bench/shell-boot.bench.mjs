/**
 * Shell boot browser benchmark.
 *
 * Measures the time from navigation to HUD ready in a real Chromium 152 instance.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;

export default async function runShellBootBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  const driver = await ChromiumDriver.launch();
  const results = [];

  try {
    // Benchmark: full boot (navigate → inject → HUD visible).
    const bootTimes = [];
    for (let i = 0; i < BATCHES; i++) {
      const url = createTestPage(server);
      const t0 = performance.now();
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript(bundle);
      await waitForShell(driver, 5000);
      bootTimes.push(performance.now() - t0);
    }

    bootTimes.sort((a, b) => a - b);
    const median = bootTimes[Math.floor(bootTimes.length / 2)];
    const spread = (bootTimes[bootTimes.length - 1] - bootTimes[0]) / median;

    results.push({
      name: "shell boot (navigate → inject → HUD)",
      medianMsPerOp: median,
      spread,
    });

    // Benchmark: script injection only.
    const injectTimes = [];
    for (let i = 0; i < BATCHES; i++) {
      const url = createTestPage(server);
      await driver.navigate(url);
      await driver.injectGMStubs();
      const t0 = performance.now();
      await driver.injectScript(bundle);
      injectTimes.push(performance.now() - t0);
    }

    injectTimes.sort((a, b) => a - b);
    const injMedian = injectTimes[Math.floor(injectTimes.length / 2)];
    const injSpread = (injectTimes[injectTimes.length - 1] - injectTimes[0]) / injMedian;

    results.push({
      name: "script injection (injectScript only)",
      medianMsPerOp: injMedian,
      spread: injSpread,
    });
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}
