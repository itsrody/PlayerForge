import { measure } from "../lib.mjs";
import { findActiveCues } from "../../src/shell/subtitles/active-cues.js";

/** 500-cue track, 4s cues with 200ms gaps, sorted by start. */
function buildCues(n = 500) {
  const cues = [];
  for (let i = 0; i < n; i++) {
    const start = i * 4.2;
    cues.push({ start, end: start + 4 });
  }
  return cues;
}

const CUES = buildCues();

/** The pre-trim implementation - allocation + reverse per tick. */
function legacyFindActiveCues(cues, time) {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = low + high >> 1;
    if (cues[mid].start <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const active = [];
  for (let i = low - 1; i >= 0; i--) {
    if (cues[i].end > time) {
      active.push(cues[i]);
    }
  }
  active.reverse();
  return active;
}

const buffer = [];

export default [
  measure("activeCues legacy (alloc+reverse per tick)", () => {
    let sink;
    return () => {
      for (let i = 0; i < 1000; i++) {
        sink = legacyFindActiveCues(CUES, (i * 4.2) % 2000);
      }
      if (!Array.isArray(sink)) throw new Error();
    };
  }),

  measure("activeCues shared buffer (no alloc)", () => {
    return () => {
      for (let i = 0; i < 1000; i++) {
        findActiveCues(CUES, (i * 4.2) % 2000, buffer);
      }
    };
  })
];
