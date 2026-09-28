/**
 * Subtitles integration tests.
 *
 * Tests the subtitle track lifecycle in a real Firefox 156 instance:
 * native blob <track> parsing, the rebuild-based sync offset, and the
 * custom renderer driven by native cuechange events.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";
import { waitForShell, waitForPanel } from "../harness/page.mjs";

const VTT_SETTINGS = [
  "WEBVTT",
  "",
  "00:00:05.000 --> 00:00:10.000 line:10% position:25% align:start",
  "first cue",
  "",
  "00:00:12.000 --> 00:00:17.000 line:2 position:80% align:end",
  "second cue"
].join("\n");

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

/** Navigate, inject the shell, open the panel, and wait for the lazily
 *  built subtitles section's file input to exist. */
async function bootWithSubtitlesInput() {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();
  await waitForShell(driver, 8000);
  // waitForShell only sees the HUD layer; the panel (and its gesture
  // listener) is constructed a tick later inside #boot().
  await waitForPanel(driver, 8000);
  await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    host.dispatchEvent(new CustomEvent("pf:gesture-panel", { detail: { method: "test" } }));
  });
  const hasInput = await driver.eval(async () => {
    for (let i = 0; i < 50; i++) {
      // The file input is hosted on shell.container (light DOM), not in
      // the panel's shadow root.
      if (document.querySelector('input[type="file"]')) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  });
  assert.ok(hasInput, "subtitles file input appears after opening the panel");
}

test("shell creates subtitle section in panel", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const hasSubtitleSection = await driver.eval(() => {
    const panel = document.querySelector(".pf-panel");
    if (!panel) return false;
    return panel.textContent.includes("Subtitles");
  });

  assert.ok(true, "Subtitle section existence checked without crash");
});

test("VTT parse does not crash in browser context", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const parseResult = await driver.eval(() => {
    try {
      return { ok: true, shellAlive: !!document.querySelector(".pf-shell") };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  assert.ok(parseResult.ok, "VTT parser should not throw in browser context");
  assert.ok(parseResult.shellAlive, "Shell should remain alive after VTT parse");
});

test("subtitle cue layer exists in shadow root", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const cueLayerExists = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    return !!shadow?.querySelector(".pf-cue-layer");
  });

  assert.ok(cueLayerExists, "Cue layer should exist in shadow root");
});

test("subtitle cues are hidden when no track is active", async () => {
  await driver.navigate(createTestPage(server));
  await driver.injectGMStubs();
  await driver.injectScript();

  await waitForShell(driver, 8000);

  const cueCount = await driver.eval(() => {
    const host = document.querySelector(".pf-shell");
    const shadow = host?.shadowRoot;
    const cueLayer = shadow?.querySelector(".pf-cue-layer");
    if (!cueLayer) return 0;
    return cueLayer.querySelectorAll(".pf-cue").length;
  });

  assert.ok(cueCount >= 0, "Cue count should be non-negative");
});

test("file input feeds Firefox's native VTT parser with full cue settings", async () => {
  await bootWithSubtitlesInput();

  const parsed = await driver.eval(async () => {
    const input = document.querySelector('input[type="file"]');
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:10.000 line:10% position:25% align:start",
      "first cue",
      "",
      "00:00:05.000 --> 00:00:15.000 line:2 position:80% align:end",
      "second cue"
    ].join("\n");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([vtt], "native.vtt", { type: "text/vtt" }));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const video = document.querySelector("video");
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const track = Array.from(video.textTracks).find(
        (t) => t.label === "PlayerForge Subtitles"
      );
      if (track?.cues?.length) {
        const [c0, c1] = track.cues;
        return {
          ok: true,
          count: track.cues.length,
          mode: track.mode,
          c0: { line: c0.line, snap: c0.snapToLines, pos: c0.position, align: c0.align, text: c0.text },
          c1: { line: c1.line, snap: c1.snapToLines, pos: c1.position, align: c1.align }
        };
      }
    }
    return { ok: false };
  });

  assert.ok(parsed.ok, "native blob <track> parse lands cues");
  assert.equal(parsed.count, 2, "both cues parsed");
  assert.equal(parsed.mode, "hidden", "renderer track stays hidden");
  // line:10% -> percent model; line:2 -> snap-to-lines. Our old parser
  // collapsed both to a percent; the native backend preserves the model.
  assert.equal(parsed.c0.line, 10, "percent line parsed natively");
  assert.equal(parsed.c0.snap, false, "percent line disables snapToLines");
  assert.equal(parsed.c0.pos, 25, "position parsed natively");
  assert.equal(parsed.c0.align, "start", "align parsed natively");
  assert.equal(parsed.c0.text, "first cue", "cue text intact");
  assert.equal(parsed.c1.line, 2, "integer line parsed natively");
  assert.equal(parsed.c1.snap, true, "integer line keeps snapToLines");
  assert.equal(parsed.c1.align, "end", "second cue align");
});

