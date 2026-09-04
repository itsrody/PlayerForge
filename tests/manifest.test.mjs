import test from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_OBSERVE_RULES,
  observeManifests,
  interposeFetch,
  manifestRewrite,
  resolveRef,
  guardXhrBloom,
  ManifestFlow,
  ENGAGE_MODE,
  isClaimable
} from "../src/shell/proxy/manifest.js";
import { Gate, CLASS } from "../src/shell/proxy/gate.js";

const M3U8 = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:4.0,",
  "https://cdn.example/seg/1.ts",
  "#EXTINF:4.0,",
  "https://cdn.example/seg/2.ts",
  "#EXT-X-ENDLIST"
].join("\n");

const DRM_TEXT = '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.widevine.alpha"' + "\n" +
  "#EXTINF:4.0,\nhttps://cdn.example/seg/1.ts";

function gate(opts = {}) {
  return new Gate({ enabled: true, ...opts });
}

test("MANIFEST_OBSERVE_RULES target manifests with an observe-only cancel rule", () => {
  assert.equal(MANIFEST_OBSERVE_RULES[0].action, "cancel");
  assert.ok(MANIFEST_OBSERVE_RULES[0].selector.include.some((p) => p.includes("m3u8")));
  assert.ok(MANIFEST_OBSERVE_RULES[0].selector.include.some((p) => p.includes("mpd")));
});

test("observeManifests registers rules and maps listener details", () => {
  const seen = [];
  const gmWebRequest = (rules, listener) => {
    seen.push({ rules });
    listener({ action: "cancel", ruleIndex: 0 }, { sender: null }, { url: "https://cdn.example/master.m3u8", type: "media", tab: 1 });
  };
  const onObserve = (d) => observed.push(d);
  const observed = [];
  const res = observeManifests({ gmWebRequest, onObserve });
  assert.equal(res.registered, true);
  assert.deepEqual(seen[0].rules, MANIFEST_OBSERVE_RULES);
  assert.equal(observed[0].url, "https://cdn.example/master.m3u8");
  assert.equal(observed[0].type, "media");
  assert.equal(observed[0].action, "cancel");
  assert.equal(observed[0].tab, 1);
});

test("observeManifests feature-detects a missing GM_webRequest (never hard-required)", () => {
  const res = observeManifests({});
  assert.equal(res.registered, false);
  assert.equal(res.rules, null);
});

test("interposeFetch passes non-manifest responses through untouched", async () => {
  const original = new Response("not a manifest", { status: 200 });
  const entered = [];
  const intercepted = interposeFetch({
    fetch: async () => original,
    shouldCapture: (url) => { entered.push(url); return false; },
    rewrite: () => { throw new Error("must not run"); }
  });
  const out = await intercepted("https://x/style.css");
  assert.equal(out, original, "parent response object identity preserved");
  assert.deepEqual(entered, ["https://x/style.css"]);
});

