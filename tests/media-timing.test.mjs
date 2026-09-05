import test from "node:test";
import assert from "node:assert/strict";
import {
  isMediaTimingName,
  isMediaElementEntry,
  mediaTimeline
} from "../src/kernel/proxy/media-timing.js";

const MP4_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/token/supjav.com%40SNOS-153-UB.mp4";

const HLS_URL = "https://cdn.example/hls/master.m3u8?token=abc";

function mediaEntry(url, initiatorType = "video") {
  return { name: url, initiatorType, startTime: 12, duration: 3.2, transferSize: 2048, responseStatus: 200 };
}

test("media URL names are recognized per the routing shapes", () => {
  assert.ok(isMediaTimingName(MP4_URL), "presigned .mp4 path counts");
  assert.ok(isMediaTimingName("https://x/get_video?id=1&stream=1"), "get_video/stream=1 endpoint counts");
  assert.ok(isMediaTimingName(HLS_URL), "HLS manifest URL counts");
  assert.ok(isMediaTimingName("https://x/video.mpd?token=y"), "DASH manifest URL counts");
  assert.ok(isMediaTimingName("https://x/clip.webm"), "webm counts");
  assert.ok(!isMediaTimingName("https://x/logo.svg"), "plain asset does not count");
  assert.ok(!isMediaTimingName("https://x/style.css"), "stylesheet does not count");
  assert.ok(!isMediaTimingName(""), "empty name never counts");
});

test("element entries are recognized by initiatorType video/audio or media URL name", () => {
  assert.ok(isMediaElementEntry(mediaEntry(MP4_URL)), "video initiator + media URL is a media entry");
  assert.ok(isMediaElementEntry({ initiatorType: "audio", name: HLS_URL }), "audio initiator counts");
  assert.ok(isMediaElementEntry({ initiatorType: "script", name: MP4_URL }), "media URL name still counts");
  assert.ok(!isMediaElementEntry({ initiatorType: "script", name: "https://x/app.js" }), "plain script is not media");
  assert.ok(!isMediaElementEntry({ initiatorType: "fetch", name: "https://cdn.example/api" }), "api fetch is not media");
  assert.ok(!isMediaElementEntry({ name: "https://cdn.example/api" }), "no initiatorType + plain URL is not media");
});

test("the timeline collector keeps url-keyed media observations", () => {
  const before = mediaTimeline.all().length;
  mediaTimeline.add(mediaEntry(MP4_URL));
  mediaTimeline.add({ name: HLS_URL, initiatorType: "audio", responseStatus: 200 });
  const after = mediaTimeline.all().length;
  assert.equal(after - before, 2, "two distinct names were added");
  assert.ok(mediaTimeline.has(MP4_URL), "the mp4 url is on the timeline");
  assert.ok(mediaTimeline.has(HLS_URL), "the hls url is on the timeline");
  assert.equal(mediaTimeline.get(MP4_URL).initiatorType, "video");

  mediaTimeline.add(mediaEntry(MP4_URL));
  const afterDedupe = mediaTimeline.all().length;
  assert.equal(afterDedupe - after, 0, "re-adding an existing name does not double up");
  mediaTimeline.add({ name: "", initiatorType: "video" });
  const afterBlank = mediaTimeline.all().length;
  assert.equal(afterBlank, afterDedupe, "blank names are ignored");
});