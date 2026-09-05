import test from "node:test";
import assert from "node:assert/strict";
import {
  detectManifestKind,
  sniffManifestKind,
  isSegmentReference,
  rewriteManifest,
  injectQueryParams,
  injectPathTokens
} from "../src/kernel/proxy/rewrite.js";

// Caller-supplied transformer in these tests: route every in-scope reference
// through the proxy pipe so assertions target the surgery, not the scheme.
const ROUTE = (uri) => `pf://seg/${uri}`;

test("detectManifestKind reads the URL suffix, ignoring query and hash", () => {
  assert.equal(detectManifestKind("https://cdn.example.com/v/master.m3u8"), "m3u8");
  assert.equal(detectManifestKind("https://cdn.example.com/v/master.m3u8?token=abc#frag"), "m3u8");
  assert.equal(detectManifestKind("https://cdn.example.com/v/manifest.mpd"), "mpd");
  assert.equal(detectManifestKind("https://cdn.example.com/v/seg-1.ts"), null);
  assert.equal(detectManifestKind(""), null);
});

test("sniffManifestKind falls back to content for extensionless URLs", () => {
  assert.equal(sniffManifestKind("#EXTM3U\n#EXT-X-VERSION:3\n"), "m3u8");
  assert.equal(sniffManifestKind("<?xml version=\"1.0\"?><MPD xmlns=\"urn:dash\">"), "mpd");
  assert.equal(sniffManifestKind("plain text"), null);
});

test("isSegmentReference admits media refs and rejects routed-elsewhere ones", () => {
  assert.equal(isSegmentReference("seg-1.ts"), true);
  assert.equal(isSegmentReference("../chunks/seg_00005.m4s"), true);
  assert.equal(isSegmentReference("media-$Number$.m4s"), true);
  assert.equal(isSegmentReference("https://cdn.example.com/v/seg-1.ts?token=x"), true);
  assert.equal(isSegmentReference("variant.m3u8"), false, "variant playlists stay on the manifest layer");
  assert.equal(isSegmentReference("https://cdn.example.com/v/master.mpd"), false);
  assert.equal(isSegmentReference("keys/enc.key"), false, "the AES-128 key path is separate (§11.2)");
  assert.equal(isSegmentReference("subs/en.vtt"), false);
  assert.equal(isSegmentReference("#EXTINF:4.0,"), false, "directives are never references");
  assert.equal(isSegmentReference(""), false);
});

test("rewrite is byte-stable when unarmed, kindless, or with a no-op transformer", () => {
  const hls = "#EXTM3U\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nseg-2.ts";
  assert.equal(rewriteManifest(hls, { armed: false, rewriteUri: ROUTE }), hls);
  assert.equal(rewriteManifest(hls, { armed: true }), hls, "armed without a transformer must not rewrite");
  assert.equal(rewriteManifest(hls, { armed: true, rewriteUri: (u) => u }), hls);
  assert.equal(rewriteManifest(hls, { armed: true, baseUrl: "https://x/v/pl.m3u8" }), hls);
  // Non-string input (a signal that the caller passed garbage) passes through.
  assert.equal(rewriteManifest(null, { armed: true, rewriteUri: ROUTE }), null);
});

test("HLS: every non-directive segment line rewrites, preserving separators", () => {
  const hls = "#EXTM3U\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nsub/seg-2.ts\n#EXT-X-ENDLIST";
  const out = rewriteManifest(hls, {
    armed: true,
    baseUrl: "https://cdn.example.com/v/pl.m3u8",
    rewriteUri: ROUTE
  });
  assert.equal(out, "#EXTM3U\n#EXTINF:4.0,\npf://seg/seg-1.ts\n#EXTINF:4.0,\npf://seg/sub/seg-2.ts\n#EXT-X-ENDLIST");
});

test("HLS: CRLF line endings survive a rewrite untouched", () => {
  const hls = "#EXTM3U\r\n#EXTINF:4.0,\r\nseg-1.ts\r\n#EXT-X-ENDLIST\r\n";
  const out = rewriteManifest(hls, { armed: true, baseUrl: "https://x/pl.m3u8", rewriteUri: ROUTE });
  assert.equal(out, "#EXTM3U\r\n#EXTINF:4.0,\r\npf://seg/seg-1.ts\r\n#EXT-X-ENDLIST\r\n");
});

