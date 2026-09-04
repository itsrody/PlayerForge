import test from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  parseHls,
  parseDash,
  resolveTemplate,
  normalizeByteRange
} from "../src/shell/proxy/manifest-segments.js";

test("normalizeByteRange handles start-end, length@offset, and length-with-hint", () => {
  assert.deepEqual(normalizeByteRange("720-1439"), { start: 720, end: 1439 });
  assert.deepEqual(normalizeByteRange("720@0"), { start: 0, end: 719 });
  assert.deepEqual(normalizeByteRange("720", { startHint: 720 }), { start: 720, end: 1439 });
  assert.equal(normalizeByteRange("720"), null, "length without an offset hint is unresolvable");
  assert.equal(normalizeByteRange(""), null);
  assert.equal(normalizeByteRange(null), null);
});

test("resolveTemplate fills $Number$, padded $Number%05d$, RepresentationID, Bandwidth", () => {
  assert.equal(resolveTemplate("seg-$Number$.m4s", 7), "seg-7.m4s");
  assert.equal(resolveTemplate("seg-$Number%05d$.m4s", 7), "seg-00007.m4s");
  assert.equal(resolveTemplate("$RepresentationID$/$Bandwidth$/init.mp4", 1, { representationId: "v1", bandwidth: 4500 }), "v1/4500/init.mp4");
  assert.equal(resolveTemplate("no-placeholder.mp4", 3), "no-placeholder.mp4");
});

test("HLS: fragments, media sequence, and byte ranges parse from a CMAF playlist", () => {
  const hls = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:1024",
    "#EXT-X-MAP:URI=\"main.mp4\",BYTERANGE=\"720@0\"",
    "#EXTINF:4.0,",
    "#EXT-X-BYTERANGE:720@720",
    "https://cdn.example/v/main.mp4",
    "#EXTINF:4.0,",
    "#EXT-X-BYTERANGE:720@1440",
    "https://cdn.example/v/main.mp4",
    "#EXT-X-ENDLIST"
  ].join("\n");

  const plan = parseHls(hls, { baseUrl: "https://cdn.example/v/playlist.m3u8" });
  assert.equal(plan.kind, "m3u8");
  assert.equal(plan.sequence, 1024);
  assert.equal(plan.lanes.length, 1);
  const lane = plan.lanes[0];
  assert.equal(lane.maps.length, 1);
  assert.deepEqual(lane.maps[0], { uri: "https://cdn.example/v/main.mp4", byteRange: { start: 0, end: 719 } });
  assert.equal(lane.segments.length, 2);
  assert.deepEqual(lane.segments[0].byteRange, { start: 720, end: 1439 });
  assert.deepEqual(lane.segments[1].byteRange, { start: 1440, end: 2159 });
  assert.equal(lane.segments[0].id, 1024);
  assert.equal(lane.segments[1].id, 1025);
  assert.equal(lane.segments[0].map, 0, "every mapped segment references the map index");
  assert.equal(lane.segments[0].duration, 4);
});

test("HLS: EXT-X-KEY rides along and encrypts the segments that follow it", () => {
  const hls = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/enc.key\",IV=0x0000000000000000000000000000AB",
    "#EXTINF:4.0,",
    "seg-1.m4s",
    "#EXT-X-KEY:METHOD=NONE",
    "#EXTINF:4.0,",
    "seg-2.m4s"
  ].join("\n");

  const plan = parseHls(hls, { baseUrl: "https://cdn.example/v/playlist.m3u8" });
  const [s1, s2] = plan.lanes[0].segments;
  assert.equal(s1.encrypted, true);
  assert.equal(s1.key.method, "AES-128");
  assert.equal(s1.key.uri, "https://cdn.example/v/keys/enc.key");
  assert.equal(s1.key.iv, "0x0000000000000000000000000000AB");
  assert.equal(s2.encrypted, false, "METHOD=NONE clears encryption for later fragments");
  assert.equal(s2.key.method, "NONE");
});

test("parseManifest resolves kind from URL, then content, and delegates", () => {
  const hls = parseManifest("#EXTM3U\n#EXTINF:4.0,\na.m4s", { baseUrl: "https://x/live.mpd" });
  assert.equal(hls.kind, "mpd", "URL suffix wins over content sniff");
  const urlImpliedM3u8 = parseManifest("#EXTM3U\n#EXTINF:4.0,\na.m4s", { baseUrl: "https://x/live.m3u8" });
  assert.equal(urlImpliedM3u8.kind, "m3u8");
});

