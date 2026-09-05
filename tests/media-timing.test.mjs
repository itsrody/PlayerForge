import test from "node:test";
import assert from "node:assert/strict";
import {
  isMediaTimingName,
  isMediaElementEntry,
  mediaTimeline,
  MediaTimingObserver
} from "../src/kernel/proxy/media-timing.js";

const MP4_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/token/supjav.com%40SNOS-153-UB.mp4";

const HLS_URL = "https://cdn.example/hls/master.m3u8?token=abc";

function mediaEntry(url, initiatorType = "video") {
  return { name: url, initiatorType, startTime: 12, duration: 3.2, transferSize: 2048, responseStatus: 200 };
}

class FakePerformanceObserver {
  constructor(callback) {
    this.callback = callback;
    this.options = null;
    this.disconnected = false;
  }

  observe(options) {
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  fire(entries) {
    this.callback({ getEntries: () => entries });
  }
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

test("MediaTimingObserver relays only media-shaped resource entries", () => {
  const seen = [];
  let fake;
  const observer = new MediaTimingObserver((entry) => seen.push(entry), {
    PerformanceObserverClass: function (callback) {
      fake = new FakePerformanceObserver(callback);
      return fake;
    }
  });
  observer.observe();
  observer.disconnect();
  assert.deepEqual(fake.options, { type: "resource", buffered: false }, "live push observer, no buffered replay");
  assert.equal(fake.disconnected, true, "disconnect tears the relay down");

  fake.fire([
    mediaEntry(MP4_URL),
    mediaEntry(HLS_URL, "audio"),
    { name: "https://x/app.js", initiatorType: "script" },
    { name: "https://x/api", initiatorType: "fetch" }
  ]);
  assert.equal(seen.length, 2, "only the two media entries were relayed");
  assert.equal(seen[0].name, MP4_URL);
  assert.equal(seen[1].name, HLS_URL);
});

test("MediaTimingObserver throws on invalid seams", () => {
  assert.throws(
    () => new MediaTimingObserver(null, { PerformanceObserverClass: FakePerformanceObserver }),
    /callback/,
    "a callback is required"
  );
  assert.throws(
    () => new MediaTimingObserver(() => {}, { PerformanceObserverClass: null }),
    /PerformanceObserverClass/,
    "an observer class is required"
  );
});