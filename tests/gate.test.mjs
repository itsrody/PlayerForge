import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASS,
  ROUTABLE_CLASSES,
  classifyStream,
  hasTokenMarkers,
  matchWildcard,
  Gate
} from "../src/kernel/proxy/manifest-pipe.js";

const HLS = "m3u8";
const MPD = "mpd";

test("classification is total: every manifest maps to exactly one class", () => {
  const samples = [
    ["plain HLS", HLS, "#EXTM3U\n#EXTINF:4.0,\nseg.ts", CLASS.PLAIN],
    ["plain MPD", MPD, "<MPD><Period><AdaptationSet></AdaptationSet></Period></MPD>", CLASS.PLAIN],
    ["empty", HLS, "", CLASS.PLAIN],
    ["null text", MPD, null, CLASS.PLAIN],
    ["tokenized query", HLS, "#EXTINF:4.0,\nseg.ts?md5=abc&expires=1700000000", CLASS.TOKENIZED],
    ["tokenized hls.js", MPD, "<Period><BaseURL>$token$</BaseURL></Period>", CLASS.TOKENIZED],
    ["AES-128 identity", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k.key"', CLASS.AES128],
    ["AES-128 identity explicit", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k.key",KEYFORMAT="identity"', CLASS.AES128],
    ["SAMPLE-AES", HLS, "#EXT-X-KEY:METHOD=SAMPLE-AES", CLASS.DRM],
    ["Widevine KEYFORMAT", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.widevine.alpha"', CLASS.DRM],
    ["PlayReady KEYFORMAT", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.microsoft.playready"', CLASS.DRM],
    ["FairPlay KEYFORMAT", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"', CLASS.DRM],
    ["unknown KEYFORMAT", HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="x-vendor.foo"', CLASS.UNKNOWN],
    ["unknown scheme", HLS, "#EXT-X-KEY:METHOD=AES-256", CLASS.UNKNOWN],
    ["ClearKey DASH", MPD, '<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030cd78e8be"/>', CLASS.CLEARKEY],
    ["Widevine DASH", MPD, '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>', CLASS.DRM],
    ["PlayReady DASH", MPD, '<ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>', CLASS.DRM],
    ["FairPlay DASH", MPD, '<ContentProtection schemeIdUri="com.apple.fps.1_0"/>', CLASS.DRM],
    ["cenc without key system", MPD, '<ContentProtection value="cenc" schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>', CLASS.UNKNOWN],
    ["unknown DASH scheme", MPD, '<ContentProtection schemeIdUri="urn:uuid:12345678-abcdef00-0000-000000000000"/>', CLASS.UNKNOWN]
  ];
  for (const [label, kind, text, expected] of samples) {
    assert.equal(classifyStream(kind, text), expected, label);
  }
});

test("AES-128 wins over tokenization; DRM never coexists with routing", () => {
  assert.equal(classifyStream(HLS, '#EXT-X-KEY:METHOD=AES-128,URI="k.key"\nseg.ts?expires=1'), CLASS.AES128);
  // The same manifest carrying a DRM leg next to the AES-128 leg refuses.
  const mixed = '#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXT-X-KEY:METHOD=AES-128,URI="d",KEYFORMAT="com.widevine.alpha"';
  assert.equal(classifyStream(HLS, mixed), CLASS.DRM);
  // ClearKey plus a Widevine leg also refuses: we never race a CDM.
  const mpdDual = '<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030cd78e8be"/>'
    + '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>';
  assert.equal(classifyStream(MPD, mpdDual), CLASS.DRM);
});

test("METHOD=NONE clears encryption state (plain playlist can follow)", () => {
  assert.equal(classifyStream(HLS, "#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,\nseg.ts"), CLASS.PLAIN);
});

test("hasTokenMarkers recognizes only credential shapes, not noise", () => {
  assert.equal(hasTokenMarkers("seg.ts?md5=abc"), true);
  assert.equal(hasTokenMarkers("seg.ts?token=abc&expires=1"), true);
  assert.equal(hasTokenMarkers("<BaseURL>$token$</BaseURL>"), true);
  assert.equal(hasTokenMarkers("{token}/seg.ts"), true);
  assert.equal(hasTokenMarkers("plain segment.ts"), false);
  assert.equal(hasTokenMarkers("#EXTINF:4.0,"), false);
});

test("matchWildcard mirrors userscript glob semantics", () => {
  assert.equal(matchWildcard("https://example.com/v", "https://example.com/*"), true);
  assert.equal(matchWildcard("https://cdn.example.com/v/master.m3u8", "https://*.example.com/*"), true);
  assert.equal(matchWildcard("https://example.com/v/master.m3u8", "https://*.example.com/*"), false, "*. requires a subdomain label");
  assert.equal(matchWildcard("https://evil.com/x", "https://example.com/*"), false);
  assert.equal(matchWildcard("example.com", "example.com"), true);
  assert.equal(matchWildcard("https://example.com", "example.com"), false, "hostname patterns match hostnames, not URLs");
});

test("Gate site policy: excludes always veto; non-empty includes gate eligibility", () => {
  const gate = new Gate({ enabled: true, includes: ["https://*.example.com/*"], excludes: ["*ads*"] });
  assert.equal(gate.inScope("https://v.example.com/video.m3u8"), true);
  assert.equal(gate.inScope("https://bad.net/video.m3u8"), false, "outside the allow-list");
  assert.equal(gate.inScope("https://v.example.com/ads/x.m3u8"), false, "exclude beats include");
  assert.equal(gate.inScope("example.com"), true, "hostname form matches the include pattern");
});

test("empty include list is permissive; hostname patterns work both ways", () => {
  const gate = new Gate({ enabled: true, excludes: ["example.com"] });
  assert.equal(gate.inScope("https://v.example.com/x.m3u8"), false, "hostname exclude covers its subdomain hosts");
  assert.equal(gate.inScope("https://other.net/x.m3u8"), true);
  const allowlist = new Gate({ enabled: true, includes: ["example.com"] });
  assert.equal(allowlist.inScope("example.com"), true);
  assert.equal(allowlist.inScope("not-example.com"), false);
});

test("routeDecision is the single engage point: state, class, site, in that order", () => {
  const gate = new Gate({ enabled: false, includes: ["https://*/*"] });
  assert.deepEqual(gate.routeDecision("https://v.example.com/pl.m3u8", HLS, "#EXTM3U\nseg.ts"), {
    routed: false,
    klass: null,
    reason: "disabled"
  });

  gate.arm({ enabled: true, includes: ["https://*/*"] });
  assert.deepEqual(gate.routeDecision("https://v.example.com/pl.m3u8", HLS, "#EXTM3U\nseg.ts"), {
    routed: true,
    klass: CLASS.PLAIN
  });
  assert.deepEqual(gate.routeDecision("https://v.example.com/pl.m3u8", MPD, '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'), {
    routed: false,
    klass: CLASS.DRM,
    reason: "class:drm"
  });
  assert.deepEqual(gate.routeDecision("https://v.example.com/pl.m3u8", HLS, "#EXTM3U\nseg.ts?expires=1"), {
    routed: true,
    klass: CLASS.TOKENIZED
  });

  gate.arm({ enabled: true, includes: ["https://*example.com/*"] });
  assert.deepEqual(gate.routeDecision("https://v.example.com/pl.m3u8", MPD, "<MPD></MPD>"), {
    routed: true,
    klass: CLASS.PLAIN
  });
  assert.deepEqual(gate.routeDecision("https://other.net/pl.m3u8", MPD, "<MPD></MPD>"), {
    routed: false,
    klass: CLASS.PLAIN,
    reason: "site"
  });
});

test("disarm is a hard stop: every decision is disabled afterwards", () => {
  const gate = new Gate({ enabled: true, includes: ["https://*/*"] });
  assert.equal(gate.routeDecision("https://v.example.com/pl.m3u8", HLS, "seg.ts").routed, true);
  gate.disarm();
  assert.equal(gate.enabled, false);
  const d = gate.routeDecision("https://v.example.com/pl.m3u8", HLS, "seg.ts?expires=1");
  assert.equal(d.routed, false);
  assert.equal(d.reason, "disabled");
});

test("ROUTABLE_CLASSES matches the routed surface (§11.1)", () => {
  assert.deepEqual([...ROUTABLE_CLASSES].sort(), [
    CLASS.AES128,
    CLASS.CLEARKEY,
    CLASS.PLAIN,
    CLASS.TOKENIZED
  ]);
  for (const clazz of ROUTABLE_CLASSES) {
    assert.notEqual(clazz, CLASS.DRM);
    assert.notEqual(clazz, CLASS.UNKNOWN);
  }
});