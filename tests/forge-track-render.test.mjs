import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { ForgeTrack } from "../src/shell/subtitles/forge-track.js";

/**
 * The renderer half of the native TextTrack backend.
 *
 * Gecko parses the WebVTT and fires cuechange; this file's subject is what
 * forge-track.js does with that - the pooled slots, the CSS custom properties,
 * and above all the one branch that only a real cue can exercise:
 * `cue.getCueAsHTML()` builds the spec-whitelisted WebVTT markup (<b>, <i>,
 * <c>, ruby) as real nodes, which is why the renderer never parses the cue
 * text itself. Every other test in the tree drove a cue double with no
 * getCueAsHTML, so the branch production runs was the textContent fallback.
 *
 * Real jsdom elements throughout (a real <video>, a real <track> the fake
 * track is hung on, a real cue layer), so the assertions are about the
 * renderer's output rather than about a stand-in's shape. Only the TextTrack
 * object and the cues are faked: jsdom implements no WebVTT parser, cue
 * scheduling, or HTMLTrackElement.track at all.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/watch" });
const { document } = dom.window;

/**
 * jsdom's cssstyle defines textAlign and writingMode but drops their values
 * (its camelCase setters validate against a property table it does not
 * implement), so the renderer's assignments land on nothing and read back
 * empty. Reflect both onto the prototype that actually defines them - the
 * CSSStyleProperties level, above CSSStyleDeclaration in the chain - for this
 * file only: a real browser applies both, and src/ is not reshaped to
 * satisfy a test host, the rule tests/loader.mjs follows for missing globals.
 */
for (const [prop, cssName] of [
  ["textAlign", "text-align"],
  ["writingMode", "writing-mode"]
]) {
  const styleProto = Object.getPrototypeOf(document.createElement("div").style);
  Object.defineProperty(styleProto, prop, {
    configurable: true,
    enumerable: true,
    get() {
      return this.getPropertyValue(cssName);
    },
    set(value) {
      this.setProperty(cssName, value);
    }
  });
}

/**
 * TextTrackCue-shaped cue. `html` switches on the native branch: present means
 * getCueAsHTML exists (Gecko), absent means a bare double that can only be
 * rendered as text.
 */
function cue(props = {}, { html = true } = {}) {
  const c = {
    startTime: 0,
    endTime: 1,
    text: "plain",
    line: "auto",
    position: 50,
    align: "center",
    snapToLines: true,
    ...props
  };
  if (html) {
    c.getCueAsHTML = () => {
      const fragment = document.createDocumentFragment();
      const b = document.createElement("b");
      b.textContent = c.text;
      fragment.append(b);
      return fragment;
    };
  }
  return c;
}

/** TextTrack double: cue list plus a settable activeCues the test drives. */
function fakeTrack() {
  const listeners = new Map();
  const track = {
    cues: [],
    mode: "disabled",
    activeCues: null,
    addCue(cue) {
      track.cues.push(cue);
    },
    removeCue(cue) {
      const index = track.cues.indexOf(cue);
      if (index >= 0) {
        track.cues.splice(index, 1);
      }
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    /** What Gecko does at a cue boundary: set activeCues, then fire. */
    activate(...active) {
      track.activeCues = active;
      listeners.get("cuechange")?.();
    }
  };
  return track;
}

/**
 * A fresh video/track/layer triple per test, with the fake TextTrack hung on
 * the <track> element. Built in code rather than parsed once from markup
 * because destroy() removes the <track> element it owns - sharing one
 * document would leave the second test with a video that cannot host a track.
 */
function makeTrack() {
  const video = document.createElement("video");
  const trackEl = document.createElement("track");
  trackEl.setAttribute("data-pf-subtitles", "");
  video.appendChild(trackEl);
  const cueLayer = document.createElement("div");
  document.body.append(video, cueLayer);
  const track = fakeTrack();
  Object.defineProperty(trackEl, "track", { value: track, configurable: true });
  return { track, trackEl, cueLayer, forgeTrack: new ForgeTrack(video, cueLayer) };
}

const slotAt = (cueLayer, i) => cueLayer.children[i];

test("the native fragment becomes real nodes, not escaped text", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ text: "hello" })]);
  assert.equal(track.cues.length, 1, "the cue is installed on the track");

  track.activate(track.cues[0]);
  const slot = slotAt(cueLayer, 0);
  assert.equal(slot.querySelector("b")?.textContent, "hello", "the <b> node survived");
  assert.equal(slot.textContent, "hello");
  assert.equal(slot.children.length, 1, "the fragment was adopted, not stringified");
  assert.equal(slot.hidden, false, "a live cue reveals its slot");
  forgeTrack.destroy();
});

test("a cue without getCueAsHTML falls back to plain text", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ text: "<b>not markup</b>" }, { html: false })]);

  track.activate(track.cues[0]);
  const slot = slotAt(cueLayer, 0);
  assert.equal(slot.textContent, "<b>not markup</b>", "the source text is shown verbatim");
  assert.equal(slot.querySelector("b"), null, "and never interpreted as markup");
  forgeTrack.destroy();
});

