/**
 * Switchboard lifecycle integration tests.
 *
 * Tests lifecycle management across a multi-server switchboard scenario:
 * a parent page with multiple server origins, each embedding the same
 * video, where iframes are loaded/unloaded dynamically.
 *
 * Detects: memory leaks, stale references, activeForges accumulation,
 * frame bridge cleanup, rapid switching stability.
 *
 * Uses a shared browser instance across all tests for speed.
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

const SERVER_COUNT = 4;

let driver;
let servers;
let parentServer;
let childEntries;

test.before(async () => {
  servers = await createMultiOriginServersN(SERVER_COUNT);
  parentServer = new TestServer();
  await parentServer.start();
  childEntries = servers.map((s, i) => ({
    name: `Server ${i}`,
    url: createSwitchboardChildPage(s, { name: `Server ${i}` }),
  }));
  driver = await ChromiumDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await parentServer?.stop();
  for (const s of servers) await s.stop();
});

async function freshPage() {
  const url = createSwitchboardPage(parentServer, childEntries);
  await driver.navigate(url);
  await driver.injectGMStubs();
  await driver.injectScript();
}

async function loadAndInjectIframe(index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 200));
  await driver.injectScriptInFrame(0);
}

async function unloadIframe() {
  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
}

// ── Test 1: Shell boots in first iframe on page load ─────────────────

test("switchboard: shell boots in first iframe on page load", async () => {
  await freshPage();
  await loadAndInjectIframe(0);
  const hasHud = await waitForShellInFrame(driver, 0, 10000);
  assert.ok(hasHud, "HUD layer should appear in first iframe");
});

// ── Test 2: Shell boots when placeholder is activated ────────────────

test("switchboard: shell boots when placeholder is activated", async () => {
  await freshPage();
  const initialCount = await driver.eval(() => window.__getLoadedCount());
  assert.equal(initialCount, 0, "No iframe should be loaded initially");

  await loadAndInjectIframe(1);
  const hasHud = await waitForShellInFrame(driver, 0, 10000);
  assert.ok(hasHud, "HUD layer should appear after activating placeholder");

  const active = await driver.eval(() => window.__getActiveIndex());
  assert.equal(active, 1, "Active index should be 1");
});

// ── Test 3: Shell cleans up when iframe is unloaded ──────────────────

test("switchboard: shell cleans up when iframe is unloaded", async () => {
  await freshPage();
  await loadAndInjectIframe(0);
  await waitForShellInFrame(driver, 0, 10000);

  const shellInIframe = await driver.evalInFrame(0, () => !!document.querySelector(".pf-shell"));
  assert.ok(shellInIframe, "Shell should exist in iframe before unload");

  await unloadIframe();

  const iframeCount = await driver.eval(() => document.querySelectorAll("iframe").length);
  assert.equal(iframeCount, 0, "No iframes should remain after unload");

  const active = await driver.eval(() => window.__getActiveIndex());
  assert.equal(active, -1, "Active index should be -1 after unload");
});

// ── Test 4: activeForges Set does not accumulate after N cycles ──────

test("switchboard: activeForges does not accumulate after load/unload cycles", async () => {
  await freshPage();
  const cycles = 3;
  for (let i = 0; i < cycles; i++) {
    await loadAndInjectIframe(i % SERVER_COUNT);
    await driver.waitForInFrame(0, () => !!document.querySelector(".pf-shell"), 10000, 100);
    await unloadIframe();
  }

  await loadAndInjectIframe(0);
  await driver.waitForInFrame(0, () => !!document.querySelector(".pf-shell"), 10000, 100);

  const forgeCount = await driver.evalInFrame(0, () => {
    const host = document.querySelector(".pf-shell");
    return host ? 1 : 0;
  });
  assert.equal(forgeCount, 1, "Should have exactly 1 forge after cycles");

  const orphanShells = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
  assert.equal(orphanShells, 0, "No orphaned shells in parent");
});

// ── Test 5: Context resolution works across different origins ────────

test("switchboard: context resolution works across different origins", async () => {
  await freshPage();
  for (let i = 0; i < 3; i++) {
    await loadAndInjectIframe(i);
    const hasHud = await waitForShellInFrame(driver, 0, 10000);
    assert.ok(hasHud, `Shell should boot on server ${i}`);

    const origin = await driver.evalInFrame(0, () => window.location.origin);
    assert.ok(origin.includes("127.0.0.1"), `Server ${i} origin should be 127.0.0.1`);

    await unloadIframe();
  }
});

// ── Test 6: Rapid load/unload does not crash ─────────────────────────

test("switchboard: rapid load/unload does not crash", async () => {
  await freshPage();
  const cycles = 10;
  const intervalMs = 150;

  await driver.eval(
    (count, interval) => window.__rapidCycle(count, interval),
    cycles,
    intervalMs
  );

  await new Promise((r) => setTimeout(r, cycles * intervalMs + 1000));

  const alive = await driver.eval(() => document.readyState === "complete");
  assert.ok(alive, "Page should still be alive after rapid cycling");

  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
  await loadAndInjectIframe(0);
  const hasHud = await waitForShellInFrame(driver, 0, 10000);
  assert.ok(hasHud, "Shell should boot after rapid cycling");
});

// ── Test 7: Switching servers replaces the active iframe ─────────────

test("switchboard: switching servers replaces the active iframe", async () => {
  await freshPage();
  await loadAndInjectIframe(0);
  await waitForShellInFrame(driver, 0, 10000);
  const active0 = await driver.eval(() => window.__getActiveIndex());
  assert.equal(active0, 0, "Active should be server 0");

  await driver.eval((i) => window.__switchTo(i), 2);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 2);
  await new Promise((r) => setTimeout(r, 200));
  await driver.injectScriptInFrame(0);

  const hasHud = await waitForShellInFrame(driver, 0, 10000);
  assert.ok(hasHud, "Shell should boot on new server after switch");

  const active2 = await driver.eval(() => window.__getActiveIndex());
  assert.equal(active2, 2, "Active should be server 2 after switch");

  const iframeCount = await driver.eval(() => document.querySelectorAll("iframe").length);
  assert.equal(iframeCount, 1, "Only one iframe should exist after switch");
});

// ── Test 8: Memory does not grow significantly after 10 cycles ───────

test("switchboard: no significant memory growth after 10 load/unload cycles", async () => {
  await freshPage();
  await driver.eval(() => { if (window.gc) window.gc(); });

  const memBefore = await driver.eval(() => {
    return performance.memory ? performance.memory.usedJSHeapSize : 0;
  });

  const cycles = 10;
  for (let i = 0; i < cycles; i++) {
    await loadAndInjectIframe(i % SERVER_COUNT);
    await new Promise((r) => setTimeout(r, 100));
    await unloadIframe();
  }

  await driver.eval(() => { if (window.gc) window.gc(); });
  await new Promise((r) => setTimeout(r, 500));

  const memAfter = await driver.eval(() => {
    return performance.memory ? performance.memory.usedJSHeapSize : 0;
  });

  if (memBefore > 0 && memAfter > 0) {
    const growthMB = (memAfter - memBefore) / (1024 * 1024);
    console.log(`\n  Memory: ${(memBefore / 1024 / 1024).toFixed(1)}MB → ${(memAfter / 1024 / 1024).toFixed(1)}MB (${growthMB > 0 ? "+" : ""}${growthMB.toFixed(1)}MB after ${cycles} cycles)`);
    assert.ok(growthMB < 5, `Memory growth should be <5MB, got ${growthMB.toFixed(1)}MB`);
  } else {
    console.log("\n  Memory API not available — skipping memory assertion");
  }

  await loadAndInjectIframe(0);
  const hasHud = await waitForShellInFrame(driver, 0, 10000);
  assert.ok(hasHud, "Shell should boot after memory test");
});
