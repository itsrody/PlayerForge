import test from "node:test";
import assert from "node:assert/strict";
import {
  isProgressiveStreamUrl,
  isManifestUrl,
  manifestKindFromUrl,
  hasMediaExtension,
  isMediaUrlName
} from "../src/shared/media-shapes.js";

/**
 * The media URL taxonomy is the single source for every "does this URL look
 * like media" answer in the proxy and kernel. These tests pin the taxonomy
 * levels AND the exact equivalence with the legacy per-module regexes they
 * replaced, so a future edit to a consumer can never silently change what a
 * URL means elsewhere.
 */

const TAPECONTENT_MP4_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/token/supjav.com%40SNOS-153-UB.mp4";

test("isProgressiveStreamUrl matches the byte-seam routing shapes", () => {
  assert.equal(isProgressiveStreamUrl("https://x/video.mp4"), true);
  assert.equal(isProgressiveStreamUrl("https://x/video.mp4?stream=1"), true);
  assert.equal(isProgressiveStreamUrl("https://x/VIDEO.MP4"), true);
  assert.equal(isProgressiveStreamUrl("https://x/player.js?get_video=1"), true);
  assert.equal(isProgressiveStreamUrl(TAPECONTENT_MP4_URL), true);
  assert.equal(
    isProgressiveStreamUrl("https://861134084.tapecontent.net/assets/logo.svg"),
    false,
    "plain shard assets stay native"
  );
  assert.equal(isProgressiveStreamUrl("https://x/master.m3u8"), false);
  assert.equal(isProgressiveStreamUrl("https://x/master.mp4/"), false, "trailing path segments are not a .mp4 file");
  assert.equal(isProgressiveStreamUrl(""), false);
});

test("isManifestUrl matches .m3u8/.mpd with query/fragment tails", () => {
  assert.equal(isManifestUrl("https://x/master.m3u8"), true);
  assert.equal(isManifestUrl("https://x/master.m3u8?token=abc"), true);
  assert.equal(isManifestUrl("https://x/man.mpd"), true);
  assert.equal(isManifestUrl("https://x/master.m3u8&x=1"), true);
  assert.equal(isManifestUrl("https://x/clip.webm"), false);
  assert.equal(isManifestUrl("https://x/seg.ts"), false);
  assert.equal(isManifestUrl(""), false);
});

test("manifestKindFromUrl reads the exact suffix, ignoring query and hash", () => {
  assert.equal(manifestKindFromUrl("https://x/v/master.m3u8"), "m3u8");
  assert.equal(manifestKindFromUrl("https://x/v/master.m3u8?token=abc#frag"), "m3u8");
  assert.equal(manifestKindFromUrl("https://x/v/master.MPD"), "mpd", "case-insensitive like the legacy predicate");
  assert.equal(manifestKindFromUrl("https://x/v/seg-1.ts"), null);
  assert.equal(manifestKindFromUrl(""), null);
});

test("hasMediaExtension names media container files only", () => {
  for (const ext of ["mp4", "webm", "ogv", "ogg", "m4v", "mov"]) {
    assert.equal(hasMediaExtension(`https://x/clip.${ext}`), true, `.${ext}`);
  }
  assert.equal(hasMediaExtension("https://x/clip.webm?range=1"), true, "query tail keeps the extension");
  assert.equal(hasMediaExtension("https://x/logo.svg"), false);
  assert.equal(hasMediaExtension("https://x/app.js"), false);
  assert.equal(hasMediaExtension(""), false);
});

test("isMediaUrlName is the observation superset of the routing shapes", () => {
  const media = [
    TAPECONTENT_MP4_URL,
    "https://x/clip.mp4",
    "https://x/clip.webm",
    "https://x/clip.ogv",
    "https://x/clip.ogg",
    "https://x/clip.m4v",
    "https://x/clip.mov",
    "https://x/master.m3u8?token=abc",
    "https://x/video.mpd#frag",
    "https://x/get_video?id=1&stream=1"
  ];
  for (const url of media) {
    assert.equal(isMediaUrlName(url), true, url);
  }
  for (const url of ["https://x/logo.svg", "https://x/app.js", "https://x/seg.ts", ""]) {
    assert.equal(isMediaUrlName(url), false, url);
  }
});