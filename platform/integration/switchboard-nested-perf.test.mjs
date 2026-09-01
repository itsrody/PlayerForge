/**
 * Switchboard nested frame efficiency integration tests.
 *
 * Measures timing metrics for lifecycle operations when each child is a
 * nested iframe pair: parent → relay → video. Compares against flat
 * (depth-1) switchboard to quantify the relay overhead.
 *
 * Each test is self-contained: creates and tears down its own browser + servers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChromiumDriver,
  TestServer,
  createSwitchboardPage,
  createSwitchboardChildPage,
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

async function loadFlat(driver, index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 200));
  await driver.injectScriptInFrame(0);
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

async function unloadAndWait(driver) {
  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
}

// ── Tests ───────────────────────────────────────────────────────────

test("perf: nested boot time vs flat", async () => {
  // Flat setup.
  const flatServers = await createMultiOriginServersN(CHILD_COUNT);
  const flatParent = new TestServer();
  await flatParent.start();
  const flatEntries = flatServers.map((s, i) => ({
    name: `S${i}`,
    url: createSwitchboardChildPage(s, { name: `S${i}` }),
  }));

  // Nested setup.
  const relayServers = await createMultiOriginServersN(CHILD_COUNT);
  const videoServers = await createMultiOriginServersN(CHILD_COUNT);
  const nestedParent = new TestServer();
  await nestedParent.start();
  const nestedEntries = relayServers.map((relay, i) => ({
    name: `R${i}`,
    url: createNestedSwitchboardChildPage(relay, videoServers[i], { name: `S${i}` }),
  }));

  const driver = await ChromiumDriver.launch();
  const results = {};

  try {
    // Flat boot.
    const flatTimes = [];
    for (let run = 0; run < RUNS; run++) {
      const url = createSwitchboardPage(flatParent, flatEntries);
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript();
      const t0 = performance.now();
      await loadFlat(driver, 0);
      flatTimes.push(performance.now() - t0);
    }
    results.flat = median(flatTimes);

    // Nested boot.
    const nestedTimes = [];
    for (let run = 0; run < RUNS; run++) {
      const url = createSwitchboardPage(nestedParent, nestedEntries);
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript();
      const t0 = performance.now();
      await loadNested(driver, 0);
      nestedTimes.push(performance.now() - t0);
    }
    results.nested = median(nestedTimes);
  } finally {
    await driver.destroy();
    await flatParent.stop();
    await nestedParent.stop();
    for (const s of [...flatServers, ...relayServers, ...videoServers]) await s.stop();
  }

  const overhead = ((results.nested / results.flat - 1) * 100).toFixed(1);
  console.log(`\n  Boot time:`);
  console.log(`    flat (depth 1):   ${results.flat.toFixed(1)}ms`);
  console.log(`    nested (depth 2): ${results.nested.toFixed(1)}ms`);
  console.log(`    relay overhead:   +${overhead}%`);

  assert.ok(results.nested < 30000, `Nested boot too slow: ${results.nested}ms`);
});

test("perf: nested switch time vs flat", async () => {
  // Flat setup.
  const flatServers = await createMultiOriginServersN(CHILD_COUNT);
  const flatParent = new TestServer();
  await flatParent.start();
  const flatEntries = flatServers.map((s, i) => ({
    name: `S${i}`,
    url: createSwitchboardChildPage(s, { name: `S${i}` }),
  }));

  // Nested setup.
  const relayServers = await createMultiOriginServersN(CHILD_COUNT);
  const videoServers = await createMultiOriginServersN(CHILD_COUNT);
  const nestedParent = new TestServer();
  await nestedParent.start();
  const nestedEntries = relayServers.map((relay, i) => ({
    name: `R${i}`,
    url: createNestedSwitchboardChildPage(relay, videoServers[i], { name: `S${i}` }),
  }));

  const driver = await ChromiumDriver.launch();
  const results = {};

  try {
    // Flat switch.
    const flatTimes = [];
    for (let run = 0; run < RUNS; run++) {
      const url = createSwitchboardPage(flatParent, flatEntries);
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript();
      await loadFlat(driver, 0);
      const t0 = performance.now();
      await driver.eval((i) => window.__switchTo(i), 1);
      await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
      await new Promise((r) => setTimeout(r, 200));
      await driver.injectScriptInFrame(0);
      flatTimes.push(performance.now() - t0);
    }
    results.flat = median(flatTimes);

    // Nested switch.
    const nestedTimes = [];
    for (let run = 0; run < RUNS; run++) {
      const url = createSwitchboardPage(nestedParent, nestedEntries);
      await driver.navigate(url);
      await driver.injectGMStubs();
      await driver.injectScript();
      await loadNested(driver, 0);
      const t0 = performance.now();
      await driver.eval((i) => window.__switchTo(i), 1);
      await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
      await new Promise((r) => setTimeout(r, 300));
      await driver.injectScriptInFrame(0);
      await driver.raw.switchTo().frame(0);
      await driver.injectScriptInFrame(0);
      await driver.raw.switchTo().defaultContent();
      nestedTimes.push(performance.now() - t0);
    }
    results.nested = median(nestedTimes);
  } finally {
    await driver.destroy();
    await flatParent.stop();
    await nestedParent.stop();
    for (const s of [...flatServers, ...relayServers, ...videoServers]) await s.stop();
  }

  const overhead = ((results.nested / results.flat - 1) * 100).toFixed(1);
  console.log(`\n  Switch time (unload + load new):`);
  console.log(`    flat (depth 1):   ${results.flat.toFixed(1)}ms`);
  console.log(`    nested (depth 2): ${results.nested.toFixed(1)}ms`);
  console.log(`    relay overhead:   +${overhead}%`);

  assert.ok(results.nested < 30000, `Nested switch too slow: ${results.nested}ms`);
});

test("perf: nested report", async () => {
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
      await unloadAndWait(driver);
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

  console.log("\n  ── Nested Switchboard Efficiency Report ──");
  console.log(`  ${"metric".padEnd(45)} ${"median ms".padStart(12)}`);
  console.log("  " + "─".repeat(59));
  console.log(`  ${"boot (nested child load, depth 2)".padEnd(45)} ${bootMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"switch (unload + load new, depth 2)".padEnd(45)} ${switchMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"destroy (iframe unload, depth 2)".padEnd(45)} ${destroyMed.toFixed(1).padStart(12)}`);
  console.log();

  assert.ok(bootMed < 30000, `Boot too slow: ${bootMed}ms`);
  assert.ok(switchMed < 30000, `Switch too slow: ${switchMed}ms`);
  assert.ok(destroyMed < 5000, `Destroy too slow: ${destroyMed}ms`);
});
