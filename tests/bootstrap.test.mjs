import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/kernel/proxy/gate.js";

// The unified network manager (net-watch.js) imports the settings engine, whose
// cache evaluates through shared storage at module load (bare GM_getValue). A
// static import would run before any body statement, so stub the trio and pull
// the manager dynamically - the statements above all land first.
globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = undefined;
const { installProxy, installProxyDebug, isManifestUrl } = await import("../src/kernel/net-watch.js");

const M3U8 = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:4.0,",
  "https://cdn.example/seg/1.ts",
  "#EXT-X-ENDLIST"
].join("\n");

const M3U8_SIBLING_CDN = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:4.0,",
  "https://media.cdn.example/seg/1.ts",
  "#EXTINF:4.0,",
  "https://media.cdn.example/seg/2.ts",
  "#EXT-X-ENDLIST"
].join("\n");

const GET_VIDEO_URL =
  "https://streamtape.com/get_video?id=VzGml9j9zMsKvxx&expires=1788640920&ip=F0INKRSUEy9XKxR&token=H6V4Z60CJoCK&stream=1";

function manifestFeatures(getSetting) {
  return (key) => {
    if (key === "features.manifestProxy") return true;
    if (key === "features.mp4Fallback") return true;
    return getSetting?.(key);
  };
}

function bodyBytes(resp) {
  return Promise.resolve(resp.arrayBuffer()).then((ab) => Array.from(new Uint8Array(ab)));
}

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
  const installed = installProxyDebug({
    debugOn: false,
    gmWebRequest: () => calls.push("gm"),
    fetch: () => calls.push("fetch"),
    installFetch: () => calls.push("install"),
    xhrPrototype: {}
  });
  assert.deepEqual(installed.summary, { enabled: false });
  assert.equal(installed.router, null);
  assert.deepEqual(calls, []);
});

test("installProxyDebug frame role skips GM_webRequest but keeps interpose layers", () => {
  const registerCalls = [];
  let installedFetch = null;
  const installed = installProxyDebug({
    debugOn: true,
    role: "frame",
    gmWebRequest: (rules) => registerCalls.push(rules),
    fetch: async () => new Response(M3U8),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} }
  });
  assert.deepEqual(installed.summary, { enabled: true, role: "frame", observe: false, fetch: true, xhr: true, mp4: { route: true } });
  assert.ok(installed.router, "a frame also gets the shared router for element-level src routing");
  assert.deepEqual(registerCalls, [], "frame instance must not register tab-level rules");
  assert.equal(typeof installedFetch, "function", "frame interposes its own fetch/XHR surface");
});

test("installProxyDebug wires observe + fetch + xhr with the gate disabled (byte-identical)", async () => {
  const ruleCalls = [];
  const originalResponse = new Response(M3U8, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
  const realFetch = async () => originalResponse;
  let installedFetch = null;
  const proto = { send() {} };

  const installed = installProxyDebug({
    debugOn: true,
    gmWebRequest: (rules, listener) => {
      ruleCalls.push(rules);
      listener({ action: "cancel", ruleIndex: 0 }, {}, { url: "https://cdn.example/master.m3u8", type: "media", tab: 1 });
    },
    fetch: realFetch,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: proto
  });
  assert.deepEqual(installed.summary, { enabled: true, role: "top", observe: true, fetch: true, xhr: true, mp4: { route: true } });
  assert.ok(installed.router, "the shared Mp4Router is exposed for the element-level seam");
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
  const installed = installProxyDebug({
    debugOn: true,
    fetch: async () => new Response(M3U8),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} }
  });
  assert.equal(installed.summary.observe, false);
  assert.equal(installed.summary.fetch, true);
  assert.equal(installed.summary.xhr, true);
  assert.equal(typeof installedFetch, "function");
  assert.equal(installed.summary.role, "top");
});

