/**
 * Shell lifecycle integration tests.
 *
 * Verifies the full userscript lifecycle in a real Chromium 152 instance:
 * video detection → shell construction → HUD layer → settings panel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage, createPlyrPage, createBlankPage } from "../harness/chromium.mjs";
import { waitForShell, waitForPanel, waitForSelector, countElements } from "../harness/page.mjs";

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

test("shell boots on bare video element", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  const hasHud = await waitForShell(driver, 8000);
  assert.ok(hasHud, "HUD layer should appear after shell boot");
});

test("shell constructs settings panel", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  const hasPanel = await waitForPanel(driver, 8000);
  assert.ok(hasPanel, "Settings panel should be constructed");
});

test("shell creates the pf-shell host element", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  const hasHost = await driver.eval(() => !!document.querySelector(".pf-shell"));
  assert.ok(hasHost, "pf-shell host element should exist");
});

test("shell attaches open shadow root", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  const hasShadow = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    return host?.shadowRoot?.mode === "open";
  });
  assert.ok(hasShadow, "pf-shell should have an open shadow root");
});

test("shell injects cue layer inside shadow root", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  const hasCueLayer = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    return !!shadow?.querySelector(".pf-cue-layer");
  });
  assert.ok(hasCueLayer, "Cue layer should exist inside shadow root");
});

test("shell does not create duplicate HUD on re-detection", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  const countBefore = await countElements(driver, ".pf-shell");

  await driver.eval(() => {
    const plyr = document.querySelector(".plyr");
    const div = document.createElement("div");
    div.textContent = "trigger mutation";
    plyr?.appendChild(div);
  });

  await new Promise((r) => setTimeout(r, 500));
  const countAfter = await countElements(driver, ".pf-shell");
  assert.equal(countAfter, countBefore, "Shell count should not increase on mutation");
});

test("shell marks video with data-pf-shell attribute", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  const marked = await driver.eval(() => {
    const video = document.getElementById("test-video");
    return video?.getAttribute("data-pf-shell") !== null;
  });
  assert.ok(marked, "Video should be marked with data-pf-shell");
});

test("shell works with Plyr-style player tree", async () => {
  await driver.navigate(createPlyrPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  const hasHud = await waitForShell(driver, 8000);
  assert.ok(hasHud, "Shell should boot on Plyr-style player");
});

test("shell boots when video is added dynamically", { skip: "Requires probe escalation for post-load injection (production uses document-start)" }, async () => {
  // Page with Plyr container but no video yet.
  const html = `<!DOCTYPE html><html><body>
    <div class="plyr" data-plyr>
      <div class="plyr__video-wrapper" id="video-wrapper"></div>
    </div>
  </body></html>`;
  const path = `/dyno-${Date.now()}.html`;
  server.addPage(path, html);
  await driver.navigate(`${server.url}${path}`);
  await driver.injectGMStubs();
  await driver.injectScript();

  const noHudBefore = await driver.eval(() => !!document.querySelector(".pf-hud-layer"));
  assert.equal(noHudBefore, false, "No HUD before video exists");

  await driver.eval(() => {
    const wrapper = document.getElementById("video-wrapper");
    const video = document.createElement("video");
    video.id = "test-video";
    wrapper.appendChild(video);
    video.dispatchEvent(new Event("loadeddata", { bubbles: true }));
  });

  const hasHud = await waitForShell(driver, 8000);
  assert.ok(hasHud, "Shell should boot after dynamic video insertion");
});
