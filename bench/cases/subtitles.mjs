import { measure } from "../lib.mjs";
import { formatTime } from "../../src/shared/time.js";
import { srtToVtt } from "../../src/shell/subtitles/forgevtt.js";

// Cue parsing and re-offsetting are Firefox's native WebVTT/TextTrack
// backend now (blob <track> parse + remove/re-add rebuild), so the only
// remaining forgevtt work is the SRT/VTT normalizer at ingest - measured
// here on a realistic multi-cue SRT.

const SRT = [
  "1",
  "00:00:01,500 --> 00:00:02,500",
  "first line with &amp; an entity",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,250",
  "second line --> with an arrow",
  "",
  "3",
  "00:00:05,000 --> 00:00:06,750",
  "third line"
].join("\r\n");

export default [
  measure("srtToVtt normalizes a small SRT", () => {
    let sink = null;
    return () => {
      sink = srtToVtt(SRT);
      if (!sink.startsWith("WEBVTT")) throw new Error();
    };
  }),

  measure("formatTime scrub ticks", () => {
    let sink = "";
    return () => {
      for (let i = 0; i < 300; i++) {
        sink = formatTime((i * 7) % 7200 + 0.25);
      }
      if (sink === undefined) throw new Error();
    };
  })
];