test("installProxyDebug degrades gracefully with missing fetch/xhr seams", () => {
  const installed = installProxyDebug({
    debugOn: true,
    gmWebRequest: () => {},
    fetch: null,
    xhrPrototype: null
  });
  assert.deepEqual(installed.summary, { enabled: true, role: "top", observe: true, fetch: false, xhr: false, mp4: { route: false } });
  assert.equal(installed.router, null);
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

test("installProxy keeps observe independent of the fetch seam", () => {
  const calls = [];
  const installed = installProxy({
    gmWebRequest: () => calls.push("gm"),
    fetch: null,
    xhrPrototype: null,
    getSetting: manifestFeatures()
  });
  assert.deepEqual(installed.summary, {
    enabled: true,
    role: "top",
    observe: true,
    fetch: false,
    xhr: false,
    manifest: { route: true },
    mp4: { route: true }
  });
  assert.equal(installed.router, null, "no fetch seam means no router");
  assert.equal(calls.length, 1, "GM rules register on the top frame regardless");
});

test("installProxy is config-gated: features off means nothing engages", async () => {
  const originalResponse = new Response(M3U8, { status: 200 });
  let installedFetch = null;
  const installed = installProxy({
    fetch: async () => originalResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: () => undefined
  });
  assert.equal(installed.summary.enabled, false);
  assert.equal(installed.summary.manifest.route, false);
  assert.equal(installed.summary.mp4.route, false);

  const manifestOut = await installedFetch("https://cdn.example/master.m3u8");
  assert.equal(manifestOut, originalResponse, "gate-disabled manifest keeps the original Response");
  assert.equal(installed.flow.claimedSize, 0);

  const segOut = await installedFetch("https://cdn.example/seg/1.ts");
  assert.equal(segOut, originalResponse, "a segment on a never-engaged host rides the native wire");
  assert.deepEqual(await Promise.all([manifestOut, segOut]), [originalResponse, originalResponse]);
});

test("installProxy engages manifest hosts and routes their segments through the proxy", async () => {
  const providerFetches = [];
  let installedFetch = null;
  const installed = installProxy({
    fetch: async () => new Response(M3U8, { status: 200 }),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: manifestFeatures(),
    provider: {
      fetch: async (url) => {
        providerFetches.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp2t" }, body: new Uint8Array([1, 2]) } };
      }
    }
  });
  assert.equal(installed.summary.manifest.route, true);

  const manifestOut = await installedFetch("https://cdn.example/master.m3u8");
  assert.equal(await manifestOut.text(), M3U8, "Mode-A text stays byte-identical (routing is per-segment)");
  assert.equal(installed.flow.claimedSize, 1, "the manifest is claimed as the t2 decision");
  assert.equal(installed.flow.decision("https://cdn.example/master.m3u8").engage, true);

  const segOut = await installedFetch("https://cdn.example/seg/1.ts");
  assert.deepEqual(await bodyBytes(segOut), [1, 2], "the engaged host's segment bytes ride the proxy");
  assert.deepEqual(providerFetches, ["https://cdn.example/seg/1.ts"], "the proxy GET is the initiator");
});

test("installProxy routes sibling CDN hosts the manifest references", async () => {
  const providerFetches = [];
  let installedFetch = null;
  installProxy({
    fetch: async () => new Response(M3U8_SIBLING_CDN, { status: 200 }),
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: manifestFeatures(),
    provider: {
      fetch: async (url) => {
        providerFetches.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp2t" }, body: new Uint8Array([4]) } };
      }
    }
  });
  await installedFetch("https://player.example/master.m3u8");
  const segOut = await installedFetch("https://media.cdn.example/seg/1.ts");
  assert.deepEqual(await bodyBytes(segOut), [4], "a cross-host CDN the manifest points at engages too");
});

test("installProxy keeps unengaged segment-shaped fetches native (never .ts-blind)", async () => {
  const originalResponse = new Response("typescript module", { status: 200 });
  const providerCalls = [];
  let installedFetch = null;
  installProxy({
    fetch: async () => originalResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: manifestFeatures(),
    provider: { fetch: async () => { providerCalls.push("unused"); return null; } }
  });
  const out = await installedFetch("https://cdn.example/main.ts");
  assert.equal(out, originalResponse, "a .ts fetch before any manifest on that host stays on the native wire");
  assert.deepEqual(providerCalls, [], "the proxy GET never fires for an unengaged host");
});

test("installProxy disengage and downgrade return the segment space to native", async () => {
  const providerFetches = [];
  let installedFetch = null;
  const nativeResponse = new Response("native", { status: 200 });
  const installed = installProxy({
    fetch: async () => nativeResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: manifestFeatures(),
    provider: {
      fetch: async (url) => {
        providerFetches.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp2t" }, body: new Uint8Array([7]) } };
      }
    }
  });

  await installedFetch("https://cdn.example/master.m3u8");
  const routed1 = await installedFetch("https://cdn.example/seg/1.ts");
  assert.deepEqual(await bodyBytes(routed1), [7], "segment routes while engaged");

  installed.flow.disengage("https://cdn.example/master.m3u8", { reason: "teardown" });
  assert.equal(installed.flow.claimedSize, 0);
  const native = await installedFetch("https://cdn.example/seg/2.ts");
  assert.equal(native, nativeResponse, "released host keeps the native wire");
  assert.ok(!providerFetches.some((u) => u.endsWith("/2.ts")), "no proxy GET after disengage");

  await installedFetch("https://cdn.example/master.m3u8");
  installed.flow.downgrade({ reason: "downgrade" });
  const after = await installedFetch("https://cdn.example/seg/3.ts");
  assert.equal(after, nativeResponse, "downgrade hands the byte space back to native");
  assert.equal(installed.flow.claimedSize, 0);
});

test("installProxy honors proxy.routing site scope for engagement and routing", async () => {
  const providerFetches = [];
  let installedFetch = null;
  const nativeResponse = new Response("native", { status: 200 });
  installProxy({
    fetch: async () => nativeResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: (key) => {
      if (key === "features.manifestProxy" || key === "features.mp4Fallback") return true;
      if (key === "proxy.routing.includes") return ["*.cdn.example"];
      if (key === "proxy.routing.excludes") return undefined;
      return undefined;
    },
    provider: {
      fetch: async (url) => {
        providerFetches.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp2t" }, body: new Uint8Array([3]) } };
      }
    }
  });

  const outOfScope = await installedFetch("https://other.example/master.m3u8");
  assert.equal(outOfScope, nativeResponse, "out-of-scope manifest stays native and never engages");

  await installedFetch("https://cdn.example/master.m3u8");
  const seg = await installedFetch("https://cdn.example/seg/1.ts");
  assert.deepEqual(await bodyBytes(seg), [3], "in-scope engaged segment routes");
  assert.ok(providerFetches.some((u) => u.endsWith("/1.ts")));
});

test("installProxy keeps MP4 request routing behind its own toggle", async () => {
  const providerFetches = [];
  let installedFetch = null;
  const nativeResponse = new Response("native", { status: 200 });
  installProxy({
    fetch: async () => nativeResponse,
    installFetch: (wrapped) => { installedFetch = wrapped; },
    xhrPrototype: { send() {} },
    getSetting: (key) => key === "features.mp4Fallback",
    provider: {
      fetch: async (url) => {
        providerFetches.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([8]) } };
      }
    }
  });
  const out = await installedFetch(GET_VIDEO_URL);
  assert.deepEqual(await bodyBytes(out), [8], "an MP4-shaped fetch is routed even with manifest routing off");
  assert.ok(providerFetches.some((u) => u === GET_VIDEO_URL));
});