test("HLS: #EXT-X-MEDIA URI attrs rewrite, rendition/key refs stay untouched", () => {
  const hls = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="English",URI="eng/direct.aac"\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="Alt",URI="eng/rendition.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"';
  const out = rewriteManifest(hls, { armed: true, baseUrl: "https://x/pl.m3u8", rewriteUri: ROUTE });
  assert.ok(out.includes('URI="pf://seg/eng/direct.aac"'), out);
  assert.ok(out.includes('URI="eng/rendition.m3u8"'), "rendition playlists route through the manifest layer, not the segment pipe");
  assert.ok(out.includes('URI="keys/enc.key"'), "the key URI stays on its own (non-segment) path");
});

test("scope gates each reference: out-of-scope hosts stay byte-identical", () => {
  const hls = "#EXTINF:4.0,\nexternal.net/seg.ts\n#EXTINF:4.0,\ncdn.example.com/seg.ts";
  const inScope = (uri) => !uri.startsWith("external.net");
  const out = rewriteManifest(hls, { armed: true, baseUrl: "https://x/pl.m3u8", scope: inScope, rewriteUri: ROUTE });
  assert.equal(out, "#EXTINF:4.0,\nexternal.net/seg.ts\n#EXTINF:4.0,\npf://seg/cdn.example.com/seg.ts");
  // The same input with everything eligible rewrites both lines (guards
  // against a silent all-or-nothing collapse).
  const all = rewriteManifest(hls, { armed: true, baseUrl: "https://x/pl.m3u8", rewriteUri: ROUTE });
  assert.equal(all, "#EXTINF:4.0,\npf://seg/external.net/seg.ts\n#EXTINF:4.0,\npf://seg/cdn.example.com/seg.ts");
});

test("DASH: SegmentTemplate media/index/initialization attributes rewrite", () => {
  const mpd = `<?xml version="1.0"?><MPD>
  <Period>
    <AdaptationSet>
      <SegmentTemplate timescale="1000" duration="4000"
        initialization="init-$RepresentationID$.m4s"
        media="seg-$Number$.m4s"
        index="idx-$Number$.m4s"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const out = rewriteManifest(mpd, { armed: true, baseUrl: "https://cdn/v/manifest.mpd", rewriteUri: ROUTE });
  assert.ok(out.includes('initialization="pf://seg/init-$RepresentationID$.m4s"'), out);
  assert.ok(out.includes('media="pf://seg/seg-$Number$.m4s"'), out);
  assert.ok(out.includes('index="pf://seg/idx-$Number$.m4s"'), out);
  assert.ok(out.includes("timescale=\"1000\""), "non-URI attributes stay byte-identical");
});

test("DASH: BaseURL text rewrites, preserving interior whitespace", () => {
  const mpd = "<MPD>\n<BaseURL>\n  https://cdn.example.com/v/\n</BaseURL>\n</MPD>";
  const out = rewriteManifest(mpd, { armed: true, baseUrl: "https://cdn/v/manifest.mpd", rewriteUri: ROUTE });
  assert.equal(out, "<MPD>\n<BaseURL>\n  pf://seg/https://cdn.example.com/v/\n</BaseURL>\n</MPD>");
});

test("DASH: out-of-scope BaseURL is left untouched", () => {
  const mpd = `<MPD><BaseURL>https://other.net/v/</BaseURL></MPD>`;
  const out = rewriteManifest(mpd, { armed: true, baseUrl: "https://cdn/v/manifest.mpd", scope: (u) => u.startsWith("https://cdn"), rewriteUri: ROUTE });
  assert.equal(out, mpd);
});

test("kind resolution works without a manifest URL (sniffed from text)", () => {
  const hls = "#EXTM3U\n#EXTINF:2.0,\na.ts";
  const out = rewriteManifest(hls, { armed: true, rewriteUri: ROUTE });
  assert.ok(out.includes("pf://seg/a.ts"), out);
});

