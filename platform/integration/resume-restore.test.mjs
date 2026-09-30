/**
 * Resume restore integration tests.
 *
 * Tests the full resume lifecycle in a real Firefox 157 instance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";
import { getDomainKey } from "../../src/shared/context.js";

let driver;
let server;

/** Long enough that a 42s resume seek has somewhere to land. */
const MEDIA_SECONDS = 90;

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
  // Real media, not a faked duration: the userscript runs in its own realm,
  // where video.duration is read through the native accessor, so a page-world
  // override is invisible and the tracker would skip for the wrong reason.
  await driver.navigate(createTestPage(server, { videoSrc: createTestMedia(server, 90) }));
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // Wait for the resume tracker to adopt the media.
  await new Promise((r) => setTimeout(r, 1500));

  const stored = await driver.gmStorage();
  assert.ok(
    stored["pf:resume"]?.entries?.length > 0,
    "Resume store should have an entry for the video"
  );
});

test("shell restores position from saved resume", async () => {
  // Both keys have to be the ones this page actually produces. createTestPage
  // mints a fresh /test-<time>-<rand>.html every call and findMatch looks up
  // by (normalized domain, path) - a hardcoded literal for either one silently
  // matched nothing and the test exercised createEntry instead of restore.
  // getDomainKey is what normalizes "127.0.0.1" to "127-0-0-1"; seeding the
  // raw hostname missed on domain even with the right path.
  const url = createTestPage(server, { videoSrc: createTestMedia(server, MEDIA_SECONDS) });
  const path = new URL(url).pathname;
  const domain = getDomainKey(new URL(url).hostname);
  const savedEntry = {
    version: 1,
    entries: [{
      id: "test-entry-1",
      domain,
      path,
      title: "Test Page",
      duration: MEDIA_SECONDS,
      resume: 42,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]
  };

  // The store is inlined when the add-on registers at startup, so it cannot be
  // changed for a document that already loaded: this test needs its own browser.
  await driver.destroy();
  driver = await FirefoxDriver.launch({ storage: { "pf:resume": savedEntry } });

  await driver.navigate(url);
  await driver.injectScript();

  await waitForShell(driver, 8000);

  await new Promise((r) => setTimeout(r, 2000));

  // A match seeks the video to the stored position. Assert the seek landed -
  // that is only reachable if findMatch actually matched the entry, which is
  // the whole point of this test.
  const currentTime = await driver.eval(() => document.getElementById("test-video")?.currentTime ?? -1);
  assert.ok(Math.abs(currentTime - 42) < 1.5,
    `expected the saved position (42s) to be restored, got currentTime=${currentTime}`);

  // And the entry must have been matched, not duplicated by createEntry.
  // Restoring writes nothing on its own: the position it restored is the one
  // already on disk. Move the playhead past the save epsilon, and the save
  // that follows is what proves which entry was adopted.
  await driver.eval(() => {
    document.getElementById("test-video").currentTime = 50;
  });
  await new Promise((r) => setTimeout(r, 2000));

  const entries = (await driver.gmStorage())["pf:resume"]?.entries ?? [];
  assert.equal(entries.length, 1, "restore must reuse the saved entry, not create a second one");
  assert.ok(
    Math.abs(entries[0].resume - 50) < 2,
    `the adopted entry should hold the new position, got ${entries[0].resume}`
  );
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
