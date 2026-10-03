/**
 * Occlusion-gating integration tests (migration phase 5, §4 L5 rule 4).
 *
 * The IntersectionObserver that drives `Presence.OCCLUDED` lives in the
 * add-on's isolated userScript realm, so nothing about it can be spied on
 * from here - no fire(), no target list, no `isIntersecting` reading. What
 * the page *can* see is the two things the rule produces, and those are
 * exactly the two things the rule promises:
 *
 *   - `pf:status` on the video reports the presence axis crossing into
 *     `occluded` with `cause: "intersection"` when the player leaves the
 *     viewport - the observation is real, not a timeout we guessed at.
 *   - the host picks up `pf-detached`, and drops it again on the way back.
 *   - a player whose playhead is advancing never detaches, however far it
 *     leaves the viewport.
 *
 * The BACKGROUND arm of the same rule is deliberately not driven from here.
 * The page cannot make its own document read as hidden to the userscript: an
 * expando the page defines on `document` is invisible across the sandbox
 * boundary (a patched build confirmed the listener fires and only the
 * `visibilityState` read disagrees), and WebDriver has no way to leave a
 * window hidden while it is still executing in it. `tests/player-status.test.mjs`
 * and `tests/hud-occlusion.test.mjs` cover that arm, where both worlds are
 * one.
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
  // Record every status transition from the page world, so a wait below can be
  // for the edge that actually fired rather than for a generous timeout.
  await driver.eval(() => {
    window.__pfStatus = [];
    document.getElementById("test-video").addEventListener("pf:status", (event) => {
      window.__pfStatus.push(event.detail);
    });
  });
}

/**
 * Wait for one axis of the recorded transitions to reach a value.
 *
 * `waitFor` serializes the function's source into the page, so nothing may be
 * closed over - the axis and its target arrive as forwarded arguments.
 */
const waitAxis = (axis, to, timeout = 8000) =>
  driver.waitFor(
    (wantedAxis, wantedTo) =>
      (window.__pfStatus || []).some((d) => d.name === wantedAxis && d.to === wantedTo),
    timeout,
    50,
    axis,
    to
  );

const detached = () =>
  !!document.querySelector(".pf-shell")?.classList.contains("pf-detached");
const attached = () =>
  !document.querySelector(".pf-shell")?.classList.contains("pf-detached");

/** Put the player far above the viewport without moving it inside its container. */
async function scrollPlayerOutOfView() {
  const scrolled = await driver.eval(() => {
    if (!document.getElementById("pf-spacer")) {
      const spacer = document.createElement("div");
      spacer.id = "pf-spacer";
      spacer.style.height = "4000px";
      document.body.appendChild(spacer);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    return { scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight };
  });
  assert.ok(
    scrolled.scrollY > 0,
    `the page had to actually scroll for this to mean anything (got ${JSON.stringify(scrolled)})`
  );
  return scrolled;
}

test("a paused player scrolled out of the viewport drops the HUD, and takes it back", async () => {
  await boot();

  const initial = await driver.eval(() => ({
    detached: document.querySelector(".pf-shell")?.classList.contains("pf-detached"),
    paused: document.getElementById("test-video").paused
  }));
  assert.equal(initial.paused, true, "the fixture boots unstarted, i.e. idle");
  assert.equal(initial.detached, false, "on screen: the HUD is attached");

  await scrollPlayerOutOfView();
  await waitAxis("presence", "occluded");
  await driver.waitFor(detached, 8000, 50);

  const causes = await driver.eval(
    () => (window.__pfStatus || []).filter((d) => d.name === "presence").map((d) => d.cause)
  );
  assert.deepEqual(causes, ["intersection"], "the presence axis moved because of the observer");

  await driver.eval(() => window.scrollTo(0, 0));
  await waitAxis("presence", "visible");
  await driver.waitFor(attached, 8000, 50);
});

test("a playing player keeps its HUD however far it leaves the viewport", async () => {
  await boot();

  // Muted: Firefox's autoplay policy blocks audible playback without a gesture,
  // and a rejected play() would leave nothing to observe.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    video.muted = true;
    video.play();
  });
  await waitAxis("playback", "playing");

  await scrollPlayerOutOfView();
  await waitAxis("presence", "occluded");

  // One settle turn: a spurious detach would land inside it.
  await driver.eval(() => new Promise((resolve) => setTimeout(resolve, 300)));
  const isDetached = await driver.eval(detached);
  assert.equal(
    isDetached,
    false,
    "the playhead is advancing, so the HUD is not idle and the rule never applies"
  );
});