test("injectQueryParams appends, replaces, keeps hashes, and no-op is byte-stable", () => {
  assert.equal(injectQueryParams("seg-1.ts", { token: "abc" }), "seg-1.ts?token=abc");
  assert.equal(injectQueryParams("seg-1.ts?md5=old&b=2", { md5: "new", expires: "1730000000" }), "seg-1.ts?md5=new&b=2&expires=1730000000");
  assert.equal(injectQueryParams("https://cdn/v/seg.ts#frag", { token: "x" }), "https://cdn/v/seg.ts?token=x#frag");
  const stable = "https://cdn/v/seg.ts?token=abc";
  assert.equal(injectQueryParams(stable, { token: "abc" }), stable, "identical values never rewrite");
  assert.equal(injectQueryParams("seg-1.ts", {}), "seg-1.ts");
  assert.equal(injectQueryParams("seg-1.ts", null), "seg-1.ts");
});

test("injectPathTokens fills {token}/{expires} placeholders only", () => {
  assert.equal(injectPathTokens("https://cdn/v/{token}/seg.ts", { token: "abc" }), "https://cdn/v/abc/seg.ts");
  assert.equal(injectPathTokens("https://cdn/v/{token}/{expires}/seg.ts", { token: "abc", expires: 1730000000 }), "https://cdn/v/abc/1730000000/seg.ts");
  assert.equal(
    injectPathTokens("https://cdn/v/{token}/seg.ts", { token: "a b/c" }),
    "https://cdn/v/a%20b%2Fc/seg.ts",
    "path tokens are path-safe encoded"
  );
  const noPlaceholder = "https://cdn/v/seg.ts";
  assert.equal(injectPathTokens(noPlaceholder, { token: "abc" }), noPlaceholder);
  assert.equal(injectPathTokens("https://cdn/v/seg.ts", null), "https://cdn/v/seg.ts");
});

test("rewriteManifest+injectQueryParams compose to a tokenized route", () => {
  const hls = "#EXTM3U\n#EXTINF:4.0,\nseg-1.ts?md5=dead&expires=1700000000\n#EXT-X-ENDLIST";
  const route = (uri) => injectQueryParams(uri, { md5: "live", expires: "1710000000" });
  const out = rewriteManifest(hls, { armed: true, baseUrl: "https://cdn/pl.m3u8", rewriteUri: route });
  assert.equal(out, "#EXTM3U\n#EXTINF:4.0,\nseg-1.ts?md5=live&expires=1710000000\n#EXT-X-ENDLIST");
});

test("HLS: #EXT-X-MAP init URI rewrites through the segment pipe", () => {
  const hls = '#EXTM3U\n#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:720@720\nmain.mp4';
  const out = rewriteManifest(hls, { armed: true, baseUrl: "https://cdn/v/pl.m3u8", rewriteUri: ROUTE });
  assert.ok(out.includes('URI="pf://seg/main.mp4"'), out);
  assert.ok(out.includes('BYTERANGE="720@0"'), "byte ranges ride along untouched");
  assert.ok(out.includes("pf://seg/main.mp4"), "the media fragment still rewrites");
});

test("DASH: SegmentBase initialization and Initialization element rewrite, ranges stay", () => {
  const mpd = '<MPD><SegmentBase indexRange="0-999" initialization="whole.mp4#0-999"><Initialization sourceURL="whole.mp4" range="0-999"/></SegmentBase></MPD>';
  const out = rewriteManifest(mpd, { armed: true, baseUrl: "https://cdn/v/manifest.mpd", rewriteUri: ROUTE });
  assert.ok(out.includes('initialization="pf://seg/whole.mp4#0-999"'), out);
  assert.ok(out.includes('sourceURL="pf://seg/whole.mp4"'), out);
  assert.ok(out.includes('range="0-999"'), "byte ranges are not URIs - left untouched");
  assert.ok(out.includes('indexRange="0-999"'), out);
});

test("DASH: bare range-only initialization values are never rewritten", () => {
  const mpd = '<MPD><SegmentBase indexRange="4-999" initialization="0-3"><Initialization sourceURL="init.mp4" range="0-3"/></SegmentBase></MPD>';
  const out = rewriteManifest(mpd, { armed: true, baseUrl: "https://cdn/v/manifest.mpd", rewriteUri: ROUTE });
  assert.ok(out.includes('initialization="0-3"'), "a pure byte-range value stays a byte range");
  assert.ok(out.includes('sourceURL="pf://seg/init.mp4"'), out);
});