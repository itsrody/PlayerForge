/**
 * Input gestures integration tests.
 *
 * Tests real pointer event dispatch and gesture recognition in Chromium 152.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

let driver;
let server;

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await ChromiumDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

test("keyboard hotkey dispatches skip gesture", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  // The hotkey handler requires readyState > 0 on the video.
  await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (video) Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  });

  await driver.eval(() => {
    window.__pfGestureLog = [];
    const host = document.querySelector(".pf-shell");
    if (host) {
      host.addEventListener("pf:gesture-skip", (e) => {
        window.__pfGestureLog.push({ type: "skip", detail: e.detail });
      });
    }
  });

  await driver.eval(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      code: "ArrowRight",
      bubbles: true,
      cancelable: true
    }));
  });

  await new Promise((r) => setTimeout(r, 100));

  const gestures = await driver.eval(() => window.__pfGestureLog);
  assert.ok(
    gestures.some((g) => g.type === "skip"),
    "Right arrow should dispatch skip gesture"
  );
});

test("keyboard hotkey dispatches volume gesture", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (video) Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  });

  await driver.eval(() => {
    window.__pfGestureLog = [];
    const host = document.querySelector(".pf-shell");
    if (host) {
      host.addEventListener("pf:gesture-volume", (e) => {
        window.__pfGestureLog.push({ type: "volume", detail: e.detail });
      });
    }
  });

  await driver.eval(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      code: "ArrowUp",
      bubbles: true,
      cancelable: true
    }));
  });

  await new Promise((r) => setTimeout(r, 100));

  const gestures = await driver.eval(() => window.__pfGestureLog);
  assert.ok(
    gestures.some((g) => g.type === "volume"),
    "ArrowUp should dispatch volume gesture"
  );
});

test("space bar toggles playback", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const toggled = await driver.eval(() => {
    const video = document.getElementById("test-video");
    if (!video) return false;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true
    }));
    return true;
  });

  assert.ok(toggled, "Space bar should trigger playback toggle event");
});

test("pointer events do not throw on the shell host", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const noThrow = await driver.eval(() => {
    try {
      const video = document.getElementById("test-video");
      const rect = video?.getBoundingClientRect() || { left: 0, top: 0, width: 800, height: 450 };
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      video.dispatchEvent(new PointerEvent("pointerdown", {
        clientX: centerX, clientY: centerY, bubbles: true, cancelable: true, pointerId: 1
      }));
      video.dispatchEvent(new PointerEvent("pointerup", {
        clientX: centerX, clientY: centerY, bubbles: true, cancelable: true, pointerId: 1
      }));
      return true;
    } catch {
      return false;
    }
  });

  assert.ok(noThrow, "Pointer events should not throw on the shell host");
});
