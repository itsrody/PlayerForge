import test from "node:test";
import assert from "node:assert/strict";
import { findActiveCues } from "../src/shell/subtitles/active-cues.js";

function cue(start, end) {
  return { start, end, text: `${start}-${end}` };
}

test("returns the single active cue", () => {
  const cues = [cue(0, 10), cue(10, 20), cue(20, 30)];
  const out = findActiveCues(cues, 15, []);
  assert.deepEqual(out, [cues[1]]);
});

test("stacked cues come back in track order without reverse", () => {
  const cues = [cue(0, 30), cue(10, 40), cue(20, 50), cue(50, 60)];
  const out = findActiveCues(cues, 25, []);
  assert.deepEqual(out.map((c) => c.start), [0, 10, 20]);
});

test("no actives yields empty buffer", () => {
  const cues = [cue(0, 5), cue(10, 20)];
  const out = findActiveCues(cues, 7, []);
  assert.equal(out.length, 0);
});

test("cue ending exactly at time is inactive (end exclusive)", () => {
  const cues = [cue(0, 10)];
  assert.equal(findActiveCues(cues, 10, []).length, 0);
  assert.equal(findActiveCues(cues, 9.999, []).length, 1);
});

test("empty track yields empty output", () => {
  assert.equal(findActiveCues([], 5, []).length, 0);
});

test("reused buffer is cleared per call", () => {
  const buf = [];
  const cues = [cue(0, 10)];
  findActiveCues(cues, 5, buf);
  assert.equal(buf.length, 1);
  findActiveCues(cues, 15, buf);
  assert.equal(buf.length, 0);
});

test("long-lived far-left cue stays active on malformed nesting (legacy parity)", () => {
  // Legacy filtered ALL prior cues, so a cue outliving later ones is kept.
  const cues = [cue(0, 100), cue(10, 12), cue(20, 50)];
  const out = findActiveCues(cues, 60, []);
  assert.deepEqual(out, [cues[0]]);
});
