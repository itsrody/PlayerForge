/**
 * Switchboard nested frame lifecycle integration tests.
 *
 * Tests lifecycle management when each switchboard child is itself a
 * nested iframe pair: parent → relay (serverA) → video (serverB).
 * This creates a 3-deep hierarchy with 2 cross-origin hops, testing
 * the frame bridge relay across multiple origins under dynamic load/unload.
 *
 * Uses a shared browser instance across all tests for speed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GeckoDriver,
  TestServer,
  createSwitchboardPage,
  createNestedSwitchboardChildPage,
  createMultiOriginServersN,
} from "../harness/firefox.mjs";

const CHILD_COUNT = 4;

let driver;
let relayServers;
let videoServers;
let parentServer;
let childEntries;

test.before(async () => {
  relayServers = await createMultiOriginServersN(CHILD_COUNT);
  videoServers = await createMultiOriginServersN(CHILD_COUNT);
  parentServer = new TestServer();
  await parentServer.start();
  childEntries = relayServers.map((relay, i) => ({
    name: `Relay ${i}`,
    url: createNestedSwitchboardChildPage(relay, videoServers[i], { name: `Slot ${i}` }),
  }));
  driver = await GeckoDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await parentServer?.stop();
  for (const s of relayServers) await s.stop();
  for (const s of videoServers) await s.stop();
});

async function freshPage() {
  const url = createSwitchboardPage(parentServer, childEntries);
  await driver.navigate(url);
  await driver.injectGMStubs();
  await driver.injectScript();
}

async function loadNestedChild(index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 300));
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().frame(0);
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().defaultContent();
}

async function detectNestedShell(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await driver.raw.switchTo().frame(0);
    await driver.raw.switchTo().frame(0);
    let found = false;
    try {
      found = await driver.raw.executeScript(() => {
        const host = document.querySelector(".pf-shell");
        return !!host?.shadowRoot?.querySelector(".pf-hud-layer");
      });
    } catch {}
    await driver.raw.switchTo().defaultContent();
    if (found) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function unloadAndWait() {
  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
}

// ── Tests ───────────────────────────────────────────────────────────

test("switchboard nested: shell boots in deepest video frame", async () => {
  await freshPage();
  await loadNestedChild(0);
  const hasHud = await detectNestedShell(10000);
  assert.ok(hasHud, "HUD layer should appear in deepest video frame via relay");
});

test("switchboard nested: cleanup propagates across nested frames on unload", async () => {
  await freshPage();
  await loadNestedChild(0);
  const hasHud = await detectNestedShell(10000);
  assert.ok(hasHud, "Shell should boot before unload test");

  await unloadAndWait();

  const iframeCount = await driver.eval(() => {
    return document.getElementById("iframe-slot")?.childElementCount ?? 0;
  });
  assert.equal(iframeCount, 0, "iframe-slot should be empty after unload");

  const activeIdx = await driver.eval(() => window.__getActiveIndex());
  assert.equal(activeIdx, -1, "activeIndex should be -1 after unload");
});

test("switchboard nested: activeForges does not accumulate after cycles", async () => {
  await freshPage();
  const cycles = 3;
  for (let i = 0; i < cycles; i++) {
    await loadNestedChild(i % CHILD_COUNT);
    await new Promise((r) => setTimeout(r, 300));
    await unloadAndWait();
  }

  await loadNestedChild(0);
  await new Promise((r) => setTimeout(r, 500));

  const forgeCount = await driver.raw.switchTo().frame(0).then(() =>
    driver.raw.switchTo().frame(0).then(() =>
      driver.raw.executeScript(() => document.querySelectorAll(".pf-shell").length)
    )
  ).finally(() => driver.raw.switchTo().defaultContent());

  assert.ok(forgeCount <= 1, `Should have at most 1 forge, got ${forgeCount}`);
});

test("switchboard nested: rapid load/unload does not crash at depth", async () => {
  await freshPage();
  const cycles = 6;
  const intervalMs = 200;

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
  await loadNestedChild(0);
  const hasHud = await detectNestedShell(10000);
  assert.ok(hasHud, "Shell should boot after rapid cycling at depth");
});

test("switchboard nested: switching servers replaces active nested child", async () => {
  await freshPage();
  await loadNestedChild(0);
  const idx0 = await driver.eval(() => window.__getActiveIndex());
  assert.equal(idx0, 0, "Active index should be 0 after first load");

  await driver.eval((i) => window.__switchTo(i), 1);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
  await new Promise((r) => setTimeout(r, 300));
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().frame(0);
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().defaultContent();

  const idx1 = await driver.eval(() => window.__getActiveIndex());
  assert.equal(idx1, 1, "Active index should be 1 after switch");

  const iframeCount = await driver.eval(() => {
    return document.getElementById("iframe-slot")?.childElementCount ?? 0;
  });
  assert.equal(iframeCount, 1, "Only 1 iframe should exist after switch");

  const hasHud = await detectNestedShell(10000);
  assert.ok(hasHud, "Shell should boot in switched nested child");
});
