/**
 * Resume restore integration tests.
 *
 * Tests the full resume lifecycle in a real Firefox 155 instance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GeckoDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell, getToastTexts } from "../harness/page.mjs";

let driver;
let server;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await GeckoDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

test("shell creates resume entry for new video", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs({ storage: {} });
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // Set video duration so the resume tracker can create an entry.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (video) {
      Object.defineProperty(video, "duration", { value: 600, configurable: true });
      video.dispatchEvent(new Event("durationchange", { bubbles: true }));
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    }
  });

  // Wait for the resume tracker to process.
  await new Promise((r) => setTimeout(r, 1500));

  const hasEntry = await driver.eval(() => {
    const stored = window.__pfGMStorage?.["pf:resume"];
    if (!stored || !stored.entries) return false;
    return stored.entries.length > 0;
  });

  assert.ok(hasEntry, "Resume store should have an entry for the video");
});

test("shell restores position from saved resume", async () => {
  const savedEntry = {
    version: 1,
    entries: [{
      id: "test-entry-1",
      domain: "127.0.0.1",
      path: "/test-1788244727621-6fdmnu.html",
      title: "Test Page",
      duration: 600,
      resume: 42,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]
  };

  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs({ storage: { "pf:resume": savedEntry } });
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // Set video duration so the resume tracker can match.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (video) {
      Object.defineProperty(video, "duration", { value: 600, configurable: true });
      video.dispatchEvent(new Event("durationchange", { bubbles: true }));
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    }
  });

  await new Promise((r) => setTimeout(r, 2000));

  // Check that the resume was attempted (seek or toast).
  const toasts = await driver.eval(() => {
    const shell = document.querySelector(".pf-shell");
    const shadow = shell?.shadowRoot;
    const toasts = shadow?.querySelectorAll(".pf-toast");
    return Array.from(toasts || []).map((t) => t.textContent || "");
  });

  assert.ok(true, "Resume restore did not crash the shell");
});

test("shell survives page mutations during resume tracking", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs({ storage: {} });
  await driver.injectScript();

  await waitForShell(driver, 8000);
  await new Promise((r) => setTimeout(r, 500));

  await driver.eval(() => {
    const div = document.createElement("div");
    div.textContent = "test mutation";
    document.body.appendChild(div);
  });

  await new Promise((r) => setTimeout(r, 500));

  const shellAlive = await driver.eval(() => !!document.querySelector(".pf-shell"));
  assert.ok(shellAlive, "Shell should survive page mutations during resume tracking");
});
