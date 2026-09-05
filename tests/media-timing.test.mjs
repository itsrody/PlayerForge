import test from "node:test";
import assert from "node:assert/strict";
import {
  isMediaTimingName,
  isMediaElementEntry,
  mediaTimeline,
  NetworkThroughput
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

test("mediaTimeline stays bounded: newest sightings evict the oldest FIFO", () => {
  for (let i = 0; i < 600; i++) {
    mediaTimeline.add({ name: `https://cdn.example/seg/${i}.ts`, initiatorType: "video" });
  }
  const all = mediaTimeline.all();
  assert.equal(all.length, 500, "the store is capped at the newest 500 sightings");
  assert.equal(mediaTimeline.has("https://cdn.example/seg/0.ts"), false, "oldest sightings were evicted");
  assert.equal(mediaTimeline.has("https://cdn.example/seg/599.ts"), true, "the newest sighting survives");
});

test("NetworkThroughput smooths samples into an EWMA while the window holds the stable mean", () => {
  let now = 0;
  let estimate = 0;
  const meter = new NetworkThroughput({ windowMs: 1000, ewma: 0.5, clock: () => now, onEstimate: (v) => (estimate = v) });
  assert.equal(meter.estimateBps(), 0, "no estimate before any sample");
  now = 200;
  meter.sample(10_000, 200);
  assert.equal(meter.estimateBps(), 50_000, "the first sample seeds the EWMA");
  assert.equal(meter.windowAverageBps(), 50_000, "the window holds the only sample");
  now = 400;
  meter.sample(10_000, 200);
  assert.equal(meter.estimateBps(), 50_000, "a same-rate sample leaves the EWMA unchanged");
  assert.equal(estimate, 50_000, "onEstimate fires on the changed estimate");
  now = 600;
  meter.sample(20_000, 200);
  assert.equal(meter.estimateBps(), 75_000, "the EWMA half-steps toward the faster instant");
  now = 1500;
  meter.sample(5_000, 100);
  const afterExpiry = meter.windowAverageBps();
  assert.ok(afterExpiry > 50_000, "the expired slow samples fell out of the window mean");
});

test("NetworkThroughput ignores degenerate samples and reset clears the state", () => {
  let now = 0;
  let fired = 0;
  const meter = new NetworkThroughput({ clock: () => now, onEstimate: () => fired++ });
  meter.sample(0, 100);
  meter.sample(1000, 0);
  meter.sample(-5, 100);
  assert.equal(meter.estimateBps(), 0, "poisoned samples are ignored, never NaN the estimate");
  meter.sample(1000, 100);
  const estimate = meter.estimateBps();
  assert.equal(estimate, 10_000, "the first valid sample seeds the meter");
  meter.reset();
  assert.equal(meter.estimateBps(), 0, "reset forgets the estimate");
  assert.equal(meter.windowAverageBps(), 0, "reset empties the window");
  assert.ok(fired >= 2, "reset notifies subscribers of the zero estimate");
});