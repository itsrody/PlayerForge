import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * Cue styling is applied while the panel is built, but ForgeTrack is created
 * lazily on the first file load - so the apply used to hit a null track and
 * silently do nothing. The persisted size/colour/shadow only reached the track
 * after the user touched the matching stepper, and a stepper moved BEFORE
 * loading a file was discarded along with the early apply.
 *
 * Own file on purpose: the config store is a module singleton that caches its
 * document on first read, so the seeded pf:configs value has to be in place
 * before anything imports storage.js.
 */
const writes = {};
globalThis.GM_getValue = (key, fallback) => (key in writes ? writes[key] : fallback);
globalThis.GM_setValue = (key, value) => { writes[key] = value; };
globalThis.GM_deleteValue = (key) => { delete writes[key]; };
globalThis.GM_addValueChangeListener = () => 0;
globalThis.GM_removeValueChangeListener = () => {};
globalThis.GM_requestText = () => Promise.resolve("");

// GM storage hands back structured-cloned objects, not JSON strings:
// loadJsonObject only accepts a value that is already an object.
writes["pf:configs"] = {
  version: 1,
  subtitles: { style: { size: 2.5, color: "#ff0000", shadow: 0 } } // shadow 0 = Off
};

const { Shell } = await import("../src/shell/shell.js");

async function makeShell() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1",
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.CSSStyleSheet = class { replaceSync() {} };
  Object.defineProperty(dom.window.document, "adoptedStyleSheets", {
    value: [], writable: true, configurable: true,
  });

  // JSDOM's <track> has no TextTrack IDL, so ForgeTrack's constructor always
  // throws here (trackEl.track === null) and the styling path is never reached.
  // Hand back a track element that looks like the Gecko one.
  const realCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag, ...rest) => {
    if (String(tag).toLowerCase() === "track") {
      const el = realCreate("div");
      el.track = { mode: "disabled", cues: [], addEventListener() {}, removeEventListener() {} };
      return el;
    }
    return realCreate(tag, ...rest);
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const video = dom.window.document.createElement("video");
  container.appendChild(video);

  const shell = new Shell({ video, container, sdk: { name: "test-sdk" } });
  await shell.ready;
  return { dom, shell, container, video };
}

test("persisted cue styling reaches a track created after the panel built [regression]", async () => {
  const { shell, container, dom } = await makeShell();
  await shell.panel.open(); // subtitles section builds here: the early, lost apply

  const host = dom.window.document.querySelector(".pf-shell");
  const cueLayer = host?.shadowRoot?.querySelector(".pf-cue-layer");
  assert.ok(cueLayer, "cue layer exists before any track is loaded");
  assert.equal(
    cueLayer.style.getPropertyValue("--pf-cue-font-size"),
    "",
    "precondition: with no track yet there is nothing the early apply could reach"
  );

  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello";
  const file = new File([vtt], "styled.vtt", { type: "text/vtt" });
  const input = container.querySelector('input[type="file"]');
  assert.ok(input, "file input present");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change"));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(cueLayer.style.getPropertyValue("--pf-cue-font-size"), "2.5em", "saved size applied on track creation");
  assert.equal(cueLayer.style.getPropertyValue("--pf-cue-color"), "#ff0000", "saved colour applied on track creation");
  assert.equal(cueLayer.style.getPropertyValue("--pf-cue-text-shadow"), "none", "shadow Off applied on track creation");
  shell.destroy();
});
