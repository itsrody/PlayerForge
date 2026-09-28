import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, srtToVtt, ensureVttHeader } from "../src/shell/subtitles/forgevtt.js";

// Cue parsing itself is Firefox's native WebVTT implementation (a blob
// <track> src in ForgeTrack.loadText); forgevtt.js now only normalizes
// source documents into strict VTT at the ingest boundary.

test("normalizeText strips BOM and unifies newlines", () => {
  assert.equal(normalizeText("\uFEFFa\r\nb\rc"), "a\nb\nc");
});

test("normalizeText composes to NFC so accents match regardless of source encoding", () => {
  assert.equal(normalizeText("e\u0301"), "\u00E9");
});

test("ensureVttHeader adds the magic only when missing", () => {
  assert.ok(ensureVttHeader("plain text").startsWith("WEBVTT"));
  assert.equal(ensureVttHeader("WEBVTT already fine"), "WEBVTT already fine");
});

test("ensureVttHeader normalizes BOM and CRLF on the way through", () => {
  const out = ensureVttHeader("\uFEFF00:00:01.000 --> 00:00:02.000\r\nline");
  assert.ok(out.startsWith("WEBVTT\n"));
  assert.ok(!out.includes("\r"));
  assert.ok(!out.includes("\uFEFF"));
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
  assert.ok(vtt.includes("00:00:03.000 --> 00:00:04.000"));
  assert.ok(vtt.includes("--\\>"));
  assert.doesNotMatch(vtt, /\d,\d{3} -->/);
});

test("srtToVtt leaves cue payload lines untouched (the native parser decodes them)", () => {
  const srt = "1\r\n00:00:00,000 --> 00:00:01,000\r\nA&nbsp;B <b>kept</b>";
  const vtt = srtToVtt(srt);
  assert.ok(vtt.includes("A&nbsp;B <b>kept</b>"));
});
