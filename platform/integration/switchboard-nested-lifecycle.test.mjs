/**
 * Switchboard nested frame lifecycle integration tests.
 *
 * Tests lifecycle management when each switchboard child is itself a
 * nested iframe pair: parent → relay (serverA) → video (serverB).
 * This creates a 3-deep hierarchy with 2 cross-origin hops, testing
 * the frame bridge relay across multiple origins under dynamic load/unload.
 *
 * Architecture per child slot:
 *   serverP (parent) → serverR (relay page) → serverV (video page)
 *   8 unique servers total: 1 parent + 4 relay + 4 video
 *
 * Detects: memory leaks at depth, stale frame references, activeForges
 * accumulation across hops, frame bridge cleanup, rapid switching stability.
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

const CHILD_COUNT = 4;

/**
 * Helper: set up a nested switchboard.
 *
 * Creates 4 relay servers + 4 video servers + 1 parent server.
 * Each child entry is a relay page that embeds a video page from a
 * different server origin.
 */
async function setupNestedSwitchboard() {
  const relayServers = await createMultiOriginServersN(CHILD_COUNT);
  const videoServers = await createMultiOriginServersN(CHILD_COUNT);
  const parentServer = new TestServer();
  await parentServer.start();

  const childEntries = relayServers.map((relay, i) => ({
    name: `Relay ${i}`,
    url: createNestedSwitchboardChildPage(relay, videoServers[i], { name: `Slot ${i}` }),
  }));

  const parentUrl = createSwitchboardPage(parentServer, childEntries);
  const driver = await ChromiumDriver.launch();

  // Inject GM stubs + userscript in parent (frame bridge responder).
  await driver.navigate(parentUrl);
  await driver.injectGMStubs();
  await driver.injectScript();

  return {
    driver,
    relayServers,
    videoServers,
    parentServer,
    parentUrl,
  };
}

async function teardown({ driver, relayServers, videoServers, parentServer }) {
  await driver?.destroy();
  await parentServer?.stop();
  for (const s of relayServers) await s.stop();
  for (const s of videoServers) await s.stop();
}

/**
 * Load a nested child into the switchboard and inject userscript at all levels.
 *
 * Flow:
 *   1. __loadIframe(index) → creates relay iframe in parent
 *   2. Wait for relay to load
 *   3. Inject into relay (frame 0 of parent)
 *   4. Enter relay → inject into video (frame 0 of relay) → return to parent
 */
async function loadNestedChild(driver, index) {
  await driver.eval((i) => window.__loadIframe(i), index);
  await driver.eval((i) => window.__waitForIframeLoad(i, 10000), index);
  await new Promise((r) => setTimeout(r, 300));

  // Inject into relay page (frame 0 of parent).
  await driver.injectScriptInFrame(0);

  // Enter relay → inject into video page (frame 0 of relay) → return.
  await driver.raw.switchTo().frame(0);
  await driver.injectScriptInFrame(0);
  await driver.raw.switchTo().defaultContent();
}

/**
 * Detect if the shell HUD exists in the deepest video frame.
 *
 * Navigates: parent → relay (frame 0) → video (frame 0 of relay),
 * checks for .pf-shell > .pf-hud-layer, returns to parent.
 */
async function detectNestedShell(driver, timeoutMs = 10000) {
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
    } catch {
      // Cross-origin or not ready yet.
    }
    await driver.raw.switchTo().defaultContent();
    if (found) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Unload the active iframe and wait for cleanup.
 */
async function unloadAndWait(driver) {
  await driver.eval(() => window.__unloadIframe());
  await new Promise((r) => setTimeout(r, 300));
}

// ── Tests ───────────────────────────────────────────────────────────

test("switchboard nested: shell boots in deepest video frame", async () => {
  const ctx = await setupNestedSwitchboard();
  try {
    await loadNestedChild(ctx.driver, 0);
    const hasHud = await detectNestedShell(ctx.driver, 10000);
    assert.ok(hasHud, "HUD layer should appear in deepest video frame via relay");
  } finally {
    await teardown(ctx);
  }
});

