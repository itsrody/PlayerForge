import test from "node:test";
import assert from "node:assert/strict";

// The unified network manager (net-watch.js) imports the settings engine, whose
// cache evaluates through shared storage at module load (bare GM_getValue).
// Stub the trio and pull the manager dynamically so these land first.
globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = undefined;

const proxy = await import("../src/kernel/net-watch.js");

test("network is a frozen hub exposing the feed, the resource plane, and the model utilities", () => {
  assert.ok(Object.isFrozen(proxy.network), "the manager surface is frozen");
  assert.deepEqual(
    Object.keys(proxy.network),
    [
      "onNetEvents",
      "netSight",
      "installProxy",
      "installProxyDebug",
      "armProxy",
      "Gate",
      "classifyStream",
      "ProxyProvider",
      "Mp4Router",
      "ManifestFlow",
      "routeProgressiveSource",
      "routeManifestStreams",
      "disposeElementSource",
      "disposeManifestStream",
      "mediaTimeline",
      "onFrame",
      "isMediaElementEntry"
    ],
    "the hub lists exactly the feed + resource plane + model utilities"
  );
});

test("the feed and installers are reachable as both hub members and named exports", () => {
  for (const name of ["onNetEvents", "netSight", "installProxy", "installProxyDebug", "armProxy"]) {
    assert.equal(typeof proxy[name], "function", `${name} is a named export`);
    assert.equal(proxy.network[name], proxy[name], `${name} is the same binding as the hub member`);
  }
});

test("the model utilities survive the re-export band", () => {
  for (const name of [
    "Gate",
    "classifyStream",
    "ProxyProvider",
    "Mp4Router",
    "ManifestFlow",
    "routeProgressiveSource",
    "routeManifestStreams",
    "disposeElementSource",
    "disposeManifestStream",
    "mediaTimeline",
    "onFrame",
    "isMediaElementEntry",
    "isManifestUrl",
    "isSegmentLikeUrl",
    "manifestKindFromUrl",
    "isProgressiveStreamUrl"
  ]) {
    assert.ok(proxy[name] != null, `${name} survives the re-export band`);
  }
  assert.equal(proxy.isManifestUrl("https://x/master.m3u8"), true, "the manager delegates the manifest predicate");
  assert.equal(typeof proxy.mediaTimeline?.has, "function", "mediaTimeline stays the kernel-held url-keyed store");
});

test("armProxy still requires a kernel with shell lifecycle hooks", () => {
  assert.equal(proxy.armProxy({ kernel: null }), null);
  assert.equal(proxy.armProxy({ kernel: {} }), null);
});