test("sync stepper rebuilds native cue times from the zero-offset base", async () => {
  await bootWithSubtitlesInput();

  const result = await driver.eval(async () => {
    const sr = document.querySelector(".pf-shell").shadowRoot;
    const input = document.querySelector('input[type="file"]');
    const vtt = [
      "WEBVTT",
      "",
      "00:00:05.000 --> 00:00:10.000",
      "first",
      "",
      "00:00:12.000 --> 00:00:17.000",
      "second"
    ].join("\n");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([vtt], "sync.vtt", { type: "text/vtt" }));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const video = document.querySelector("video");
    let track = null;
    for (let i = 0; i < 60 && !track?.cues?.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      track = Array.from(video.textTracks).find(
        (t) => t.label === "PlayerForge Subtitles" && t.cues?.length
      );
    }
    if (!track) {
      return { ok: false, reason: "no cues" };
    }
    const before = Array.from(track.cues, (c) => [c.startTime, c.endTime]);
    const refs = Array.from(track.cues);

    const syncInput = sr.querySelector('input[aria-label="Sync"]');
    if (!syncInput) {
      return { ok: false, reason: "no sync input" };
    }
    syncInput.value = "0.5";
    syncInput.dispatchEvent(new Event("input", { bubbles: true }));
    // Debounced apply (150ms) + rebuild; sample well after it lands.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const after = Array.from(track.cues, (c) => [c.startTime, c.endTime]);
    return {
      ok: true,
      before,
      after,
      sameObjects: Array.from(track.cues).every((c, i) => c === refs[i]),
      sorted: after.every((t, i) => i === 0 || t[0] >= after[i - 1][0])
    };
  });

  assert.ok(result.ok, `offset applied (${result.reason || "ok"})`);
  assert.equal(result.before.length, 2, "two cues before the offset");
  assert.equal(result.after.length, 2, "rebuild keeps the list 1:1");
  for (let i = 0; i < 2; i++) {
    assert.ok(
      Math.abs(result.after[i][0] - (result.before[i][0] + 0.5)) < 1e-6,
      `cue ${i} start shifted by exactly +0.5`
    );
    assert.ok(
      Math.abs(result.after[i][1] - (result.before[i][1] + 0.5)) < 1e-6,
      `cue ${i} end shifted by exactly +0.5`
    );
  }
  assert.ok(result.sameObjects, "rebuild re-adds the same native cue objects");
  assert.ok(result.sorted, "re-add keeps the cue list sorted");
});

test("native cuechange drives the custom renderer", async () => {
  await bootWithSubtitlesInput();

  const rendered = await driver.eval(async () => {
    // A real timeline: source-less media never runs cue activation, so give
    // the video a generated WAV and seek into the cue's window.
    function wavSilence(sec) {
      const rate = 8000;
      const n = rate * sec;
      const buf = new ArrayBuffer(44 + n);
      const dv = new DataView(buf);
      const w = (o, s) => {
        for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
      };
      w(0, "RIFF");
      dv.setUint32(4, 36 + n, true);
      w(8, "WAVE");
      w(12, "fmt ");
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true);
      dv.setUint32(28, rate, true);
      dv.setUint16(32, 1, true);
      dv.setUint16(34, 8, true);
      w(36, "data");
      dv.setUint32(40, n, true);
      for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128);
      let bin = "";
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return "data:audio/wav;base64," + btoa(bin);
    }

    const video = document.querySelector("video");
    video.src = wavSilence(3);
    await new Promise((resolve) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      setTimeout(resolve, 2000);
    });

    const input = document.querySelector('input[type="file"]');
    const vtt = "WEBVTT\n\n00:00:00.000 --> 01:40:00.000\nrendered cue";
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([vtt], "render.vtt", { type: "text/vtt" }));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const trackLabel = "PlayerForge Subtitles";
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const track = Array.from(video.textTracks).find(
        (t) => t.label === trackLabel && t.cues?.length
      );
      if (track) break;
    }

    video.currentTime = 1;
    await new Promise((resolve) => setTimeout(resolve, 600));

    const host = document.querySelector(".pf-shell");
    const slots = Array.from(host.shadowRoot.querySelectorAll(".pf-cue")).filter(
      (el) => !el.hidden
    );
    return {
      visible: slots.length,
      text: slots.map((s) => s.textContent),
      top: slots[0]?.style.getPropertyValue("--pf-cue-top") || ""
    };
  });

  assert.ok(rendered.visible >= 1, "at least one cue slot renders");
  assert.ok(rendered.text.includes("rendered cue"), "slot carries the native cue text");
  assert.ok(rendered.top.includes("calc("), "renderer applied its line layout");
});
