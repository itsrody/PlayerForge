import test from "node:test";
import assert from "node:assert/strict";
import { attachTakeover, laneMime } from "../src/shell/proxy/take-over.js";

const SEG0 = new Uint8Array([0, 0, 0, 28, 0x6d, 0x6f, 0x6f, 0x76]);
const SEG1 = new Uint8Array([0, 0, 0, 24, 0x6d, 0x6f, 0x6f, 0x6e]);
const INIT = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);

function fakeMseSeams() {
  class FakeSourceBuffer {
    constructor(mimeType) {
      this.mimeType = mimeType;
      this.updating = false;
      this.appends = [];
      this.appendWindowStart = 0;
      this.appendWindowEnd = Infinity;
      this.settled = [];
    }
    appendBuffer(bytes) {
      this.appends.push(bytes);
    }
    abort() {}
    addEventListener(type, fn) {}
  }
  class FakeMediaSource {
    constructor() {
      this.readyState = "open";
      this.listeners = {};
      this.sourceBuffersSafe = [];
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] ?? []) fn();
    }
    addSourceBuffer(mimeType) {
      const sb = new FakeSourceBuffer(mimeType);
      this.sourceBuffersSafe.push(sb);
      return sb;
    }
    endOfStream() {}
  }
  let urlCounter = 0;
  const mediaSources = [];
  return {
    mediaSource: FakeMediaSource,
    createObjectURL: (ms) => {
      mediaSources.push(ms);
      return `blob:fake-${++urlCounter}`;
    },
    revokeObjectURL: () => {},
    isTypeSupported: () => true,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    fire() {
      mediaSources.forEach((ms) => ms.fire("sourceopen"));
    },
    mediaSources
  };
}

function makeVideo(overrides = {}) {
  const listeners = {};
  const video = {
    currentSrc: "",
    src: "",
    readyState: 0,
    setMediaKeys: async () => {},
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    fireEncrypted(initData) {
      video.readyState = 0;
      for (const fn of listeners.encrypted ?? []) fn({ initData, initDataType: "cenc" });
    },
    listeners,
    ...overrides
  };
  return video;
}

function makeProvider(map) {
  const fetches = [];
  return {
    fetches,
    async fetch(uri, { signal, byteRange } = {}) {
      fetches.push({ uri, byteRange });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const hit = map.get(uri);
      if (!hit) return { via: "fetch", resp: { status: 404, headers: {}, body: new Uint8Array(0) } };
      return { via: "fetch", resp: { status: 200, headers: {}, body: hit } };
    }
  };
}

const HLS_FMP4 = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-MEDIA-SEQUENCE:100",
  '#EXT-X-MAP:URI="init.mp4",BYTERANGE="120-179"',
  "#EXTINF:6.0,",
  "seg-100.m4s",
  "#EXTINF:6.0,",
  "seg-101.m4s",
  "#EXT-X-ENDLIST"
].join("\n");

const HLS_TS = [
  "#EXTM3U",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXTINF:6.0,",
  "seg-0.ts",
  "#EXTINF:6.0,",
  "seg-1.ts",
  "#EXT-X-ENDLIST"
].join("\n");

const HLS_AES128_FMP4 = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="k.key"',
  "#EXT-X-MEDIA-SEQUENCE:0",
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:6.0,",
  "seg-0.m4s",
  "#EXTINF:6.0,",
  "seg-1.m4s",
  "#EXT-X-ENDLIST"
].join("\n");

const DASH_FMP4 = [
  '<?xml version="1.0"?>',
  "<MPD>",
  '<Period><AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">',
  '<Representation id="v1" bandwidth="100000">',
  '<SegmentBase indexRange="100-199"><Initialization range="0-99" sourceURL="init.mp4"/></SegmentBase>',
  "</Representation>",
  "</AdaptationSet></Period>",
  "</MPD>"
].join("");

function planFor(claim) {
  return attachTakeover({
    video: makeVideo(),
    claim,
    provider: makeProvider(new Map()),
    mse: fakeMseSeams(),
    checkBusy: () => false
  });
}

