/**
 * §5 invariant 1, page-side half: "Zero steady-state main-thread cost when
 * idle".
 *
 * The profiler half of that row ("no markers between transitions") is a
 * Gecko Profiler reading and cannot be taken from here - Firefox exposes no
 * layout, paint or longtask counters to content, and the userscript runs in
 * the add-on's isolated realm that no page-side instrumentation can reach
 * (the control channel speaks storage and nothing else). What the page *can*
 * see, and what actually follows from "idle costs nothing", is that PF stops
 * touching the shared DOM entirely:
 *
 *   - zero mutations anywhere under the shell host over an idle window. A
 *     mutation is the cheapest thing PF could do that still invalidates
 *     style somewhere, so an idle shell that writes nothing is an idle shell
 *     that is not recalculating, not laying out and not painting;
 *   - zero `pf:status` transitions in the same window. The status event is
 *     this fork's notion of "a transition happened", so silence is the
 *     invariant stated in its own terms rather than a timeout we waited out.
 *
 * The fixture boots paused and is never touched during the window, so there
 * is no external event for PF to legitimately react to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel, waitForMediaReady } from "../harness/page.mjs";

/** Long enough to span several frames and any timer a stray loop would own. */
const IDLE_MS = 1200;

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

test("an idle shell writes nothing to the DOM and raises no status transition", async () => {
  await driver.navigate(createTestPage(server, { videoSrc: createTestMedia(server, 30) }));
  await driver.injectGMStubs();
  await driver.injectScript();
  await waitForShell(driver, 8000);
  await waitForPanel(driver, 8000);
  await waitForMediaReady(driver, 8000);

  const boot = await driver.eval(() => {
    const video = document.getElementById("test-video");
    window.__pfIdleTransitions = [];
    video.addEventListener("pf:status", (event) => {
      window.__pfIdleTransitions.push(event.detail);
    });
    return {
      paused: video.paused,
      host: !!document.querySelector(".pf-shell")
    };
  });
  assert.equal(boot.paused, true, "the fixture boots unstarted, i.e. idle");
  assert.ok(boot.host, "there is a shell to watch");

  // Let boot's own writes land before the window opens: the assertion is about
  // steady state, not about the frame in which the shell finished building.
  await driver.eval(() => new Promise((resolve) => setTimeout(resolve, 400)));

  const idle = await driver.eval(
    (ms) =>
      new Promise((resolve) => {
        const host = document.querySelector(".pf-shell");
        const mutations = [];
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            mutations.push(
              `${record.type} on ${record.target.nodeName}${
                record.attributeName ? ` [${record.attributeName}]` : ""
              }`
            );
          }
        });
        observer.observe(host, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
        setTimeout(() => {
          observer.disconnect();
          resolve({
            mutations,
            transitions: window.__pfIdleTransitions.length
          });
        }, ms);
      }),
    IDLE_MS
  );

  assert.deepEqual(
    idle.mutations,
    [],
    "a steady-state shell invalidates nothing: every mutation here would recalc style for it"
  );
  assert.equal(
    idle.transitions,
    0,
    "no status transition inside the window, so there was nothing to repaint"
  );
});
