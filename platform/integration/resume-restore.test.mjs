/**
 * Resume restore integration tests.
 *
 * Tests the full resume lifecycle in a real Firefox 157 instance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";
import { getDomainKey } from "../../src/shared/context.js";

let driver;
let server;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await FirefoxDriver.launch();
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
  // Both keys have to be the ones this page actually produces. createTestPage
  // mints a fresh /test-<time>-<rand>.html every call and findMatch looks up
  // by (normalized domain, path) - a hardcoded literal for either one silently
  // matched nothing and the test exercised createEntry instead of restore.
  // getDomainKey is what normalizes "127.0.0.1" to "127-0-0-1"; seeding the
  // raw hostname missed on domain even with the right path.
  const url = createTestPage(server);
  const path = new URL(url).pathname;
  const domain = getDomainKey(new URL(url).hostname);
  const savedEntry = {
    version: 1,
    entries: [{
      id: "test-entry-1",
      domain,
      path,
      title: "Test Page",
      duration: 600,
      resume: 42,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]
  };

  await driver.navigate(url);
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

  // A match seeks the video to the stored position. Assert the seek landed -
  // that is only reachable if findMatch actually matched the entry, which is
  // the whole point of this test.
  const currentTime = await driver.eval(() => document.getElementById("test-video")?.currentTime ?? -1);
  assert.ok(Math.abs(currentTime - 42) < 1.5,
    `expected the saved position (42s) to be restored, got currentTime=${currentTime}`);

  // And the entry must have been matched, not duplicated by createEntry.
  const stored = await driver.eval(() => (window.__pfGMStorage?.["pf:resume"]?.entries ?? []).length);
  assert.equal(stored, 1, "restore must reuse the saved entry, not create a second one");
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
