import test from "node:test";
import assert from "node:assert/strict";

import { ForgeTrack } from "../src/shell/subtitles/forge-track.js";

/**
 * Mirrors the real TextTrackCue IDL: the writable timing attributes are
 * startTime/endTime. Plain `start`/`end` do not exist on a native cue, so
 * touching one throws here instead of silently creating a shadow property
 * the engine never schedules on.
 */
class FakeVTTCue {
  constructor(start, end, text) {
    this.startTime = start;
    this.endTime = end;
    this.text = text;
    this.line = "auto";
    this.position = 50;
    this.align = "center";
  }

  get start() {
    throw new Error("native VTTCue has no 'start' property; use startTime");
  }

  set start(_value) {
    throw new Error("native VTTCue has no 'start' property; use startTime");
  }

  get end() {
    throw new Error("native VTTCue has no 'end' property; use endTime");
  }

  set end(_value) {
    throw new Error("native VTTCue has no 'end' property; use endTime");
  }
}

/**
 * Fake TextTrack: cue list, add/remove, and an addCue counter so a test can
 * tell a real rebuild (remove + re-add) from a no-op setOffset call.
 */
function fakeTrack() {
  const cues = [];
  const track = {
    cues,
    mode: "disabled",
    addCount: 0,
    addEventListener() {},
    removeEventListener() {},
    addCue(cue) {
      cues.push(cue);
      track.addCount++;
    },
    removeCue(cue) {
      const index = cues.indexOf(cue);
      if (index >= 0) {
        cues.splice(index, 1);
      }
    }
  };
  return track;
}

/**
 * Fake video that can host a track element: ForgeTrack creates its <track>
 * through ownerDocument.createElement and binds trackEl.track - no real
 * DOM or native parsing needed for the offset/rebuild mechanics.
 */
function makeTrack() {
  const track = fakeTrack();
  const trackEl = {
    track,
    src: "",
    addEventListener() {},
    removeEventListener() {},
    remove() {}
  };
  const video = {
    appendChild() {
      return trackEl;
    },
    querySelector() {
      return trackEl;
    },
    ownerDocument: {
      createElement: () => trackEl
    }
  };
  const forgeTrack = new ForgeTrack(video, null);
  return { track, forgeTrack };
}

/**
 * Pristine zero-offset expectations. Rebuild mutates the live cue objects'
 * startTime/endTime, so tests read expected values from this spec data -
 * never from a cue after it has been offset.
 */
const SPECS = [
  { start: 1, end: 2, text: "a" },
  { start: 0.4, end: 0.8, text: "drops below zero" },
  { start: 5.5, end: 7.25, text: "b" },
  { start: 30, end: 32, text: "c" }
];

function baseCues() {
  return SPECS.map((spec) => new FakeVTTCue(spec.start, spec.end, spec.text));
}

/** Expected native times for a base spec under an offset: clamped at t=0,
 *  and zero-length at 0 when the whole shifted window falls before the
 *  origin (never active instead of dropped, keeping the list 1:1). */
function expectedTimes(spec, offset) {
  const start = Math.max(0, spec.start + offset);
  const end = spec.end + offset <= 0 ? 0 : Math.max(0, spec.end + offset);
  return { start, end };
}

test("adopt installs the cue list at zero offset and populates the track", () => {
  const { track, forgeTrack } = makeTrack();
  const cues = baseCues();
  forgeTrack.adopt(cues);
  assert.equal(track.cues.length, cues.length);
  track.cues.forEach((cue, i) => assert.equal(cue, cues[i], `cue ${i} identity`));
});

test("setOffset rebuilds every cue time from the base (clamped, never drifted)", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.adopt(baseCues());
  for (const offset of [2.5, -0.4, -3, 0, 1.75]) {
    forgeTrack.setOffset(offset);
    assert.equal(track.cues.length, SPECS.length, `offset ${offset} keeps the list 1:1`);
    SPECS.forEach((spec, i) => {
      const expected = expectedTimes(spec, offset);
      assert.equal(track.cues[i].startTime, expected.start, `offset ${offset} cue ${i} start`);
      assert.equal(track.cues[i].endTime, expected.end, `offset ${offset} cue ${i} end`);
      assert.equal(track.cues[i].text, spec.text, `offset ${offset} cue ${i} text`);
    });
  }
});

test("a back-and-forth drag restores the original times exactly", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.adopt(baseCues());
  const original = SPECS.map((spec) => [spec.start, spec.end]);
  forgeTrack.setOffset(-8.75);
  forgeTrack.setOffset(4.5);
  forgeTrack.setOffset(0);
  track.cues.forEach((cue, i) => {
    assert.deepEqual([cue.startTime, cue.endTime], original[i], `cue ${i} restored`);
  });
});

test("setOffset rebuilds the list from base while keeping cue identity", () => {
  const { track, forgeTrack } = makeTrack();
  const cues = baseCues();
  forgeTrack.adopt(cues);
  const addsAfterAdopt = track.addCount;
  forgeTrack.setOffset(-1.25);
  assert.ok(track.addCount > addsAfterAdopt, "rebuild re-adds the cues");
  track.cues.forEach((cue, i) => {
    assert.equal(cue, cues[i], "same cue objects survive a re-offset");
  });
  // A repeat of the current offset is a no-op: no remove/re-add churn.
  const addsAfterFirst = track.addCount;
  forgeTrack.setOffset(-1.25);
  assert.equal(track.addCount, addsAfterFirst, "repeat offset does not rebuild");
});

test("adopt plus an immediate offset mirrors loadText's build pass", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.adopt(baseCues());
  forgeTrack.setOffset(-2.5);
  SPECS.forEach((spec, i) => {
    const expected = expectedTimes(spec, -2.5);
    assert.equal(track.cues[i].startTime, expected.start, `cue ${i} start`);
    assert.equal(track.cues[i].endTime, expected.end, `cue ${i} end`);
  });
});

test("a list that diverges from the base heals on the next setOffset", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.adopt(baseCues());
  track.removeCue(track.cues[1]);
  assert.equal(track.cues.length, SPECS.length - 1);
  forgeTrack.setOffset(1.5);
  assert.equal(track.cues.length, SPECS.length, "rebuild restores the 1:1 pairing");
  SPECS.forEach((spec, i) => {
    const expected = expectedTimes(spec, 1.5);
    assert.equal(track.cues[i].startTime, expected.start, `cue ${i} start`);
    assert.equal(track.cues[i].endTime, expected.end, `cue ${i} end`);
  });
});

test("setOffset after destroy is a no-op", () => {
  const { forgeTrack } = makeTrack();
  forgeTrack.adopt(baseCues());
  forgeTrack.destroy();
  assert.doesNotThrow(() => forgeTrack.setOffset(5));
});

test("adopt after destroy is a no-op", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.destroy();
  forgeTrack.adopt(baseCues());
  assert.equal(track.cues.length, 0, "a destroyed track stays empty");
});
