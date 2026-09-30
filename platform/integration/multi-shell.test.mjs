/**
 * Two players in ONE document, in a real Firefox 157 instance.
 *
 * The registry used to be a single slot that the newest shell overwrote, and a
 * page really can hold more than one player: the kernel adopts every
 * qualifying <video> it finds, and this repo's own gm-multisubscriber test
 * asserts two shells in a single document. With a single slot, removing a
 * player that was not the most recent one looked its shell up, found nothing,
 * and destroyed nothing at all - the shell stayed alive holding document-level
 * hotkey listeners, DOM observers and a live pf:resume subscription.
 *
 * Every failure here is invisible from the document: a leaked shell's DOM goes
 * away with the container that held it, so counting .pf-shell elements only
 * proves the container was detached. The assertion has to be about the VIDEO,
 * held in page state before it is removed. data-pf-shell is set on boot and
 * removed by Shell.destroy(), so it is the page-visible record of whether
 * teardown actually ran for that specific player.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage, createTestMedia } from "../harness/firefox.mjs";

let driver;
let server;

const MEDIA_SECONDS = 90;
/** The kernel's removal grace plus room for the watcher to settle. */
const SETTLE_MS = 2500;

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

/** Open a two-player page, wait for both shells, and pin both videos in page state. */
async function openTwoPlayers() {
  const url = createTestPage(server, {
    videoSrc: createTestMedia(server, MEDIA_SECONDS),
    players: 2
  });
  await driver.navigate(url);
  await driver.injectScript();

  const deadline = Date.now() + 15000;
  let shells = 0;
  while (Date.now() < deadline) {
    shells = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
    if (shells === 2) {
      break;
    }
    await sleep(100);
  }
  assert.equal(shells, 2, "both Plyr-anchored players in one document get a shell");

  // Keep the videos reachable: the one under test leaves the document, so
  // nothing in the page could look it up afterwards.
  const ids = await driver.eval(() => {
    const videos = [...document.querySelectorAll(".plyr")].map((p) => p.querySelector("video"));
    window.__v1 = videos[0];
    window.__v2 = videos[1];
    return [window.__v1.id, window.__v2.id];
  });
  assert.deepEqual(ids, ["test-video", "test-video-1"], "two distinct players are tracked");
}

const marked = (which) => driver.eval((w) => window[w].hasAttribute("data-pf-shell"), which);

for (const how of ["video", "container"]) {
  test(`removing the FIRST player as its ${how} tears down that shell only`, async () => {
    await openTwoPlayers();

    // The first player is NOT the most recent registration, which is exactly
    // the lookup a single-slot registry cannot answer.
    await driver.eval((which) => {
      const player = window.__v1.closest(".plyr");
      if (which === "container") {
        player.remove();
      } else {
        window.__v1.remove();
      }
    }, how);
    await sleep(SETTLE_MS);

    assert.equal(await marked("__v1"), false, "the removed player's shell was destroyed");
    assert.equal(await marked("__v2"), true, "the other player's shell is untouched");
  });
}

test("both players can be removed, in either order", async () => {
  await openTwoPlayers();

  // Reverse of the case above: the most recent registration goes first, which
  // the old slot did handle. The second removal only works if the first one
  // left the registry able to find the survivor.
  await driver.eval(() => window.__v2.remove());
  await sleep(SETTLE_MS);
  assert.equal(await marked("__v2"), false, "the second player tore down");
  assert.equal(await marked("__v1"), true, "the first player is still live");

  await driver.eval(() => window.__v1.remove());
  await sleep(SETTLE_MS);
  assert.equal(await marked("__v1"), false, "and so does the first");
});
