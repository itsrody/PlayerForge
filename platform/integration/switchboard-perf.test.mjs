/**
 * Switchboard efficiency integration tests.
 *
 * Measures timing metrics for lifecycle operations across a multi-server
 * switchboard scenario using a single shared browser instance.
 *
 * Each metric measured 3 times, median reported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChromiumDriver,
  TestServer,
  createSwitchboardPage,
  createSwitchboardChildPage,
  createMultiOriginServersN,
} from "../harness/chromium.mjs";
import { waitForShellInFrame } from "../harness/page.mjs";

const RUNS = 3;
const SERVER_COUNT = 3;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

let driver;
let servers;
let parentServer;

test.before(async () => {
  servers = await createMultiOriginServersN(SERVER_COUNT);
  parentServer = new TestServer();
  await parentServer.start();

  const childEntries = servers.map((s, i) => ({
    name: `Server ${i}`,
    url: createSwitchboardChildPage(s, { name: `Server ${i}` }),
  }));

  const parentUrl = createSwitchboardPage(parentServer, childEntries);
  driver = await ChromiumDriver.launch();
  await driver.navigate(parentUrl);
  await driver.injectGMStubs();
  await driver.injectScript();
});

test.after(async () => {
  await driver?.destroy();
  await parentServer?.stop();
  for (const s of servers) await s.stop();
});

async function freshPage() {
  const childEntries = servers.map((s, i) => ({
    name: `Server ${i}`,
    url: createSwitchboardChildPage(s, { name: `Server ${i}` }),
  }));
  const parentUrl = createSwitchboardPage(parentServer, childEntries);
  await driver.navigate(parentUrl);
  await driver.injectGMStubs();
  await driver.injectScript();
}

async function loadAndBoot(index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 200));
  await driver.injectScriptInFrame(0);
  await waitForShellInFrame(driver, 0, 10000);
}

async function unloadAndWait() {
  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
}

// ── Metric 1: Boot time (first iframe load) ─────────────────────────

test("perf: boot time", async () => {
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    await freshPage();
    const t0 = performance.now();
    await loadAndBoot(0);
    times.push(performance.now() - t0);
  }
  const med = median(times);
  console.log(`\n  Boot time (first iframe): ${med.toFixed(1)}ms median`);
  assert.ok(med < 15000, `Boot too slow: ${med}ms`);
});

// ── Metric 2: Switch time (unload + load new server) ────────────────

test("perf: switch time", async () => {
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    await freshPage();
    await loadAndBoot(0);
    const t0 = performance.now();
    await driver.eval((i) => window.__switchTo(i), 1);
    await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
    await new Promise((r) => setTimeout(r, 200));
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    times.push(performance.now() - t0);
  }
  const med = median(times);
  console.log(`  Switch time (unload+load): ${med.toFixed(1)}ms median`);
  assert.ok(med < 15000, `Switch too slow: ${med}ms`);
});

// ── Metric 3: Rapid cycle throughput ─────────────────────────────────

test("perf: rapid cycle throughput", async () => {
  await freshPage();
  const cycleCount = 10;
  const t0 = performance.now();
  await driver.eval(
    (count, interval) => window.__rapidCycle(count, interval),
    cycleCount,
    100
  );
  await new Promise((r) => setTimeout(r, cycleCount * 100 + 1000));
  const elapsed = performance.now() - t0;
  const throughput = (cycleCount / elapsed * 1000).toFixed(1);
  console.log(`  Rapid cycle throughput: ${throughput} cycles/sec (${cycleCount} cycles in ${(elapsed / 1000).toFixed(1)}s)`);
  assert.ok(parseFloat(throughput) > 1, "Throughput should be >1 cycle/sec");
});

// ── Metric 4: Destroy time (iframe unload) ───────────────────────────

test("perf: destroy time", async () => {
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    await freshPage();
    await loadAndBoot(0);
    const t0 = performance.now();
    await unloadAndWait();
    times.push(performance.now() - t0);
  }
  const med = median(times);
  console.log(`  Destroy time (unload): ${med.toFixed(1)}ms median`);
  assert.ok(med < 5000, `Destroy too slow: ${med}ms`);
});

// ── Metric 5: Full report ───────────────────────────────────────────

test("perf: report", async () => {
  const bootTimes = [];
  const switchTimes = [];
  const destroyTimes = [];

  for (let run = 0; run < RUNS; run++) {
    await freshPage();

    let t0 = performance.now();
    await loadAndBoot(0);
    bootTimes.push(performance.now() - t0);

    t0 = performance.now();
    await driver.eval(() => window.__switchTo(1));
    await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
    await new Promise((r) => setTimeout(r, 200));
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    switchTimes.push(performance.now() - t0);

    t0 = performance.now();
    await unloadAndWait();
    destroyTimes.push(performance.now() - t0);
  }

  const bootMed = median(bootTimes);
  const switchMed = median(switchTimes);
  const destroyMed = median(destroyTimes);

  console.log("\n  ── Switchboard Efficiency Report ──");
  console.log(`  ${"metric".padEnd(35)} ${"median ms".padStart(12)}`);
  console.log("  " + "─".repeat(49));
  console.log(`  ${"boot (first iframe load)".padEnd(35)} ${bootMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"switch (unload + load new)".padEnd(35)} ${switchMed.toFixed(1).padStart(12)}`);
  console.log(`  ${"destroy (iframe unload)".padEnd(35)} ${destroyMed.toFixed(1).padStart(12)}`);
  console.log();

  assert.ok(bootMed < 15000, `Boot too slow: ${bootMed}ms`);
  assert.ok(switchMed < 15000, `Switch too slow: ${switchMed}ms`);
  assert.ok(destroyMed < 5000, `Destroy too slow: ${destroyMed}ms`);
});
