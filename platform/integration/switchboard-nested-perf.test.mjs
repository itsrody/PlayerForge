/**
 * Switchboard nested frame efficiency integration tests.
 *
 * Measures timing metrics for lifecycle operations when each child is a
 * nested iframe pair: parent → relay → video. All metrics collected in
 * a single browser session for speed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChromiumDriver,
  TestServer,
  createSwitchboardPage,
  createNestedSwitchboardChildPage,
  createMultiOriginServersN,
} from "../harness/chromium.mjs";

const RUNS = 2;
const CHILD_COUNT = 3;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function loadNested(driver, index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 300));
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().frame(0);
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().defaultContent();
}

test("perf: nested switchboard efficiency report", async () => {
  const relayServers = await createMultiOriginServersN(CHILD_COUNT);
  const videoServers = await createMultiOriginServersN(CHILD_COUNT);
  const parentServer = new TestServer();
  await parentServer.start();
  const childEntries = relayServers.map((relay, i) => ({
    name: `R${i}`,
    url: createNestedSwitchboardChildPage(relay, videoServers[i], { name: `S${i}` }),
  }));

  const driver = await ChromiumDriver.launch();
  const bootTimes = [];
  const switchTimes = [];
  const destroyTimes = [];

  try {
    for (let run = 0; run < RUNS; run++) {
      const url = createSwitchboardPage(parentServer, childEntries);
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript();

      let t0 = performance.now();
      await loadNested(driver, 0);
      bootTimes.push(performance.now() - t0);

      t0 = performance.now();
      await driver.eval((i) => window.__switchTo(i), 1);
      await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
      await new Promise((r) => setTimeout(r, 300));
      await driver.injectScriptInFrame(0);
      await driver.raw.switchTo().frame(0);
      await driver.injectScriptInFrame(0);
      await driver.raw.switchTo().defaultContent();
      switchTimes.push(performance.now() - t0);

      t0 = performance.now();
      await driver.eval(() => window.__unloadIframe());
      await new Promise((r) => setTimeout(r, 300));
      destroyTimes.push(performance.now() - t0);
    }
  } finally {
    await driver.destroy();
    await parentServer.stop();
    for (const s of [...relayServers, ...videoServers]) await s.stop();
  }

  const bootMed = median(bootTimes);
  const switchMed = median(switchTimes);
  const destroyMed = median(destroyTimes);

  console.log(`\n  ${"metric".padEnd(45)} ${"median ms".padStart(12)}`);
  console.log("  " + "─".repeat(59));
  console.log(`  ${"boot (nested child load, depth 2)".padEnd(45)} ${bootMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"switch (unload + load new, depth 2)".padEnd(45)} ${switchMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"destroy (iframe unload, depth 2)".padEnd(45)} ${destroyMed.toFixed(1).padStart(12)}`);
  console.log();

  assert.ok(bootMed < 30000, `Boot too slow: ${bootMed}ms`);
  assert.ok(switchMed < 30000, `Switch too slow: ${switchMed}ms`);
  assert.ok(destroyMed < 5000, `Destroy too slow: ${destroyMed}ms`);
});
