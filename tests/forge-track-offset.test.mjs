import test from "node:test";
import assert from "node:assert/strict";

import { ForgeTrack } from "../src/shell/subtitles/forge-track.js";
import { offsetCues } from "../src/shell/subtitles/forgevtt.js";

/**
 * Mirrors the real TextTrackCue IDL: the writable timing attributes are
 * startTime/endTime. Plain `start`/`end` do not exist on a native cue (they
 * are forgevtt's own cue-object fields), so touching one throws here instead
 * of silently creating a shadow property the engine never schedules on.
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
globalThis.VTTCue = FakeVTTCue;

function fakeTrack() {
  const cues = [];
  return {
    cues,
    mode: "disabled",
    addEventListener() {},
    removeEventListener() {},
    addCue(cue) {
      cues.push(cue);
    },
    removeCue(cue) {
      const index = cues.indexOf(cue);
      if (index >= 0) {
        cues.splice(index, 1);
      }
    }
  };
}

function makeTrack() {
  const track = fakeTrack();
  const forgeTrack = new ForgeTrack({ addTextTrack: () => track }, null);
  return { track, forgeTrack };
}

const BASE = [
  { start: 1, end: 2, text: "a", line: "auto", position: 50, align: "center" },
  { start: 0.4, end: 0.8, text: "drops below zero", line: "auto", position: 50, align: "center" },
  { start: 5.5, end: 7.25, text: "b", line: 12, position: 40, align: "start" },
  { start: 30, end: 32, text: "c", line: "auto", position: 50, align: "center" }
];

/** Expected native times for a base cue under an offset: clamped at t=0, and
 *  zero-length at 0 when the whole shifted window falls before the origin
 *  (offsetCues dropped those; setOffset keeps them as never-active stubs). */
function expectedTimes(cue, offset) {
  const start = Math.max(0, cue.start + offset);
  const end = cue.end + offset <= 0 ? 0 : Math.max(0, cue.end + offset);
  return { start, end };
}

test("setOffset re-derives every cue time from the base (clamped, never drifted)", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  for (const offset of [2.5, -0.4, -3, 0, 1.75]) {
    forgeTrack.setOffset(offset);
    assert.equal(track.cues.length, BASE.length, `offset ${offset} keeps the list 1:1`);
    BASE.forEach((base, i) => {
      const expected = expectedTimes(base, offset);
      assert.equal(track.cues[i].startTime, expected.start, `offset ${offset} cue ${i} start`);
      assert.equal(track.cues[i].endTime, expected.end, `offset ${offset} cue ${i} end`);
      assert.equal(track.cues[i].text, base.text, `offset ${offset} cue ${i} text`);
    });
  }
});

test("setOffset matches the offsetCues reference for every surviving cue", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  for (const offset of [2, -0.6, -3.25]) {
    forgeTrack.setOffset(offset);
    const reference = offsetCues(BASE, offset);
    const survivors = BASE.filter((cue) => cue.end + offset > 0);
    assert.equal(reference.length, survivors.length, "reference drops only fully-past cues");
    let cursor = 0;
    BASE.forEach((base, i) => {
      if (base.end + offset <= 0) {
        // Dropped by offsetCues, kept as a zero-length never-active stub.
        assert.equal(track.cues[i].startTime, 0, "dropped cue collapses to 0");
        assert.equal(track.cues[i].endTime, 0, "dropped cue collapses to 0");
        return;
      }
      assert.equal(track.cues[i].startTime, reference[cursor].start, `offset ${offset} start`);
      assert.equal(track.cues[i].endTime, reference[cursor].end, `offset ${offset} end`);
      cursor++;
    });
    assert.equal(cursor, survivors.length);
  }
});

test("a back-and-forth drag restores the original times exactly", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  const original = track.cues.map((cue) => [cue.startTime, cue.endTime]);
  forgeTrack.setOffset(-8.75);
  forgeTrack.setOffset(4.5);
  forgeTrack.setOffset(0);
  track.cues.forEach((cue, i) => {
    assert.deepEqual([cue.startTime, cue.endTime], original[i], `cue ${i} restored`);
  });
});

test("setOffset mutates the loaded cues instead of rebuilding the list", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  const held = [...track.cues];
  forgeTrack.setOffset(-1.25);
  track.cues.forEach((cue, i) => {
    assert.equal(cue, held[i], "same cue objects survive a re-offset");
  });
  // A repeat of the current offset is a no-op: same objects, same times.
  const snapshot = track.cues.map((cue) => [cue.startTime, cue.endTime]);
  forgeTrack.setOffset(-1.25);
  assert.deepEqual(track.cues.map((cue) => [cue.startTime, cue.endTime]), snapshot);
});

test("load applies its offset in a single build pass and adopts it", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, -2.5);
  BASE.forEach((base, i) => {
    const expected = expectedTimes(base, -2.5);
    assert.equal(track.cues[i].startTime, expected.start);
    assert.equal(track.cues[i].endTime, expected.end);
  });
  // The build already applied -2.5, so an identical offset must not re-write.
  const held = [...track.cues];
  forgeTrack.setOffset(-2.5);
  track.cues.forEach((cue, i) => assert.equal(cue, held[i]));
  forgeTrack.setOffset(3);
  BASE.forEach((base, i) => {
    const expected = expectedTimes(base, 3);
    assert.equal(track.cues[i].startTime, expected.start);
    assert.equal(track.cues[i].endTime, expected.end);
  });
});

test("a cue list that diverges from the base is rebuilt rather than walked", () => {
  const { track, forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  track.removeCue(track.cues[1]);
  assert.equal(track.cues.length, BASE.length - 1);
  forgeTrack.setOffset(1.5);
  assert.equal(track.cues.length, BASE.length, "rebuild restores the 1:1 pairing");
  BASE.forEach((base, i) => {
    const expected = expectedTimes(base, 1.5);
    assert.equal(track.cues[i].startTime, expected.start);
    assert.equal(track.cues[i].endTime, expected.end);
  });
});

test("setOffset after destroy is a no-op", () => {
  const { forgeTrack } = makeTrack();
  forgeTrack.load(BASE, 0);
  forgeTrack.destroy();
  assert.doesNotThrow(() => forgeTrack.setOffset(5));
});
