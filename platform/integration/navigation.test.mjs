/**
 * Same-document navigation integration tests.
 *
 * Covers the route-follow half of the resume contract on real Firefox 156: an
 * SPA pushState must flush the entry being left and re-adopt onto the new
 * path. This is the end-to-end proof that the Navigation API backend
 * (`navigation.currententrychange`, native and grant-free since Firefox 147)
 * actually fires for pushState here - the fork no longer grants
 * `window.onurlchange` on the strength of that assumption, so the assumption
 * is under test rather than in a comment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell } from "../harness/page.mjs";

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

const resumeEntries = () =>
  driver.eval(() => (window.__pfGMStorage?.["pf:resume"]?.entries ?? []).map((e) => e.path));

test("pushState route change re-adopts the resume entry onto the new path", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs({ storage: {} });
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // A finite duration is the precondition for adoption (resume.js
  // #waitForDuration is purely event-driven).
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (video) {
      Object.defineProperty(video, "duration", { value: 600, configurable: true });
      video.dispatchEvent(new Event("durationchange", { bubbles: true }));
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    }
  });

  await new Promise((r) => setTimeout(r, 1200));

  const originalPath = await driver.eval(() => window.location.pathname);
  const initial = await resumeEntries();
  assert.ok(initial.includes(originalPath), `entry created for the boot route (${JSON.stringify(initial)})`);

  // The SPA half of a route change: push history, then swap the resource on a
  // LATER tick. currententrychange fires synchronously with pushState, but
  // resume.js #followRoute awaits the page context before arming its one-shot
  // loadstart hook - so a swap dispatched in the same task as the push would
  // land before the hook exists. A real player sets src on a later tick.
  await driver.eval(() => {
    window.history.pushState({}, "", "/route-b");
  });
  await new Promise((r) => setTimeout(r, 100));
  await driver.eval(() => {
    document.getElementById("test-video")?.dispatchEvent(new Event("loadstart"));
  });

  await new Promise((r) => setTimeout(r, 1500));

  const paths = await resumeEntries();
  assert.ok(
    paths.includes("/route-b"),
    `re-adopted onto the pushed route - Navigation API fired for pushState (${JSON.stringify(paths)})`
  );
  assert.ok(paths.includes(originalPath), "the route we left keeps its entry");
});