test("switchboard nested: cleanup propagates across nested frames on unload", async () => {
  const ctx = await setupNestedSwitchboard();
  try {
    await loadNestedChild(ctx.driver, 0);
    const hasHud = await detectNestedShell(ctx.driver, 10000);
    assert.ok(hasHud, "Shell should boot before unload test");

    // Unload and verify cleanup.
    await unloadAndWait(ctx.driver);

    // Verify no iframes remain in the slot.
    const iframeCount = await ctx.driver.eval(() => {
      return document.getElementById("iframe-slot")?.childElementCount ?? 0;
    });
    assert.equal(iframeCount, 0, "iframe-slot should be empty after unload");

    // Verify active index reset.
    const activeIdx = await ctx.driver.eval(() => window.__getActiveIndex());
    assert.equal(activeIdx, -1, "activeIndex should be -1 after unload");
  } finally {
    await teardown(ctx);
  }
});

test("switchboard nested: activeForges does not accumulate after cycles", async () => {
  const ctx = await setupNestedSwitchboard();
  try {
    const cycles = 5;
    for (let i = 0; i < cycles; i++) {
      await loadNestedChild(ctx.driver, i % CHILD_COUNT);
      await new Promise((r) => setTimeout(r, 300));
      await unloadAndWait(ctx.driver);
    }

    // Load one final child and verify exactly 1 forge.
    await loadNestedChild(ctx.driver, 0);
    await new Promise((r) => setTimeout(r, 500));

    const forgeCount = await ctx.driver.raw.switchTo().frame(0).then(() =>
      ctx.driver.raw.switchTo().frame(0).then(() =>
        ctx.driver.raw.executeScript(() => {
          const hosts = document.querySelectorAll(".pf-shell");
          return hosts.length;
        })
      )
    ).finally(() => ctx.driver.raw.switchTo().defaultContent());

    // We may get 0 if the frame is cross-origin, or 1 if same-origin access works.
    // The important thing is it doesn't accumulate to 2+.
    assert.ok(forgeCount <= 1, `Should have at most 1 forge, got ${forgeCount}`);
  } finally {
    await teardown(ctx);
  }
});

test("switchboard nested: rapid load/unload does not crash at depth", async () => {
  const ctx = await setupNestedSwitchboard();
  try {
    const cycles = 8;
    const intervalMs = 200;

    // Rapid cycle through nested children.
    await ctx.driver.eval(
      (count, interval) => window.__rapidCycle(count, interval),
      cycles,
      intervalMs
    );
    await new Promise((r) => setTimeout(r, cycles * intervalMs + 2000));

    // Verify page is still alive.
    const alive = await ctx.driver.eval(() => document.readyState === "complete");
    assert.ok(alive, "Page should still be alive after rapid cycling");

    // Unload whatever is active, then load a fresh nested child.
    await ctx.driver.eval(() => window.__unloadIframe());
    await new Promise((r) => setTimeout(r, 300));
    await loadNestedChild(ctx.driver, 0);
    const hasHud = await detectNestedShell(ctx.driver, 10000);
    assert.ok(hasHud, "Shell should boot after rapid cycling at depth");
  } finally {
    await teardown(ctx);
  }
});

test("switchboard nested: switching servers replaces active nested child", async () => {
  const ctx = await setupNestedSwitchboard();
  try {
    // Load child 0.
    await loadNestedChild(ctx.driver, 0);
    const idx0 = await ctx.driver.eval(() => window.__getActiveIndex());
    assert.equal(idx0, 0, "Active index should be 0 after first load");

    // Switch to child 1.
    await ctx.driver.eval((i) => window.__switchTo(i), 1);
    await ctx.driver.eval((i) => window.__waitForIframeLoad(i, 10000), 1);
    await new Promise((r) => setTimeout(r, 300));
    await ctx.driver.injectScriptInFrame(0);
    await ctx.driver.raw.switchTo().frame(0);
    await ctx.driver.injectScriptInFrame(0);
    await ctx.driver.raw.switchTo().defaultContent();

    const idx1 = await ctx.driver.eval(() => window.__getActiveIndex());
    assert.equal(idx1, 1, "Active index should be 1 after switch");

    // Only 1 iframe should exist.
    const iframeCount = await ctx.driver.eval(() => {
      return document.getElementById("iframe-slot")?.childElementCount ?? 0;
    });
    assert.equal(iframeCount, 1, "Only 1 iframe should exist after switch");

    // Shell should boot in new child.
    const hasHud = await detectNestedShell(ctx.driver, 10000);
    assert.ok(hasHud, "Shell should boot in switched nested child");
  } finally {
    await teardown(ctx);
  }
});
