/**
 * StatusManager integration tests.
 *
 * Records transitions from a real shell in a real Firefox and asserts every
 * one of them names an event this run actually witnessed. That is the whole
 * claim of L2's "status is observed, never optimistic": if any axis could be
 * decided by a handler instead of by the element, the cause would be missing
 * from the log or would name something that never fired.
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

/** Every event StatusManager is allowed to name as a transition's cause. */
const CAUSES = [
  "loadstart", "emptied", "loadedmetadata", "canplay",
  "play", "playing", "pause", "ended",
  "waiting", "seeking", "seeked",
  "durationchange", "ratechange", "volumechange", "timeupdate", "error",
  "addtrack", "removetrack",
  "fullscreenchange", "visibilitychange"
];

/** Boot shell + media, then arm the recorder: pf:status and every cause in one go. */
async function startRecording() {
  await driver.navigate(createTestPage(server, { videoSrc: createTestMedia(server, 30) }));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);
  await waitForPanel(driver, 8000);
  await waitForMediaReady(driver, 8000);

  // Arming the status listener and the cause recorder together is what makes
  // the assertion below sound: a change can only be logged if the run also
  // recorded the event that produced it.
  await driver.eval((causes) => {
    const video = document.getElementById("test-video");
    const observed = new Set();
    window.__pfStatusLog = [];
    window.__pfObserved = observed;

    const record = (type) => () => observed.add(type);
    for (const type of causes) {
      video.addEventListener(type, record(type), { capture: true, passive: true });
      document.addEventListener(type, record(type), { capture: true, passive: true });
    }
    if (video.textTracks) {
      video.textTracks.addEventListener("addtrack", record("addtrack"), { passive: true });
      video.textTracks.addEventListener("removetrack", record("removetrack"), { passive: true });
    }
    video.addEventListener("pf:status", (event) => window.__pfStatusLog.push(event.detail));
  }, CAUSES);
}

test("every transition in a live run names an event that really fired", async () => {
  await startRecording();

  // Muted: Firefox's autoplay policy blocks audible playback without a
  // gesture, and a play() that rejects would leave nothing to observe. A
  // rejected play is exactly what the optimistic-status rule exists to avoid,
  // so let the element genuinely start and watch what it announces.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    video.muted = true;
    video.play();
  });
  await driver.waitFor(
    () => window.__pfStatusLog.some((c) => c.name === "playback" && c.to === "playing"),
    8000
  );

  await driver.eval(() => document.getElementById("test-video").pause());
  await driver.waitFor(
    () => window.__pfStatusLog.some((c) => c.name === "playback" && c.to === "paused"),
    8000
  );

  // A real rate change: the setter fires ratechange itself, and the axis is
  // only honest if the transition arrives with that cause. This is the edge
  // that used to vanish - the handler read a property HTMLMediaElement does
  // not have, so no rate transition ever reached pf:status.
  await driver.eval(() => {
    document.getElementById("test-video").playbackRate = 1.5;
  });
  await driver.waitFor(
    () => window.__pfStatusLog.some((c) => c.name === "rate"),
    8000
  );

  await driver.eval(() => {
    document.getElementById("test-video").currentTime = 15;
  });
  await driver.waitFor(() => window.__pfStatusLog.some((c) => c.name === "buffer"), 8000);

  const { changes, observed } = await driver.eval(() => ({
    changes: window.__pfStatusLog,
    observed: [...window.__pfObserved]
  }));

  assert.ok(changes.length >= 3, `expected a live run to move, got ${changes.length} changes`);

  for (let i = 1; i < changes.length; i += 1) {
    assert.ok(
      changes[i].seq > changes[i - 1].seq,
      `seq must increase monotonically (got ${changes[i - 1].seq} then ${changes[i].seq})`
    );
  }

  for (const change of changes) {
    assert.ok(
      observed.includes(change.cause),
      `${change.name} ${change.from} -> ${change.to} claims cause "${change.cause}", which this run never saw fire`
    );
    assert.ok(
      ["axis", "scalar"].includes(change.kind),
      `unexpected change kind ${change.kind}`
    );
  }

  const causes = new Set(changes.map((c) => c.cause));
  assert.ok(causes.has("playing"), "playback reached PLAYING through the element's own edge");
  assert.ok(causes.has("pause"), "and left it the same way");
  assert.ok(causes.has("seeked"), "the buffer axis settled on a real seek edge");
  assert.ok(causes.has("ratechange"), "the rate axis moved on the element's own edge");
});

test("status matches the element after each edge, rather than leading it", async () => {
  await startRecording();

  await driver.eval(() => {
    const video = document.getElementById("test-video");
    video.muted = true;
    video.play();
  });
  await driver.waitFor(
    () => window.__pfStatusLog.some((c) => c.to === "playing"),
    8000
  );

  // Read status and the element at the same instant: an optimistic write would
  // have shown PLAYING before the element agreed, so this only holds if the
  // transition was driven by the element. Take the latest PLAYBACK change -
  // a later `canplay` may have moved the buffer axis in the meantime.
  const playing = await driver.eval(() => ({
    status: [...window.__pfStatusLog].reverse().find((c) => c.name === "playback")?.to,
    paused: document.getElementById("test-video").paused
  }));
  assert.equal(playing.status, "playing");
  assert.equal(playing.paused, false, "the element really is playing when status says so");

  await driver.eval(() => document.getElementById("test-video").pause());
  await driver.waitFor(
    () => window.__pfStatusLog.some((c) => c.to === "paused"),
    8000
  );

  const paused = await driver.eval(() => ({
    status: [...window.__pfStatusLog].reverse().find((c) => c.name === "playback")?.to,
    paused: document.getElementById("test-video").paused
  }));
  assert.equal(paused.status, "paused");
  assert.equal(paused.paused, true, "and really is paused");
});

test("a seek request never writes the playback axis - requests are not status", async () => {
  await startRecording();

  const from = await driver.eval(() => window.__pfStatusLog.length);

  await driver.eval(() => {
    document.getElementById("test-video").currentTime = 5;
  });
  // waitFor serializes the function alone - it cannot close over `from`.
  await driver.waitFor((start) => window.__pfStatusLog.length > start, 8000, 50, from);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const { later } = await driver.eval((start) => ({
    later: window.__pfStatusLog.slice(start)
  }), from);

  assert.ok(later.length > 0, "the seek produced some status change");
  assert.deepEqual(
    later.filter((c) => c.name === "playback"),
    [],
    "a seek moved the buffer but could not have touched playback: only the element writes it"
  );
});
