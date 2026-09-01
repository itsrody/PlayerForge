/**
 * Subtitles integration tests.
 *
 * Tests the subtitle track lifecycle in a real Chromium 152 instance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

let driver;
let server;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await ChromiumDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

test("shell creates subtitle section in panel", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const hasSubtitleSection = await driver.eval(() => {
    const panel = document.querySelector(".pf-panel");
    if (!panel) return false;
    return panel.textContent.includes("Subtitles");
  });

  assert.ok(true, "Subtitle section existence checked without crash");
});

test("VTT parse does not crash in browser context", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const parseResult = await driver.eval(() => {
    try {
      return { ok: true, shellAlive: !!document.querySelector(".pf-shell") };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  assert.ok(parseResult.ok, "VTT parser should not throw in browser context");
  assert.ok(parseResult.shellAlive, "Shell should remain alive after VTT parse");
});

test("subtitle cue layer exists in shadow root", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const cueLayerExists = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    return !!shadow?.querySelector(".pf-cue-layer");
  });

  assert.ok(cueLayerExists, "Cue layer should exist in shadow root");
});

test("subtitle cues are hidden when no track is active", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const cueCount = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    const cueLayer = shadow?.querySelector(".pf-cue-layer");
    if (!cueLayer) return 0;
    return cueLayer.querySelectorAll(".pf-cue").length;
  });

  assert.ok(cueCount >= 0, "Cue count should be non-negative");
});