test("interposeFetch rewrites captured manifest text and preserves status/headers", async () => {
  const original = new Response(M3U8, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
  let outcomes = [];
  const intercepted = interposeFetch({
    fetch: async () => original,
    shouldCapture: (url) => /\.m3u8/i.test(url),
    rewrite: (url, body) => ({ text: body.replace("https://cdn.example/", "https://proxy.example/"), decision: { routed: true } }),
    onOutcome: (o) => outcomes.push(o),
    makeResponse: (body, init) => ({ body, init })
  });
  const out = await intercepted("https://cdn.example/master.m3u8");
  assert.match(out.body, /https:\/\/proxy\.example\/seg\/1\.ts/);
  assert.equal(out.init.status, 200);
  assert.equal(out.init.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(outcomes[0].url, "https://cdn.example/master.m3u8");
  assert.equal(outcomes[0].decision.routed, true);
});

test("interposeFetch returns the original response when the text would not change", async () => {
  const original = new Response(M3U8);
  const intercepted = interposeFetch({
    fetch: async () => original,
    shouldCapture: (url) => /\.m3u8/i.test(url),
    rewrite: (url, body) => ({ text: body, decision: { routed: false, reason: "disabled" } })
  });
  const out = await intercepted("https://cdn.example/master.m3u8");
  assert.equal(out, original, "identity preserved on byte-identical rewrite");
});

test("interposeFetch survives a body read failure by passing the response through", async () => {
  const original = new Response(M3U8);
  original.clone = () => {
    const broken = new Response(M3U8);
    broken.text = async () => { throw new TypeError("body already used"); };
    return broken;
  };
  const intercepted = interposeFetch({
    fetch: async () => original,
    shouldCapture: () => true,
    rewrite: () => { throw new Error("must not run"); }
  });
  assert.equal(await intercepted("https://x/master.m3u8"), original);
});

test("manifestRewrite routes a plain HLS manifest through the rewriteUri", () => {
  const g = gate();
  const rewriteUri = (uri) => uri.replace(/^https:\/\/cdn\./, "https://proxy.");
  const { text, decision } = manifestRewrite("https://cdn.example/master.m3u8", M3U8, { gate: g, rewriteUri });
  assert.equal(decision.routed, true);
  assert.equal(decision.klass, CLASS.PLAIN);
  assert.match(text, /https:\/\/proxy\.example\/seg\/1\.ts/);
});

test("manifestRewrite refuses DRM and leaves the bytes identical", () => {
  const g = gate();
  const { text, decision } = manifestRewrite("https://cdn.example/master.m3u8", DRM_TEXT, {
    gate: g,
    rewriteUri: () => "https://evil.example/x"
  });
  assert.equal(decision.routed, false);
  assert.equal(decision.reason, `class:${CLASS.DRM}`);
  assert.equal(text, DRM_TEXT);
});

test("manifestRewrite refuses when the gate is disabled or the site is out of scope", () => {
  const off = new Gate({ enabled: false });
  assert.equal(manifestRewrite("https://cdn.example/master.m3u8", M3U8, { gate: off, rewriteUri: () => "x" }).decision.reason, "disabled");

  const scoped = gate({ includes: ["*.cdn.example"] });
  const { decision: denied } = manifestRewrite("https://other.example/master.m3u8", M3U8, { gate: scoped, rewriteUri: () => "x" });
  assert.equal(denied.reason, "site");

  const { decision: allowed } = manifestRewrite("https://cdn.example/master.m3u8", M3U8, { gate: scoped, rewriteUri: () => "x" });
  assert.equal(allowed.routed, true);
});

test("resolveRef absolutizes relative segment refs against the manifest base", () => {
  assert.equal(resolveRef("https://cdn.example/dir/master.m3u8", "seg.ts"), "https://cdn.example/dir/seg.ts");
  assert.equal(resolveRef("https://cdn.example/dir/master.m3u8", "../seg.ts"), "https://cdn.example/seg.ts");
  assert.equal(resolveRef("https://cdn.example/master.m3u8", "https://other.example/seg.ts"), "https://other.example/seg.ts");
  assert.equal(resolveRef("https://cdn.example/master.m3u8", "//cdn.example/seg.ts"), "//cdn.example/seg.ts");
  assert.equal(resolveRef("https://cdn.example/master.m3u8", "seg.ts?md5=abc"), "https://cdn.example/seg.ts?md5=abc");
  assert.equal(resolveRef("https://cdn.example/master.m3u8", ""), "https://cdn.example/master.m3u8", "empty refs fail to the manifest URL");
});

test("guardXhrBloom rewrites a manifest responseText in place on load", () => {
  let onload;
  const xhr = {
    url: "https://cdn.example/master.m3u8",
    responseURL: "https://cdn.example/master.m3u8",
    responseType: "",
    responseText: M3U8,
    addEventListener: (type, fn) => { if (type === "load") onload = fn; },
    send() {}
  };
  guardXhrBloom(xhr, {
    shouldCapture: (url) => /\.m3u8$/i.test(url),
    rewrite: (url, body) => ({ text: body.replace("https://cdn.example/", "https://proxy.example/"), decision: { routed: true } })
  });
  xhr.send();
  onload();
  assert.match(xhr.responseText, /https:\/\/proxy\.example\/seg\/1\.ts/);
});

test("guardXhrBloom leaves an unchanged or non-manifest response byte-identical", () => {
  let onload;
  const xhr = {
    url: "https://cdn.example/master.m3u8",
    responseURL: "https://cdn.example/master.m3u8",
    responseType: "",
    responseText: M3U8,
    addEventListener: (type, fn) => { if (type === "load") onload = fn; },
    send() {}
  };
  guardXhrBloom(xhr, {
    shouldCapture: () => true,
    rewrite: (url, body) => ({ text: body, decision: { routed: false } })
  });
  xhr.send();
  onload();
  assert.equal(xhr.responseText, M3U8);

  const plain = {
    url: "https://cdn.example/seg.ts",
    responseURL: "https://cdn.example/seg.ts",
    responseType: "",
    responseText: "binary bits",
    addEventListener: (type, fn) => { if (type === "load") onload = fn; },
    send() {}
  };
  guardXhrBloom(plain, { shouldCapture: () => false, rewrite: () => { throw new Error("no"); } });
  plain.send();
  onload();
  assert.equal(plain.responseText, "binary bits");
});

test("isClaimable mirrors the ablation guard (only uncommitted videos)", () => {
  assert.equal(isClaimable({ readyState: 0 }), true);
  assert.equal(isClaimable({ readyState: 0, mediaSourceAttached: false }), true);
  assert.equal(isClaimable({ readyState: 1 }), false);
  assert.equal(isClaimable({ readyState: 2 }), false);
  assert.equal(isClaimable({ mediaSourceAttached: true }), false);
  assert.equal(isClaimable({}), true, "no signal means claimable");
});

test("ManifestFlow refuses when the feature is disabled, DRM, or out of site scope", () => {
  const flow = new ManifestFlow({ gate: gate(), consented: true });
  assert.equal(flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 }).engage, true);

  const off = new ManifestFlow({ gate: new Gate({ enabled: false }), consented: true });
  assert.equal(off.consider({ player: "p2", manifestUrl: "https://x/m.m3u8", kind: "m3u8", text: M3U8 }).reason, "disabled");

  const drm = new ManifestFlow({ gate: gate(), consented: true });
  assert.equal(drm.consider({ player: "p3", manifestUrl: "https://x/m.m3u8", kind: "m3u8", text: DRM_TEXT }).reason, `class:${CLASS.DRM}`);

  const scoped = new ManifestFlow({ gate: gate({ includes: ["*.cdn.example"] }), consented: true });
  assert.equal(scoped.consider({ player: "p4", manifestUrl: "https://elsewhere.example/m.m3u8", kind: "m3u8", text: M3U8 }).reason, "site");
});

