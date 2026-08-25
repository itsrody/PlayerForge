import { measure } from "../lib.mjs";
import { formatTime } from "../../src/shared/time.js";
import { timecodeToSeconds, parseSubtitles } from "../../src/shell/subtitles/forgevtt.js";

/** Build a realistic ~500-cue VTT document once per process. */
function buildVtt(cueCount) {
  const lines = ["WEBVTT", ""];
  for (let i = 0; i < cueCount; i++) {
    const s = (i * 4.2) % 3600;
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
    const ss = String(Math.floor(s % 60)).padStart(2, "0");
    const ms = String((i * 37) % 1000).padStart(3, "0");
    lines.push(`${hh}:${mm}:${ss}.${ms} --> ${hh}:${mm}:${ss}.${String((+ms + 800) % 1000).padStart(3, "0")}`);
    lines.push(`<i>Cue ${i}</i> dialogue line with some text &amp; an entity`);
    lines.push("");
  }
  return lines.join("\n");
}

const VTT_500 = buildVtt(500);
const timecodes = ["00:01:02.345", "01:22:33.001", "00:00:07.500"];

export default [
  measure("timecodeToSeconds cue lines", () => {
    let sink = 0;
    return () => {
      for (let i = 0; i < 500; i++) {
        sink += timecodeToSeconds(timecodes[i % 3]);
      }
      if (sink === Infinity) throw new Error();
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
  }),

  measure("parseSubtitles 500-cue VTT", () => {
    return () => parseSubtitles(VTT_500);
  })
];
