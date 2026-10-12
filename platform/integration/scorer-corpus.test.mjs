/**
 * Scorer-corpus matrix in a live browser: five labeled videos covering the
 * adoption decisions the fallback must get right - a main player, a small
 * ad tile, a full-bleed ambient background, a dormant poster video, and a
 * muted autoplay.
 *
 * No template anchors anywhere, so every adoption here goes through the
 * measured path with real media, real layout and real user activation.
 * This pins CURRENT behavior as the baseline the 3.0 scorer tunes against:
 * main + muted-autoplay adopt (after gesture and playback respectively),
 * ad/ambient/dormant stay out for size, viewport and dormancy reasons.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FirefoxDriver,
  TestServer,
  createScorerCorpusPage,
  createTestMedia,
} from "../harness/firefox.mjs";

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

const readCorpus = () => {
  const out = {};
  for (const role of ["main", "ad", "dormant", "muted-autoplay", "ambient"]) {
    const container = document.querySelector(`[data-pf-corpus="${role}"]`);
    const video = container ? container.querySelector("video") : null;
    out[role] = container && video
      ? {
          shells: container.querySelectorAll(":scope > .pf-shell").length,
          marked: video.hasAttribute("data-pf-shell"),
          paused: video.paused,
          readyState: video.readyState,
        }
      : null;
  }
  out.activation = !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  out.total = document.querySelectorAll(".pf-shell").length;
  return out;
};

test("corpus matrix: main and muted-autoplay adopt, ad/ambient/dormant stay out", async () => {
  const url = createScorerCorpusPage(server, { mediaUrl: createTestMedia(server, 30) });
  await driver.navigate(url);
  await driver.injectScript();

  // Autoplay roles should be running; where the profile blocks autoplay,
  // start them explicitly (still pre-gesture, so activation stays missing).
  // Muted throughout: no policy decision should depend on it here.
  await driver.eval(() => {
    const starts = [];
    for (const id of ["corpus-ad-video", "corpus-muted-video", "corpus-ambient-video"]) {
      const video = document.getElementById(id);
      video.muted = true;
      if (video.paused) {
        starts.push(
          video.play().then(
            () => id + ":playing",
            (e) => id + ":rejected:" + String((e && e.message) || e)
          )
        );
      }
    }
    return Promise.all(starts);
  });
  const running = await until(async () => {
    const r = await driver.eval(readCorpus);
    return r && !r.ad.paused && !r["muted-autoplay"].paused && !r.ambient.paused && r.ad.readyState > 0 ? r : null;
  });
  assert.ok(running, "autoplay roles are playing with real media");

  // Pre-gesture: nothing may adopt. The ad is small, the ambient is
  // full-bleed, the dormant is paused - and nothing has been activated.
  await new Promise((r) => setTimeout(r, 1500));
  const pre = await driver.eval(readCorpus);
  assert.equal(pre.total, 0, "no shell before any user gesture");
  assert.equal(pre.activation, false, "activation really is missing");

  // First trusted interaction, then the user presses play on the main video.
  // The click's pointerdown fires the one-shot gesture sweep (deferred past
  // dispatch so the activation latch is settled); the main video's play
  // event arrives through the media tap.
  await driver.raw.actions().move({ x: 100, y: 100 }).press().release().perform();
  const playOutcome = await driver.eval(() => {
    const video = document.getElementById("corpus-main-video");
    return video.play().then(
      () => "playing",
      (e) => "rejected:" + String((e && e.message) || e)
    );
  });
  assert.equal(playOutcome, "playing", "main video plays on user request");
  const st = await until(async () => {
    const r = await driver.eval(readCorpus);
    return r && r.main.shells > 0 && r["muted-autoplay"].shells > 0 ? r : null;
  });
  assert.ok(st, "main and muted-autoplay adopted after gesture and playback");
  assert.equal(st.main.marked, true, "main video marked");
  assert.equal(st["muted-autoplay"].marked, true, "muted video marked");
  assert.equal(st.ad.shells, 0, "ad tile refused on size");
  assert.equal(st.ambient.shells, 0, "ambient background refused on viewport");
  assert.equal(st.dormant.shells, 0, "dormant poster waits for playback");
  assert.equal(st.total, 2, "exactly the two qualifying players built shells");
});
