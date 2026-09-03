/**
 * Iframe efficiency integration tests.
 *
 * Measures timing metrics across four video embedding scenarios:
 *   1. Direct embedded video (baseline)
 *   2. Same-origin iframe
 *   3. Cross-origin iframe
 *   4. Nested iframe (cross-origin relay)
 *
 * Each metric is measured 3 times, median reported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GeckoDriver,
  TestServer,
  createTestPage,
  createIframeChildPage,
  createIframeParentPage,
  createNestedIframePages,
  createMultiOriginServers,
} from "../harness/firefox.mjs";
import { waitForShell, waitForShellInFrame } from "../harness/page.mjs";

const RUNS = 3;

// ── Helpers ──────────────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function msSince(start) {
  return performance.now() - start;
}

/**
 * Measure shell boot time for a direct video page.
 */
async function measureDirect(driver, server) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await waitForShell(driver, 8000);
    times.push(msSince(t0));
  }
  return median(times);
}

/**
 * Measure shell boot time for a same-origin iframe.
 */
async function measureSameOrigin(driver, server) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const childUrl = createIframeChildPage(server);
    const parentUrl = createIframeParentPage(server, childUrl);
    const t0 = performance.now();
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    times.push(msSince(t0));
  }
  return median(times);
}

/**
 * Measure shell boot time for a cross-origin iframe.
 */
async function measureCrossOrigin(driver, servers) {
  const { serverA, serverB } = servers;
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const childUrl = createIframeChildPage(serverB);
    const parentUrl = createIframeParentPage(serverA, childUrl);
    const t0 = performance.now();
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    times.push(msSince(t0));
  }
  return median(times);
}

/**
 * Measure shell boot time for a nested iframe (cross-origin relay).
 */
async function measureNested(driver, servers) {
  const { serverA, serverB } = servers;
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const { parentUrl } = createNestedIframePages(serverA, serverB);
    const t0 = performance.now();
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await driver.raw.switchTo().frame(0);
    await driver.injectScriptInFrame(0);
    await driver.raw.switchTo().defaultContent();
    await driver.waitForInFrame(
      0,
      () => {
        const innerFrame = document.getElementById("inner-frame");
        if (!innerFrame?.contentDocument) return false;
        const host = innerFrame.contentDocument.querySelector(".pf-shell");
        return !!host?.shadowRoot?.querySelector(".pf-hud-layer");
      },
      10000,
      200
    );
    times.push(msSince(t0));
  }
  return median(times);
}

// ── Tests ────────────────────────────────────────────────────────────

let results = {};

test("measure: direct video", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    results.direct = await measureDirect(driver, server);
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

test("measure: same-origin iframe", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    results.sameOrigin = await measureSameOrigin(driver, server);
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

test("measure: cross-origin iframe", async () => {
  const servers = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    results.crossOrigin = await measureCrossOrigin(driver, servers);
  } finally {
    await driver.destroy();
    await servers.serverA.stop();
    await servers.serverB.stop();
  }
});

test("measure: nested iframe", async () => {
  const servers = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    results.nested = await measureNested(driver, servers);
  } finally {
    await driver.destroy();
    await servers.serverA.stop();
    await servers.serverB.stop();
  }
});

test("report: efficiency comparison", async () => {
  const { direct, sameOrigin, crossOrigin, nested } = results;
  assert.ok(direct > 0, "Direct measurement should be positive");

  console.log("\n  ── Iframe Efficiency Report ──");
  console.log(`  ${"scenario".padEnd(30)} ${"median ms".padStart(12)} ${"vs direct".padStart(12)}`);
  console.log("  " + "─".repeat(56));
  console.log(`  ${"direct (baseline)".padEnd(30)} ${direct.toFixed(1).padStart(12)} ${"—".padStart(12)}`);
  console.log(`  ${"same-origin iframe".padEnd(30)} ${sameOrigin.toFixed(1).padStart(12)} ${((sameOrigin / direct - 1) * 100).toFixed(0).padStart(11)}%`);
  console.log(`  ${"cross-origin iframe".padEnd(30)} ${crossOrigin.toFixed(1).padStart(12)} ${((crossOrigin / direct - 1) * 100).toFixed(0).padStart(11)}%`);
  console.log(`  ${"nested iframe (relay)".padEnd(30)} ${nested.toFixed(1).padStart(12)} ${((nested / direct - 1) * 100).toFixed(0).padStart(11)}%`);
  console.log();

  // All scenarios should boot within a reasonable time (30 seconds).
  assert.ok(direct < 30000, `Direct boot too slow: ${direct}ms`);
  assert.ok(sameOrigin < 30000, `Same-origin boot too slow: ${sameOrigin}ms`);
  assert.ok(crossOrigin < 30000, `Cross-origin boot too slow: ${crossOrigin}ms`);
  assert.ok(nested < 30000, `Nested boot too slow: ${nested}ms`);
});
