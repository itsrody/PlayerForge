/**
 * Iframe lifecycle integration tests.
 *
 * Verifies the kernel detection pipeline and frame bridge across four
 * video embedding scenarios:
 *   1. Direct embedded video (baseline)
 *   2. Same-origin iframe
 *   3. Cross-origin iframe
 *   4. Nested iframe (cross-origin relay)
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
import { waitForShell, waitForShellInFrame, waitForPanel, countElements } from "../harness/page.mjs";

// ── Scenario 1: Direct video (baseline) ──────────────────────────────

test("direct: shell boots on bare video", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    const hasHud = await waitForShell(driver, 8000);
    assert.ok(hasHud, "HUD layer should appear on direct video");
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

test("direct: video is marked with data-pf-shell", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await waitForShell(driver, 8000);
    const marked = await driver.eval(() => {
      const video = document.getElementById("test-video");
      return video?.getAttribute("data-pf-shell") !== null;
    });
    assert.ok(marked, "Video should be marked with data-pf-shell");
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

// ── Scenario 2: Same-origin iframe ───────────────────────────────────

test("same-origin: shell boots in iframe", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    const childUrl = createIframeChildPage(server);
    const parentUrl = createIframeParentPage(server, childUrl);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    const hasHud = await waitForShellInFrame(driver, 0, 10000);
    assert.ok(hasHud, "HUD layer should appear in same-origin iframe");
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

test("same-origin: video is marked in iframe", async () => {
  const server = new TestServer();
  await server.start();
  const driver = await GeckoDriver.launch();
  try {
    const childUrl = createIframeChildPage(server);
    const parentUrl = createIframeParentPage(server, childUrl);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    const marked = await driver.evalInFrame(0, () => {
      const video = document.getElementById("test-video");
      return video?.getAttribute("data-pf-shell") !== null;
    });
    assert.ok(marked, "Video in iframe should be marked with data-pf-shell");
  } finally {
    await driver.destroy();
    await server.stop();
  }
});

// ── Scenario 3: Cross-origin iframe ──────────────────────────────────

test("cross-origin: shell boots in iframe", async () => {
  const { serverA, serverB } = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    const childUrl = createIframeChildPage(serverB);
    const parentUrl = createIframeParentPage(serverA, childUrl);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    const hasHud = await waitForShellInFrame(driver, 0, 10000);
    assert.ok(hasHud, "HUD layer should appear in cross-origin iframe");
  } finally {
    await driver.destroy();
    await serverA.stop();
    await serverB.stop();
  }
});

test("cross-origin: frame bridge resolves context", async () => {
  const { serverA, serverB } = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    const childUrl = createIframeChildPage(serverB);
    const parentUrl = createIframeParentPage(serverA, childUrl);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await waitForShellInFrame(driver, 0, 10000);
    const context = await driver.evalInFrame(0, () => {
      const host = document.querySelector(".pf-shell");
      return {
        hasShell: !!host,
        origin: window.location.origin,
      };
    });
    assert.ok(context.hasShell, "Shell should exist in cross-origin iframe");
    assert.ok(context.origin.includes("127.0.0.1"), "Iframe origin should be 127.0.0.1");
  } finally {
    await driver.destroy();
    await serverA.stop();
    await serverB.stop();
  }
});

// ── Scenario 4: Nested iframe (cross-origin relay) ───────────────────

test("nested: shell boots via relay", async () => {
  const { serverA, serverB } = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    const { parentUrl } = createNestedIframePages(serverA, serverB);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    // Enter outer iframe, then inject into inner iframe.
    await driver.raw.switchTo().frame(0);
    await driver.injectScriptInFrame(0);
    await driver.raw.switchTo().defaultContent();

    const hasHud = await driver.waitForInFrame(
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
    assert.ok(hasHud, "HUD layer should appear in nested iframe via relay");
  } finally {
    await driver.destroy();
    await serverA.stop();
    await serverB.stop();
  }
});

test("nested: video is marked via relay", async () => {
  const { serverA, serverB } = await createMultiOriginServers();
  const driver = await GeckoDriver.launch();
  try {
    const { parentUrl } = createNestedIframePages(serverA, serverB);
    await driver.navigate(parentUrl);
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.injectScriptInFrame(0);
    await driver.raw.switchTo().frame(0);
    await driver.injectScriptInFrame(0);
    await driver.raw.switchTo().defaultContent();

    const marked = await driver.waitForInFrame(
      0,
      () => {
        const innerFrame = document.getElementById("inner-frame");
        if (!innerFrame?.contentDocument) return false;
        const video = innerFrame.contentDocument.getElementById("test-video");
        return video?.getAttribute("data-pf-shell") !== null;
      },
      10000,
      200
    );
    assert.ok(marked, "Video in nested iframe should be marked with data-pf-shell");
  } finally {
    await driver.destroy();
    await serverA.stop();
    await serverB.stop();
  }
});
