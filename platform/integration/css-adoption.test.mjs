/**
 * CSS adoption integration tests.
 *
 * Verifies the constructable stylesheet injection pipeline in Chromium 152.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell, getComputedStyle } from "../harness/page.mjs";

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

test("shell adopts stylesheet to document", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const adoptedCount = await driver.eval(() => document.adoptedStyleSheets.length);
  assert.ok(adoptedCount > 0, "At least one stylesheet should be adopted to the document");
});

test("shell adopts stylesheet to shadow root", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const shadowAdoptedCount = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    return shadow?.adoptedStyleSheets?.length ?? 0;
  });

  assert.ok(shadowAdoptedCount > 0, "Shadow root should have adopted stylesheets");
});

test("shell CSS includes pf-hud-layer styles", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // The HUD layer is inside the shadow root — query via shadow.
  const position = await driver.eval(() => {
    const shell = document.querySelector(".pf-shell");
    const hud = shell?.shadowRoot?.querySelector(".pf-hud-layer");
    if (!hud) return null;
    return getComputedStyle(hud).getPropertyValue("position");
  });
  assert.equal(position, "absolute", "HUD layer should have position: absolute");
});

test("stylesheet survives page DOM mutations", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const countBefore = await driver.eval(() => document.adoptedStyleSheets.length);

  await driver.eval(() => {
    const div = document.createElement("div");
    div.textContent = "mutation test";
    document.body.appendChild(div);
    document.body.removeChild(div);
  });

  await new Promise((r) => setTimeout(r, 100));
  const countAfter = await driver.eval(() => document.adoptedStyleSheets.length);

  assert.equal(countAfter, countBefore, "Adopted stylesheets should survive DOM mutations");
});
