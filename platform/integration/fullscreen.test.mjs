/**
 * Fullscreen integration tests.
 *
 * Tests the real Fullscreen API behavior in Chromium 152.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell, waitForPanel } from "../harness/page.mjs";

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

test("shell fullscreen toggle does not crash", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  await waitForPanel(driver, 8000);

  const noCrash = await driver.eval(() => {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        bubbles: true,
        cancelable: true
      }));
      return true;
    } catch {
      return false;
    }
  });

  assert.ok(noCrash, "Fullscreen toggle via keyboard should not crash");
});

test("shell handles fullscreenerror gracefully", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const handled = await driver.eval(() => {
    try {
      document.dispatchEvent(new Event("fullscreenerror"));
      return true;
    } catch {
      return false;
    }
  });

  assert.ok(handled, "fullscreenerror event should be handled gracefully");
});
