import test from "node:test";
import assert from "node:assert/strict";
import { installProxyDebug, isManifestUrl } from "../src/shell/proxy/bootstrap.js";
import { Gate } from "../src/shell/proxy/gate.js";

const M3U8 = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:4.0,",
  "https://cdn.example/seg/1.ts",
  "#EXT-X-ENDLIST"
].join("\n");

test("isManifestUrl matches .m3u8/.mpd with query/fragment tails", () => {
  assert.equal(isManifestUrl("https://x/master.m3u8"), true);
  assert.equal(isManifestUrl("https://x/master.m3u8?token=abc"), true);
  assert.equal(isManifestUrl("https://x/man.mpd"), true);
  assert.equal(isManifestUrl("https://x/man.mpd#frag"), true);
  assert.equal(isManifestUrl("https://x/master.m3u8&x=1"), true);
  assert.equal(isManifestUrl("https://x/style.css"), false);
  assert.equal(isManifestUrl("https://x/seg.ts"), false);
  assert.equal(isManifestUrl(""), false);
});

test("installProxyDebug touches nothing when debug is off", () => {
  const calls = [];
  const summary = installProxyDebug({
    debugOn: false,
    gmWebRequest: () => calls.push("gm"),
    fetch: () => calls.push("fetch"),
    installFetch: () => calls.push("install"),
    xhrPrototype: {}
  });
  assert.deepEqual(summary, { enabled: false });
  assert.deepEqual(calls, []);
});

test("installProxyDebug frame role skips GM_webRequest but keeps interpose layers", () => {
  const registerCalls = [];
  let installedFetch = null;
  const summary = installProxyDebug({
    debugOn: true,
    role: "frame",
    gmWebRequest: (rules) => registerCalls.push(rules),
    fetch: async () => new Response(M3U8),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} }
  });
  assert.deepEqual(summary, { enabled: true, role: "frame", observe: false, fetch: true, xhr: true, mp4: { route: true } });
  assert.deepEqual(registerCalls, [], "frame instance must not register tab-level rules");
  assert.equal(typeof installedFetch, "function", "frame interposes its own fetch/XHR surface");
});

test("installProxyDebug wires observe + fetch + xhr with the gate disabled (byte-identical)", async () => {
  const ruleCalls = [];
  const originalResponse = new Response(M3U8, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
  const realFetch = async () => originalResponse;
  let installedFetch = null;
  const proto = { send() {} };

  const summary = installProxyDebug({
    debugOn: true,
    gmWebRequest: (rules, listener) => {
      ruleCalls.push(rules);
      listener({ action: "cancel", ruleIndex: 0 }, {}, { url: "https://cdn.example/master.m3u8", type: "media", tab: 1 });
    },
    fetch: realFetch,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: proto
  });
  assert.deepEqual(summary, { enabled: true, role: "top", observe: true, fetch: true, xhr: true, mp4: { route: true } });
  assert.equal(ruleCalls.length, 1, "GM_webRequest registered once");
  assert.ok(ruleCalls[0][0].selector.include.some((p) => p.includes("m3u8")));
  const out = await installedFetch("https://cdn.example/master.m3u8");
  assert.equal(out, originalResponse, "gate-disabled interpose keeps the original Response");
});

test("installProxyDebug passes manifest responses through byte-identically when unarmed", async () => {
  const originalResponse = new Response(M3U8, { status: 200 });
  let installedFetch = null;
  installProxyDebug({
    debugOn: true,
    fetch: async () => originalResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} }
  });
  const out = await installedFetch("https://cdn.example/master.m3u8");
  assert.equal(out, originalResponse, "gate-disabled rewrite keeps the original Response object");
});

test("installProxyDebug feature-detects a missing GM_webRequest but keeps interpose layers", () => {
  let installedFetch = null;
  const summary = installProxyDebug({
    debugOn: true,
    fetch: async () => new Response(M3U8),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} }
  });
  assert.equal(summary.observe, false);
  assert.equal(summary.fetch, true);
  assert.equal(summary.xhr, true);
  assert.equal(typeof installedFetch, "function");
  assert.equal(summary.role, "top");
});

test("installProxyDebug degrades gracefully with missing fetch/xhr seams", () => {
  const summary = installProxyDebug({
    debugOn: true,
    gmWebRequest: () => {},
    fetch: null,
    xhrPrototype: null
  });
  assert.deepEqual(summary, { enabled: true, role: "top", observe: true, fetch: false, xhr: false, mp4: { route: false } });
});

test("installProxyDebug rewrites xhr manifest text through the wrapped prototype", () => {
  const proto = { send() {} };
  let onload;
  const xhr = {
    url: "https://cdn.example/master.m3u8",
    responseURL: "https://cdn.example/master.m3u8",
    responseType: "",
    responseText: M3U8,
    addEventListener: (t, fn) => { if (t === "load") onload = fn; }
  };
  Object.setPrototypeOf(xhr, proto);

  installProxyDebug({
    debugOn: true,
    fetch: null,
    xhrPrototype: proto
  });
  xhr.send();
  onload();
  assert.equal(xhr.responseText, M3U8, "gate disabled keeps responseText byte-identical");
});