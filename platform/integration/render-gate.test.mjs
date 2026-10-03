/**
 * RenderGate integration tests.
 *
 * The userscript runs in the add-on's isolated userScript realm (see
 * firefox.mjs: WebDriver's executeScript only ever sees the page world), so
 * nothing inside the gate can be instrumented from here - no spy on
 * `scheduler.postTask`, no spy on `style.setProperty`, no commit counter.
 * `tests/render-gate.test.mjs` owns those.
 *
 * What the page *can* see is the value on the host and when it changes, and
 * that is enough to separate the two architectures:
 *
 *   - Before phase 3 the `volumechange` handler wrote `--pf-media-muted`
 *     inline, so a synthetic dispatch delivered the new value before control
 *     returned. Now it must still hold the old value there, and must still
 *     hold it at the microtask checkpoint - the commit is a task, not the
 *     event's continuation and not a MutationObserver flush.
 *   - The deferred commit reads the element rather than the event, so seven
 *     alternating flips in one tick land as the state that survived, not as
 *     some intermediate value.
 *   - And real play/pause must end up reporting exactly what the element
 *     reports: DOM behaviour unchanged is the phase's hard constraint.
 *
 * Synthetic dispatches are what make the first claim measurable. Gecko queues
 * real media events as tasks, so "before control returns" would be vacuous
 * without them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel, waitForMediaReady } from "../harness/page.mjs";

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

async function boot() {
  await driver.navigate(createTestPage(server, { videoSrc: createTestMedia(server, 30) }));
  await driver.injectGMStubs();
  await driver.injectScript();
  await waitForShell(driver, 8000);
  await waitForPanel(driver, 8000);
  await waitForMediaReady(driver, 8000);
  // The HUD layer appears in #injectDom, but the custom-property seed runs in
  // #forwardMediaEvents several yields later. Probing before that would report
  // an empty value as if it were a real reading of the element.
  await driver.waitFor(
    () => document.querySelector(".pf-shell")?.style.getPropertyValue("--pf-media-paused") !== "",
    8000
  );
}

test("media edges defer past the handler and past the microtask checkpoint", async () => {
  await boot();

  const outcome = await driver.eval(async () => {
    const video = document.getElementById("test-video");
    const host = document.querySelector(".pf-shell");
    const key = "--pf-media-muted";

    const seed = host.style.getPropertyValue(key);
    const startMuted = video.muted;
    const target = startMuted ? "0" : "1";

    // Seven edges, all inside this one synchronous block. Each flips the
    // element and dispatches the event the shell listens for, so the final
    // state is the opposite of the one that was seeded.
    for (let i = 0; i < 7; i += 1) {
      video.muted = !video.muted;
      video.dispatchEvent(new Event("volumechange"));
    }

    const afterDispatch = host.style.getPropertyValue(key);

    await Promise.resolve();
    const afterMicrotask = host.style.getPropertyValue(key);

    let afterTask = afterMicrotask;
    for (let i = 0; i < 100 && afterTask === seed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      afterTask = host.style.getPropertyValue(key);
    }

    return { seed, target, afterDispatch, afterMicrotask, afterTask };
  });

  assert.notEqual(outcome.seed, "", "the construction seed was in place before the probe");
  assert.notEqual(outcome.seed, outcome.target, "the probe actually flipped the element");
  assert.equal(
    outcome.afterDispatch, outcome.seed,
    "the handler returned without writing - the commit is not inline in the event"
  );
  assert.equal(
    outcome.afterMicrotask, outcome.seed,
    "and still not written at the microtask checkpoint, so it is a task rather than a microtask flush"
  );
  assert.equal(
    outcome.afterTask, outcome.target,
    `one commit later the host carries the state that survived the tick (seed ${outcome.seed}, target ${outcome.target}, got ${outcome.afterTask})`
  );
});

test("an edge that changes nothing leaves the host untouched", async () => {
  await boot();

  const outcome = await driver.eval(async () => {
    const video = document.getElementById("test-video");
    const host = document.querySelector(".pf-shell");
    const key = "--pf-media-muted";

    const before = host.style.getPropertyValue(key);

    // A pure edge: no state change, just the event the shell listens for. The
    // flip guard predates the gate, so the interesting part is that routing the
    // write through a task did not turn it into an unconditional write - the
    // commit still reads the element and still declines when nothing moved.
    video.dispatchEvent(new Event("volumechange"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    return { before, after: host.style.getPropertyValue(key) };
  });

  assert.equal(
    outcome.after, outcome.before,
    "a no-op edge leaves the host exactly as it was"
  );
});

test("real play and pause still land the property the element reports", async () => {
  await boot();

  const bootState = await driver.eval(() => ({
    paused: document.getElementById("test-video").paused,
    prop: document.querySelector(".pf-shell").style.getPropertyValue("--pf-media-paused")
  }));
  assert.equal(bootState.paused, true, "the fixture boots unstarted, so nothing has played yet");
  assert.equal(bootState.prop, "1", "the construction seed reflects the element as it found it");

  // Muted: Firefox's autoplay policy blocks audible playback without a gesture,
  // and a rejected play() would leave nothing to observe.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    video.muted = true;
    video.play();
  });
  await driver.waitFor(
    () => !document.getElementById("test-video").paused &&
      document.querySelector(".pf-shell").style.getPropertyValue("--pf-media-paused") === "0",
    8000
  );

  await driver.eval(() => document.getElementById("test-video").pause());
  await driver.waitFor(
    () => document.querySelector(".pf-shell").style.getPropertyValue("--pf-media-paused") === "1",
    8000
  );

  const afterPause = await driver.eval(() => ({
    paused: document.getElementById("test-video").paused,
    prop: document.querySelector(".pf-shell").style.getPropertyValue("--pf-media-paused")
  }));
  assert.equal(afterPause.paused, true, "the element really paused");
  assert.equal(afterPause.prop, "1", "and the host says the same thing - DOM behaviour unchanged");
});
