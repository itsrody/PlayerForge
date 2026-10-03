/**
 * §5's occlusion reading, taken with the Gecko Profiler instead of by hand.
 *
 * The row behind this used to be phrased as a manual profiler reading —
 * `Styles` / `Reflow` / `Rasterize` flat while occluded — because Firefox
 * shows none of that to content, and the userscript runs in the add-on's
 * isolated realm where no page-side instrumentation reaches. The harness
 * add-on can ask, though: `browser.geckoProfiler` is the API behind the
 * profiler button, Firefox grants it to extension ids listed in
 * `extensions.geckoProfiler.acceptedExtensionIds`, and the harness puts its
 * own id on that list before it installs the add-on (FirefoxDriver.launch).
 * The permission arrives at install, so there is no gesture to synthesize.
 *
 * What a headless profile actually reports decides what is asserted. Of the
 * markers in a refresh tick, `Styles`, `DisplayList`, `RefreshDriverTick` and
 * the composition side (`SetDisplayList`, `SceneBuilding`, `BuildFrame`,
 * `CompositeToTarget`) all move; `Reflow`, `LayerBuilding` and `Rasterize`
 * counted zero across every window measured here, including a loop of forty
 * genuine forced reflows — so asserting those would pass for the wrong
 * reason, and the test says so rather than pinning zeros.
 *
 * The differential is the whole method. The same drive is sampled four times:
 * idle and driving with the HUD on screen, then idle and driving with it
 * detached. That cancels the page out of the measurement — and the drive is
 * deliberately media-neutral (volume keys while the video is paused), so the
 * attached window's delta is PF's HUD reaching the compositor and not a video
 * repainting underneath it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel, waitForMediaReady } from "../harness/page.mjs";

/** Refresh-tick and composition markers the profiler reports in this build. */
const MARKERS = [
  "RefreshDriverTick",
  "Styles",
  "Reflow",
  "DisplayList",
  "LayerBuilding",
  "Rasterize",
  "SetDisplayList",
  "SceneBuilding",
  "BuildFrame",
  "CompositeToTarget"
];

/** One window of nothing, long enough for a settled page to show its floor. */
const idle = () => new Promise((resolve) => setTimeout(resolve, 1200));

/**
 * HUD work the video does not participate in.
 *
 * Volume keys move the pill and the volume readout without touching a frame
 * of a paused video, so the attached window's counters cannot be the video's
 * work wearing PF's numbers.
 */
const drive = async () => {
  const key = (name) =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true })
    );
  for (let i = 0; i < 25; i++) {
    key(i % 2 ? "ArrowUp" : "ArrowDown");
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
};

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
}

/** Profile one window and return the marker counts it produced. */
async function sample(fn) {
  await driver.profilerStart({ interval: 1, features: [] });
  await driver.eval(fn);
  const { counts } = await driver.profilerSummarize(MARKERS);
  await driver.profilerStop();
  return counts;
}

const detached = () =>
  !!document.querySelector(".pf-shell")?.classList.contains("pf-detached");

/** Put the player far below the viewport so the observer reports occluded. */
async function scrollPlayerOutOfView() {
  const scrolled = await driver.eval(() => {
    if (!document.getElementById("pf-spacer")) {
      const spacer = document.createElement("div");
      spacer.id = "pf-spacer";
      spacer.style.height = "4000px";
      document.body.appendChild(spacer);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    return window.scrollY;
  });
  assert.ok(scrolled > 0, `the page had to scroll (got ${scrolled})`);
  await driver.waitFor(detached, 8000, 50);
  // Let the scroll's own display-list work finish before the window opens,
  // so the baseline is a settled page rather than the tail of the scroll.
  await driver.eval(() => new Promise((resolve) => setTimeout(resolve, 500)));
}

async function scrollPlayerBackIntoView() {
  await driver.eval(() => window.scrollTo(0, 0));
  await driver.waitFor(
    () => !document.querySelector(".pf-shell")?.classList.contains("pf-detached"),
    8000,
    50
  );
  await driver.eval(() => new Promise((resolve) => setTimeout(resolve, 500)));
}

test("the HUD's profile footprint is visible while on screen and gone while detached", async () => {
  await boot();

  // The profiler has to be usable at all, or every number below is zero for
  // the wrong reason.
  assert.equal(
    await driver.profilerUsable(),
    true,
    "the harness add-on must hold geckoProfiler for this reading to mean anything"
  );

  const attachedIdle = await sample(idle);
  const attachedDrive = await sample(drive);

  await scrollPlayerOutOfView();
  const occludedIdle = await sample(idle);
  const occludedDrive = await sample(drive);

  await scrollPlayerBackIntoView();
  const returnedDrive = await sample(drive);

  // Non-vacuous: the drive is visible to the profiler with the HUD on screen.
  assert.ok(
    attachedDrive.SetDisplayList >= attachedIdle.SetDisplayList + 15,
    `the drive must show up when the HUD is rendered: idle ${JSON.stringify(attachedIdle)}` +
      ` against driving ${JSON.stringify(attachedDrive)}`
  );

  // The invariant: the same work costs nothing while the HUD is detached.
  assert.ok(
    occludedDrive.SetDisplayList <= Math.floor(attachedDrive.SetDisplayList / 4),
    `flat while occluded: driving ${occludedDrive.SetDisplayList} against ` +
      `${attachedDrive.SetDisplayList} on screen`
  );
  assert.ok(
    occludedDrive.SetDisplayList <= occludedIdle.SetDisplayList + 5,
    `driving must not move the counters while detached: idle ${occludedIdle.SetDisplayList}` +
      ` against driving ${occludedDrive.SetDisplayList}`
  );
  assert.ok(
    occludedDrive.CompositeToTarget <= Math.floor(attachedDrive.CompositeToTarget / 4),
    `no composition attributable to the HUD while detached: ${occludedDrive.CompositeToTarget}` +
      ` against ${attachedDrive.CompositeToTarget} on screen`
  );

  // And it comes back: a detached HUD that never reattached would pass every
  // assertion above by doing nothing at all.
  assert.ok(
    returnedDrive.SetDisplayList >= Math.floor(attachedDrive.SetDisplayList / 4),
    `the footprint returns with the HUD: ${returnedDrive.SetDisplayList} against ` +
      `${attachedDrive.SetDisplayList} before the scroll`
  );
});