test("DASH: SegmentTemplate with timeline expands numbered fragments + init", () => {
  const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1.5S">
  <BaseURL>https://cdn.example/v/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
      <Representation id="v0" bandwidth="4500000">
        <SegmentTemplate timescale="1000" duration="4000"
          initialization="init-$RepresentationID$.mp4"
          media="seg-$Number%05d$.m4s">
          <SegmentTimeline>
            <S d="4000"/>
            <S d="4000" r="1"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const plan = parseDash(mpd, { baseUrl: "https://cdn.example/v/manifest.mpd" });
  assert.equal(plan.kind, "mpd");
  assert.equal(plan.lanes.length, 1);
  const lane = plan.lanes[0];
  assert.equal(lane.mimeType, "video/mp4");
  assert.equal(lane.codecs, "avc1.4d401f");
  assert.equal(lane.id, "v0");
  assert.deepEqual(lane.init, { uri: "https://cdn.example/v/init-v0.mp4", byteRange: null });
  assert.equal(lane.segments.length, 3, "S d=4000 (1) + r=1 (2)");
  assert.equal(lane.segments[0].uri, "https://cdn.example/v/seg-00001.m4s");
  assert.equal(lane.segments[1].uri, "https://cdn.example/v/seg-00002.m4s");
  assert.equal(lane.segments[2].uri, "https://cdn.example/v/seg-00003.m4s");
  assert.equal(lane.segments[0].duration, 4);
});

test("DASH: SegmentList with Initialization element yields ranges per segment", () => {
  const mpd = `<MPD>
  <Period>
    <BaseURL>https://cdn.example/v/</BaseURL>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2">
      <Representation id="a0" bandwidth="128000">
        <SegmentList timescale="1000" duration="48000">
          <Initialization sourceURL="audio/init.mp4" range="0-719"/>
          <SegmentURL media="audio/file.mp4" mediaRange="720-1199"/>
          <SegmentURL media="audio/file.mp4" mediaRange="1200-1679"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const plan = parseDash(mpd, { baseUrl: "https://cdn.example/v/manifest.mpd" });
  const lane = plan.lanes[0];
  assert.equal(lane.mimeType, "audio/mp4");
  assert.deepEqual(lane.init, { uri: "https://cdn.example/v/audio/init.mp4", byteRange: { start: 0, end: 719 } });
  assert.equal(lane.segments.length, 2);
  assert.deepEqual(lane.segments[0].byteRange, { start: 720, end: 1199 });
  assert.deepEqual(lane.segments[1].byteRange, { start: 1200, end: 1679 });
  assert.equal(lane.segments[1].uri, "https://cdn.example/v/audio/file.mp4");
});

test("DASH: unbounded SegmentTemplate emits a template for on-demand expansion", () => {
  const mpd = `<MPD>
  <Period>
    <BaseURL>https://cdn.example/v/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="live">
        <SegmentTemplate timescale="1000" duration="2000" startNumber="900"
          initialization="init.mp4" media="ch-$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const plan = parseDash(mpd, { baseUrl: "https://cdn.example/v/manifest.mpd" });
  const lane = plan.lanes[0];
  assert.deepEqual(lane.init, { uri: "https://cdn.example/v/init.mp4", byteRange: null });
  assert.equal(lane.segments.length, 0);
  assert.ok(lane.template, "unbounded template carried for the flow to expand");
  assert.equal(lane.template.number, 900);
  assert.equal(resolveTemplate(lane.template.uriTemplate, lane.template.number), "https://cdn.example/v/ch-900.m4s");
});

test("DASH: SegmentBase yields a whole-file lane with init from initialization attr", () => {
  const mpd = `<MPD>
  <Period>
    <BaseURL>https://cdn.example/v/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="vbase">
        <SegmentBase indexRange="0-999" initialization="whole.mp4#0-999"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const plan = parseDash(mpd, { baseUrl: "https://cdn.example/v/manifest.mpd" });
  const lane = plan.lanes[0];
  assert.deepEqual(lane.init, { uri: "https://cdn.example/v/whole.mp4", byteRange: { start: 0, end: 999 } });
  assert.equal(lane.segments.length, 1);
  assert.equal(lane.segments[0].uri, "https://cdn.example/v/");
});