test("a re-render of the same cue does not rebuild its children", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ text: "hello" })]);
  track.activate(track.cues[0]);
  const slot = slotAt(cueLayer, 0);
  const first = slot.firstChild;
  const calls = [];
  const original = track.cues[0].getCueAsHTML;
  track.cues[0].getCueAsHTML = () => {
    calls.push(1);
    return original();
  };

  track.activate(track.cues[0]);
  assert.deepEqual(calls, [], "an unchanged cue skips the fragment build");
  assert.equal(slot.firstChild, first, "the DOM was left alone on the hot path");
  forgeTrack.destroy();
});

test("cue settings drive the slot's custom properties", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ line: 3, position: 20, align: "start", vertical: "rl" })]);

  track.activate(track.cues[0]);
  const slot = slotAt(cueLayer, 0);
  // lineTop: snap-to-lines counts one 1lh box per step, lifted by the stack
  // term for simultaneous cues.
  assert.equal(slot.style.getPropertyValue("--pf-cue-top"), "calc(3 * 1lh - 0em)");
  assert.equal(slot.style.getPropertyValue("--pf-cue-left"), "20%");
  assert.equal(slot.style.getPropertyValue("--pf-cue-x"), "0", "align:start anchors the left edge");
  assert.equal(slot.style.textAlign, "left");
  assert.equal(slot.style.writingMode, "vertical-rl");
  forgeTrack.destroy();
});

test("the legacy percent line model is honoured when snapToLines is off", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ line: -10, snapToLines: false })]);

  track.activate(track.cues[0]);
  const slot = slotAt(cueLayer, 0);
  assert.equal(slot.style.getPropertyValue("--pf-cue-top"), "calc(90% - 0em)", "-10 means 100 + line");
  forgeTrack.destroy();
});

test("an auto line keeps the bottom anchor", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ line: "auto" })]);

  track.activate(track.cues[0]);
  assert.equal(slotAt(cueLayer, 0).style.getPropertyValue("--pf-cue-top"), "calc(85% - 0em)");
  forgeTrack.destroy();
});

test("simultaneous cues stack by slot index", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ line: 0 }), cue({ line: 0 }), cue({ line: 0 })]);

  track.activate(...track.cues);
  assert.equal(slotAt(cueLayer, 0).style.getPropertyValue("--pf-cue-top"), "calc(0 * 1lh - 0em)");
  assert.equal(slotAt(cueLayer, 1).style.getPropertyValue("--pf-cue-top"), "calc(0 * 1lh - 1.6em)");
  assert.equal(slotAt(cueLayer, 2).style.getPropertyValue("--pf-cue-top"), "calc(0 * 1lh - 3.2em)");
  forgeTrack.destroy();
});

test("a surviving cue is re-stacked when an earlier one exits", () => {
  // Gecko re-fires cuechange with the full active list, so the cue that was
  // second is now first - and its stack offset has to be recomputed for the
  // new index, which is what the per-slot prevI check exists for.
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue({ text: "a", line: 0 }), cue({ text: "b", line: 0 })]);
  track.activate(...track.cues);
  assert.equal(slotAt(cueLayer, 0).textContent, "a");
  assert.equal(slotAt(cueLayer, 1).style.getPropertyValue("--pf-cue-top"), "calc(0 * 1lh - 1.6em)");

  track.activate(track.cues[1]);
  assert.equal(slotAt(cueLayer, 0).textContent, "b", "the survivor moved up a slot");
  assert.equal(
    slotAt(cueLayer, 0).style.getPropertyValue("--pf-cue-top"),
    "calc(0 * 1lh - 0em)",
    "and its stack offset followed the new index"
  );
  forgeTrack.destroy();
});

test("an empty activeCues hides the slots again", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue()]);
  track.activate(track.cues[0]);
  assert.equal(slotAt(cueLayer, 0).hidden, false);

  track.activate();
  assert.equal(slotAt(cueLayer, 0).hidden, true, "a cue exit hides the slot");
  forgeTrack.destroy();
});

test("clear() hides every slot on a cue exit", () => {
  const { track, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue(), cue()]);
  track.activate(...track.cues);

  forgeTrack.clear();
  assert.ok([...cueLayer.children].every((slot) => slot.hidden));
  forgeTrack.destroy();
});

test("destroy unregisters cuechange and stops rendering", () => {
  const { track, trackEl, cueLayer, forgeTrack } = makeTrack();
  forgeTrack.adopt([cue()]);
  track.activate(track.cues[0]);
  forgeTrack.destroy();

  assert.equal(track.mode, "disabled", "the native track is disabled on teardown");
  assert.equal(trackEl.isConnected, false, "our <track> element was removed, taking its cues with it");
  assert.equal(cueLayer.children.length, 0, "the pooled slots went with it");

  // A late cuechange after teardown must not resurrect anything.
  assert.doesNotThrow(() => track.activate(cue()), "the listener is gone, so nothing renders");
  assert.equal(cueLayer.children.length, 0);
});
