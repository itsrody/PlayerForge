/**
 * Strict-CSP + Trusted-Types boot in a live browser.
 *
 * The fixture document locks its own realm down hard - no page-realm
 * script, string-to-sink writes throw - while the bundle runs in the
 * isolated userScript realm, which page CSP does not govern. Booting and
 * adopting here proves the no-sink posture instead of asserting it: any
 * string-to-DOM sink in the shipped bundle fails this file instead of
 * shipping silently to a banking page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createStrictCspPage, createTestMedia } from "../harness/firefox.mjs";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the bundle boots and adopts on a Trusted-Types-enforcing page", async () => {
  const url = createStrictCspPage(server, {
    videoSrc: createTestMedia(server, 30),
    players: 1,
  });
  await driver.navigate(url);
  await driver.injectScript();

  // Enforcement is really live: a page-realm string sink must throw.
  // Without this, a green adoption below would prove nothing about TT.
  // Name, not instanceof: WebDriver evaluates in a sandbox realm, so a
  // page-realm TypeError fails instanceof against the sandbox global -
  // the same X-ray boundary the bundle itself never reads across.
  const sinkThrows = await driver.eval(() => {
    try {
      const el = document.createElement("div");
      el.innerHTML = "<b>x</b>";
      return false;
    } catch (err) {
      return err && err.name === "TypeError";
    }
  });
  assert.equal(sinkThrows, true, "require-trusted-types-for is enforced on the page realm");

  // The isolated realm is ungoverned by page CSP: the static survey adopts
  // the Plyr-anchored video with no gesture and no media needed.
  const deadline = Date.now() + 15000;
  let shells = 0;
  while (Date.now() < deadline) {
    shells = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
    if (shells > 0) {
      break;
    }
    await sleep(100);
  }
  assert.equal(shells, 1, "the templated player adopted under strict CSP + TT");
  const marked = await driver.eval(() =>
    document.querySelector("#test-video").hasAttribute("data-pf-shell")
  );
  assert.equal(marked, true, "the video carries the boot mark");
});
