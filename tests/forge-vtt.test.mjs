import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  srtToVtt,
  ensureVttHeader,
  timecodeToSeconds,
  parseSubtitles,
  sortCues
} from "../src/shell/subtitles/forgevtt.js";

test("timecodeToSeconds treats the ms field as an integer millisecond count", () => {
  assert.equal(timecodeToSeconds("00:00:05,5"), 5.005);
  assert.equal(timecodeToSeconds("00:00:05,50"), 5.05);
  assert.equal(timecodeToSeconds("00:00:05,500"), 5.5);
});

test("timecodeToSeconds handles hourless and full forms", () => {
  assert.equal(timecodeToSeconds("01:02.500"), 62.5);
  assert.equal(timecodeToSeconds("12:34,000"), 754);
  assert.equal(timecodeToSeconds("01:02:03.456"), 3723.456);
});

test("timecodeToSeconds rejects garbage", () => {
  assert.equal(timecodeToSeconds("banana"), null);
  assert.equal(timecodeToSeconds("12:34.5678"), null);
  assert.equal(timecodeToSeconds(""), null);
});

test("parseSubtitles skips NOTE blocks even with timing-like lines", () => {
  const vtt = [
    "WEBVTT",
    "",
    "NOTE this comment quotes a timing",
    "00:59:00.000 --> 00:59:05.000",
    "which must not become a cue",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "real line"
  ].join("\n");
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "real line");
});

test("parseSubtitles skips STYLE and REGION blocks", () => {
  const vtt = [
    "WEBVTT",
    "",
    "STYLE",
    "::cue { color: red }",
    "",
    "REGION id=fred width=50%",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "hello"
  ].join("\n");
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "hello");
});

test("timing-looking payload lines stay cue text (one timing per block)", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "quoted:",
    "00:00:01.500 --> 00:00:02.000",
    "not a separate cue"
  ].join("\n");
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 1);
  assert.match(cues[0].text, /00:00:01\.500/);
  assert.match(cues[0].text, /not a separate cue/);
});

test("inverted or zero-length cue times are rejected", () => {
  assert.deepEqual(parseSubtitles("WEBVTT\n\n10:00 --> 09:00\nbad"), []);
  assert.deepEqual(parseSubtitles("WEBVTT\n\n00:05.000 --> 00:05.000\nequal"), []);
});

test("offset drops fully shifted-out cues and clamps partial ones", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "corpse",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "clamped",
    "",
    "00:00:08.000 --> 00:00:09.000",
    "intact"
  ].join("\n");
  const cues = parseSubtitles(vtt, -3);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1);
  assert.equal(cues[1].start, 5);
});

test("named entities decode", () => {
  const cues = parseSubtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA&nbsp;B &amp; C &lt;x&gt;");
  assert.equal(cues[0].text, "A\xA0B & C <x>");
});

test("numeric and hex entities decode", () => {
  const cues = parseSubtitles(
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&#72;&#101;llo &#x41;",
    0
  );
  assert.equal(cues[0].text, "Hello A");
});

test("out-of-range numeric entities become replacement chars", () => {
  const cued = parseSubtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nx&#99999999;y");
  assert.equal(cued[0].text, "x\uFFFDy");
});

test("lone surrogate entities degrade to replacement chars without throwing", () => {
  const cues = parseSubtitles(
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na&#55296;b&#xD800;c"
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "a\uFFFDb\uFFFDc");
});

test("markup tags are stripped but entity-encoded tags stay literal", () => {
  const cues = parseSubtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<i>bold</i> &lt;b&gt;kept&lt;/b&gt;");
  assert.equal(cues[0].text, "bold <b>kept</b>");
});

test("BOM and CRLF are normalized end to end", () => {
  const raw = "\uFEFFWEBVTT\r\n\r\n00:00:01,000 --> 00:00:02,000\r\nline one";
  const cues = parseSubtitles(raw);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].text, "line one");
});

test("cue settings line/position/align are parsed", () => {
  const cues = parseSubtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000 line:10% position:25% align:start\ntext");
  assert.equal(cues[0].line, 10);
  assert.equal(cues[0].position, 25);
  assert.equal(cues[0].align, "start");
});

test("empty and headerless documents yield no cues without throwing", () => {
  assert.deepEqual(parseSubtitles(""), []);
  assert.deepEqual(parseSubtitles("just some words"), []);
  assert.deepEqual(parseSubtitles("WEBVTT"), []);
});

test("srtToVtt strips indices, converts separators, pads ms, escapes stray arrows", () => {
  const srt = [
    "1",
    "00:00:01,500 --> 00:00:02,50",
    "first --> arrow",
    "",
    "2",
    "00:00:03,000 --> 00:00:04,000",
    "second"
  ].join("\r\n");
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.doesNotMatch(vtt, /^1$/m);
  assert.ok(vtt.includes("00:00:01.500 --> 00:00:02.050"));
  assert.ok(vtt.includes("--\\>"));
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 2.05);
  assert.equal(cues[0].text, "first --\\> arrow");
});

test("ensureVttHeader adds the magic only when missing", () => {
  assert.ok(ensureVttHeader("plain text").startsWith("WEBVTT"));
  assert.equal(ensureVttHeader("WEBVTT already fine"), "WEBVTT already fine");
});

test("normalizeText strips BOM and unifies newlines", () => {
  assert.equal(normalizeText("\uFEFFa\r\nb\rc"), "a\nb\nc");
});

test("sortCues orders by start and returns the array", () => {
  const cues = [{ start: 5 }, { start: 1 }];
  assert.deepEqual(sortCues(cues).map((c) => c.start), [1, 5]);
});
