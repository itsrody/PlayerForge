/**
 * Live camera-stream video in a real browser, without hardware.
 *
 * A `srcObject` video (camera/WebRTC preview) never sets src/currentSrc,
 * so it surveys as sourceless unless describeVideo counts the attached
 * stream. Firefox synthesizes devices with `media.navigator.streams.fake`
 * plus a disabled permission gate - no hardware, no prompt, and the 158
 * camera/mic permission path stays out of it. The stream is muted (video
 * only), so autoplay needs no gesture; templates never ask for
 * activation anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";

let driver;
let server;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await FirefoxDriver.launch({
    preferences: {
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
    },
  });
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a srcObject camera stream surveys sourced and adopts its template", async () => {
  const url = createTestPage(server, { players: 1 });
  await driver.navigate(url);
  await driver.injectScript();

  const attached = await driver.eval(async () => {
    const video = document.querySelector("#test-video");
    video.muted = true;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      return "rejected";
    }
    return {
      hasStream: !!video.srcObject,
      paused: video.paused,
      readyState: video.readyState,
    };
  });
  assert.notEqual(attached, "rejected", "the fake camera plays");
  assert.equal(attached.hasStream, true, "the stream is attached, not src");
  assert.equal(attached.paused, false, "the preview is running");

  const deadline = Date.now() + 15000;
  let shells = 0;
  while (Date.now() < deadline) {
    shells = await driver.eval(() => document.querySelectorAll(".pf-shell").length);
    if (shells > 0) {
      break;
    }
    await sleep(100);
  }
  assert.equal(shells, 1, "the templated preview adopted with no src anywhere");
  const marked = await driver.eval(() =>
    document.querySelector("#test-video").hasAttribute("data-pf-shell")
  );
  assert.equal(marked, true, "the video carries the boot mark");
});