test("ManifestFlow gating: consent, modes, and the ablation guard", () => {
  // auto without consent -> consent
  const flow = new ManifestFlow({ gate: gate(), consented: false });
  const blocked = flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 });
  assert.equal(blocked.reason, "consent");
  assert.equal(blocked.engage, false);

  // consent warms the same flow
  flow.setConsent(true);
  assert.equal(flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 }).engage, true);

  // busy video (page already committing bytes) -> busy regardless of consent
  const busy = new ManifestFlow({ gate: gate(), consented: true });
  assert.equal(
    busy.consider({ player: "p2", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8, video: {}, readyState: 2 }).reason,
    "busy"
  );
  assert.equal(
    busy.consider({ player: "p3", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8, video: {}, readyState: 0, mediaSourceAttached: true }).reason,
    "busy"
  );

  // manual engages with no consent (explicit user action)
  const manual = new ManifestFlow({ gate: gate(), mode: ENGAGE_MODE.MANUAL, consented: false });
  assert.equal(manual.consider({ player: "p4", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 }).engage, true);
});

test("ManifestFlow emits status and claims exactly once per player", () => {
  const statuses = [];
  const engages = [];
  const flow = new ManifestFlow({
    gate: gate(),
    consented: true,
    onEngage: (o) => engages.push(o),
    onStatus: (o) => statuses.push(o)
  });
  const first = flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 });
  assert.equal(first.engage, true);
  const again = flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 });
  assert.equal(again, first, "stable ruling for the claimed player");
  assert.equal(engages.length, 1, "onEngage fired once");
  assert.equal(flow.claimedSize, 1);
});

test("ManifestFlow disengage and downgrade hand players back toward native", () => {
  const releases = [];
  const flow = new ManifestFlow({ gate: gate(), consented: true, onDisengage: (o) => releases.push(o) });
  flow.consider({ player: "p1", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 });
  flow.consider({ player: "p2", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 });
  assert.equal(flow.claimedSize, 2);

  flow.disengage("p1", { reason: "teardown" });
  assert.deepEqual(releases, [{ player: "p1", reason: "teardown" }]);
  assert.equal(flow.claimedSize, 1);
  assert.equal(flow.decision("p1"), null);

  flow.downgrade({ reason: "downgrade" });
  assert.deepEqual(releases[1], { player: "p2", reason: "downgrade" });
  assert.equal(flow.claimedSize, 0);
  assert.equal(flow.consider({ player: "p3", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 }).reason, "downgraded");

  flow.rearm();
  assert.equal(flow.consider({ player: "p3", manifestUrl: "https://cdn.example/master.m3u8", kind: "m3u8", text: M3U8 }).engage, true);
});

test("ManifestFlow default mode is auto and setMode clamps unknown values", () => {
  const flow = new ManifestFlow({ gate: gate() });
  assert.equal(flow.mode, ENGAGE_MODE.AUTO);
  flow.setMode("loud");
  assert.equal(flow.mode, ENGAGE_MODE.AUTO);
  flow.setMode(ENGAGE_MODE.ASK);
  assert.equal(flow.mode, ENGAGE_MODE.ASK);
});