test("laneMime keeps DASH mime+codecs and defaults HLS fMP4 lanes to video/mp4", () => {
  assert.equal(laneMime({ mimeType: "video/mp4", codecs: "avc1.4d401f" }), 'video/mp4; codecs="avc1.4d401f"');
  assert.equal(laneMime({ mimeType: null, codecs: null }), "video/mp4");
  assert.equal(laneMime({ mimeType: "audio/mp4", codecs: "mp4a.40.2" }), 'audio/mp4; codecs="mp4a.40.2"');
});

test("attaches an HLS fMP4 takeover: init before media, in-order, lanes progress to DONE", async () => {
  const provider = makeProvider(new Map([["https://cdn.example/init.mp4", INIT], ["https://cdn.example/seg-100.m4s", SEG0], ["https://cdn.example/seg-101.m4s", SEG1]]));
  const seams = fakeMseSeams();
  const video = makeVideo();
  const result = await attachTakeover({
    video,
    claim: { manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "plain", text: HLS_FMP4 },
    provider,
    mse: seams,
    checkBusy: () => false
  });
  assert.ok(result.taken, "the fMP4 claim arms");
  await result.managers[0].waitDrain();
  assert.equal(result.managers.length, 1);
  assert.equal(provider.fetches.some((f) => f.uri === "https://cdn.example/init.mp4" && f.byteRange && f.byteRange.start === 120), true, "the init byte range rides the wire");
  const sb = seams.mediaSources[0].sourceBuffersSafe[0];
  assert.equal(sb.appends[0], INIT, "the init segment lands before any media");
  assert.ok(sb.appends.slice(1).includes(SEG0), "the first media fragment follows");
  assert.ok(sb.appends.includes(SEG1), "the whole concrete list appends");
  assert.equal(sb.mimeType, "video/mp4");
  assert.equal(result.sink.objectURL, video.src, "the element plays the plane's object URL");
  assert.equal(result.managers[0].statusOf(100), "DONE");
  assert.equal(result.managers[0].statusOf(101), "DONE");
  await result.detach();
});

test("attaches a DASH SegmentBase takeover with a single concrete whole-file lane", async () => {
  const provider = makeProvider(new Map([["https://cdn.example/init.mp4", INIT], ["https://cdn.example/master.mpd", SEG0]]));
  const seams = fakeMseSeams();
  const result = await attachTakeover({
    video: makeVideo(),
    claim: { manifestUrl: "https://cdn.example/master.mpd", kind: "mpd", klass: "plain", text: DASH_FMP4 },
    provider,
    mse: seams,
    checkBusy: () => false
  });
  assert.ok(result.taken, "the DASH claim arms");
  await result.managers[0].waitDrain();
  const sb = seams.mediaSources[0].sourceBuffersSafe[0];
  assert.equal(sb.mimeType, 'video/mp4; codecs="avc1.4d401f"', "DASH codecs ride the lane");
  assert.equal(sb.appends[0], INIT, "the SegmentBase init precedes the media");
  await result.detach();
});

test("declines a busy video (page player committed bytes) without touching it", async () => {
  const provider = makeProvider(new Map());
  const video = makeVideo({ readyState: 2, currentSrc: "https://cdn.example/seg-0.ts" });
  const result = await attachTakeover({
    video,
    claim: { manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "plain", text: HLS_FMP4 },
    provider,
    mse: fakeMseSeams()
  });
  assert.equal(result.taken, false);
  assert.equal(result.reason, "busy");
  assert.equal(video.src, "", "nothing was written to the element");
});

test("declines a raw TS lane (no init) and a mixed plan leaving the page player in charge", async () => {
  const ts = await planFor({ manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "plain", text: HLS_TS });
  assert.equal(ts.taken, false);
  assert.equal(ts.reason, "media-lane-unsupported");
});

test("declines an AES-128 fMP4 plan when no decrypt seam exists", async () => {
  const result = await planFor({
    manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "aes128", text: HLS_AES128_FMP4
  });
  assert.equal(result.taken, false);
  assert.equal(result.reason, "no-decrypt");
});

