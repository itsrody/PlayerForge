/**
 * Generic-fallback adoption in a live browser, end to end.
 *
 * The template suite (sdk-engine, multi-shell) only proves anchored shapes.
 * This file proves the other half: a video NO template owns is adopted
 * through the measured fallback - playing, activated, sized, in viewport -
 * with real media, real layout and real user activation, none of which
 * jsdom can stand in for.
 *
 * The core case is muted autoplay before any gesture: the play event offers
 * while activation is still missing, so the gates refuse it - and with no
 * attribute churn coming, only the first-gesture re-sweep re-offers once
 * the user finally interacts. Without that sweep the video sits unoffered
 * for the rest of the session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";

let driver;
let server;

/** Poll until ready, rather than sleeping a fixed guess. */
async function until(fn, timeout = 15000, step = 150) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await FirefoxDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

const readBare = () => {
  const container = document.querySelector(".pf-bare-player");
  const video = document.querySelector("#test-bare-video");
  if (!container || !video) return null;
  return {
    shells: container.querySelectorAll(":scope > .pf-shell").length,
    marked: video.hasAttribute("data-pf-shell"),
    paused: video.paused,
    readyState: video.readyState,
    hasActivation: !!(navigator.userActivation && navigator.userActivation.hasBeenActive),
  };
};

test("muted autoplay with no gesture builds no shell, then adopts on first interaction", async () => {
  const url = createTestPage(server, {
    players: 0,
    barePlayers: 1,
    videoSrc: createTestMedia(server, 30),
  });
  await driver.navigate(url);
  await driver.injectScript();

  // Play without any trusted input first: muted, so no policy blocks it,
  // but activation is still missing - the same state as muted autoplay.
  await driver.eval(() => {
    const video = document.querySelector("#test-bare-video");
    video.muted = true;
    return video.play().then(
      () => "playing",
      (e) => "rejected:" + String((e && e.message) || e)
    );
  });
  const playing = await until(async () => {
    const r = await driver.eval(readBare);
    return r && !r.paused && r.readyState > 0 ? r : null;
  });
  assert.ok(playing, "the bare video is playing with real media");

  // No gesture yet: the fallback gates refuse the offer. Bound the wait -
  // absence cannot be polled positively, but a second of playing video with
  // no shell is the honest pre-state, not a race.
  await new Promise((r) => setTimeout(r, 1500));
  const pre = await driver.eval(readBare);
  assert.equal(pre.shells, 0, "no shell before any user gesture");
  assert.equal(pre.hasActivation, false, "activation really is missing");

  // First trusted interaction: a real pointer press anywhere on the page.
  // Activation latches, the gesture sweep re-offers, and the fallback -
  // playing, sized, in viewport - adopts through the measured path.
  await driver.raw.actions().move({ x: 100, y: 100 }).press().release().perform();
  const st = await until(async () => {
    const r = await driver.eval(readBare);
    return r && r.shells > 0 ? r : null;
  });
  assert.ok(st, "the first gesture adopted the unknown player");
  assert.equal(st.marked, true, "the video is marked with data-pf-shell");
  assert.ok(st.readyState > 0, "media is loaded");
});