test("routes AES-128 through the decrypt seam with the key URI and sequence IV", async () => {
  const calls = [];
  const provider = makeProvider(new Map([
    ["https://cdn.example/init.mp4", INIT],
    ["https://cdn.example/seg-0.m4s", SEG0],
    ["https://cdn.example/seg-1.m4s", SEG1]
  ]));
  const seams = fakeMseSeams();
  const result = await attachTakeover({
    video: makeVideo(),
    claim: { manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "aes128", text: HLS_AES128_FMP4 },
    provider,
    mse: seams,
    decrypter: {
      decrypt: async ({ data, keyUri, ivHex, sequence }) => {
        calls.push({ keyUri, ivHex, sequence });
        return data;
      }
    },
    checkBusy: () => false
  });
  assert.ok(result.taken);
  await result.managers[0].waitDrain();
  assert.equal(calls.length, 2, "both encrypted segments reach the decrypt seam");
  assert.equal(calls[0].keyUri, "https://cdn.example/k.key");
  assert.equal(calls[0].sequence, 0, "the IV falls back to the media sequence");
  assert.equal(calls[0].ivHex, null);
  await result.detach();
});

test("attaches ClearKey EME for a clearkey-class claim and detaches it cleanly", async () => {
  const emeCalls = [];
  const seams = fakeMseSeams();
  const video = makeVideo();
  const result = await attachTakeover({
    video,
    claim: { manifestUrl: "https://cdn.example/master.mpd", kind: "mpd", klass: "clearkey", laurl: "https://lic.example/ck", text: DASH_FMP4 },
    provider: makeProvider(new Map([["https://cdn.example/init.mp4", INIT], ["https://cdn.example/master.mpd", SEG0]])),
    mse: seams,
    eme: {
      attach: async (v, { laurl }) => { emeCalls.push(["attach", laurl]); },
      detach: async () => { emeCalls.push(["detach"]); },
      handleEncrypted: async () => {}
    },
    checkBusy: () => false
  });
  assert.ok(result.taken);
  assert.deepEqual(emeCalls, [["attach", "https://lic.example/ck"]], "ClearKey attached with the laurl");
  assert.equal(video.listeners.encrypted?.length, 1, "the encrypted event is wired");
  await result.detach();
  assert.deepEqual(emeCalls[emeCalls.length - 1], ["detach"]);
  assert.equal(video.listeners.encrypted?.length, 0, "the encrypted listener is removed on detach");
});

test("a page player grabbing the element (sourceclose) releases the plane", async () => {
  const provider = makeProvider(new Map([["https://cdn.example/init.mp4", INIT], ["https://cdn.example/seg-100.m4s", SEG0]]));
  const seams = fakeMseSeams();
  let detachCount = 0;
  const result = await attachTakeover({
    video: makeVideo(),
    claim: { manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "plain", text: HLS_FMP4 },
    provider,
    mse: seams,
    checkBusy: () => false
  });
  assert.ok(result.taken);
  await result.managers[0].waitDrain();
  seams.mediaSources[0].fire("sourceclose");
  await new Promise((r) => setTimeout(r, 0));
  result.managers.forEach((m) => { detachCount += 1; });
  assert.equal(detachCount, 1, "the single-lane plane still releases its drain");
  assert.equal(result.sink.destroyed, true, "the sink surrendered");
});

test("a plan with an init but no concrete segments (live template) declines", async () => {
  const live = [
    '<?xml version="1.0"?>',
    "<MPD>",
    '<Period><AdaptationSet mimeType="video/mp4">',
    '<Representation id="v1"><SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1" duration="6"/></Representation>',
    "</AdaptationSet></Period>",
    "</MPD>"
  ].join("");
  const result = await planFor({
    manifestUrl: "https://cdn.example/master.mpd", kind: "mpd", klass: "plain", text: live
  });
  assert.equal(result.taken, false);
  assert.equal(result.reason, "no-concrete-segments");
});

test("a failed init fetch tears the plane down and declines", async () => {
  const provider = makeProvider(new Map()); // init.mp4 missing -> 404
  const video = makeVideo();
  const result = await attachTakeover({
    video,
    claim: { manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", klass: "plain", text: HLS_FMP4 },
    provider,
    mse: fakeMseSeams(),
    checkBusy: () => false
  });
  assert.equal(result.taken, false);
  assert.equal(result.reason, "arm");
  assert.equal(video.src, "", "the element was handed back after the failed arm");
});