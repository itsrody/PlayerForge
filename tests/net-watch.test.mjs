import test from "node:test";
import assert from "node:assert/strict";

const MP4_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/token/supjav.com%40SNOS-153-UB.mp4";

function mediaEntry(url, initiatorType = "video") {
  return { name: url, initiatorType, startTime: 12, duration: 3.2, transferSize: 2048, responseStatus: 200 };
}

// The feed resolves PerformanceObserver from the active global at call time
// (same contract as dom-watch and its jsdom MutationObserver). Install a stub
// BEFORE the module is imported so ensureObserver binds to it, mirroring
// kernel.test.mjs's MutationObserver stub.
let observerInstances = [];
globalThis.PerformanceObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.options = null;
    this.disconnected = false;
    observerInstances.push(this);
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
};

// The unified manager imports the settings engine, whose cache evaluates
// through shared storage at module load (bare GM_getValue). Stub the trio
// before the manager import - it is dynamic so these all land first.
globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = undefined;

const { onNetEvents, netSight } = await import("../src/kernel/net-watch.js");

function tick() {
  return new Promise((resolve) => queueMicrotask(() => setTimeout(resolve, 0)));
}

const isMedia = (entry) =>
  entry?.initiatorType === "video" || entry?.initiatorType === "audio" || /\.m3u8\b/.test(entry?.name ?? "");

test("subscribing arms one live resource observer; batches coalesce per task", async () => {
  const seen = [];
  const off = onNetEvents((entries) => seen.push(entries));
  assert.equal(observerInstances.length, 1, "one observer for the whole realm");
  assert.equal(observerInstances.length, 1);

  const observer = observerInstances.at(-1);
  assert.deepEqual(observer.options, { type: "resource", buffered: false }, "live push, no buffered replay");

  observer.fire([
    mediaEntry(MP4_URL),
    { name: "https://x/logo.svg", initiatorType: "img" }
  ]);
  observer.fire([{ name: "https://x/track.m3u8", initiatorType: "script" }]);
  await tick();

  assert.equal(seen.length, 1, "both batches coalesce into ONE handler call");
  assert.equal(seen[0].length, 3, "every entry reaches an unfiltered subscriber");
  off();
});

test("filter runs inline so matching-only entries reach the handler", async () => {
  const seen = [];
  const off = onNetEvents((entries) => seen.push(entries), { filter: isMedia });
  const observer = observerInstances.at(-1);

  observer.fire([
    mediaEntry(MP4_URL),
    { name: "https://x/logo.svg", initiatorType: "img" },
    { name: "https://x/track.m3u8", initiatorType: "script" }
  ]);
  await tick();

  assert.equal(seen.length, 1, "one coalesced batch after filtering");
  assert.deepEqual(
    seen[0].map((entry) => entry.name),
    [MP4_URL, "https://x/track.m3u8"],
    "only the media-shaped entries were relayed"
  );
  off();
});

test("a no-match batch never notifies a filtered subscriber", async () => {
  let calls = 0;
  const off = onNetEvents(() => { calls++; }, { filter: isMedia });
  const observer = observerInstances.at(-1);

  observer.fire([
    { name: "https://x/logo.svg", initiatorType: "img" },
    { name: "https://x/style.css", initiatorType: "link" }
  ]);
  await tick();

  assert.equal(calls, 0, "nothing matches - handler stays silent");
  off();
});

test("unsubscribe tears the observer down when the last subscriber leaves", async () => {
  const startCount = observerInstances.length;
  let calls = 0;
  const off = onNetEvents(() => { calls++; });
  const observer = observerInstances.at(-1);
  assert.equal(observerInstances.length, startCount + 1, "one new observer was armed");
  off();
  assert.equal(observer.disconnected, true, "last subscriber leaving disconnects the feed");

  observer.fire([mediaEntry(MP4_URL)]);
  await tick();
  assert.equal(calls, 0, "a torn-down observer never notifies");

  let calls2 = 0;
  const off2 = onNetEvents(() => { calls2++; });
  const observer2 = observerInstances.at(-1);
  assert.notEqual(observer2, observer, "re-subscribing after teardown arms a fresh observer");
  observer2.fire([mediaEntry(MP4_URL)]);
  await tick();
  assert.equal(calls2, 1, "the fresh observer delivers again");
  off2();
});

test("abort signal unsubscribes the handler", async () => {
  const ac = new AbortController();
  let calls = 0;
  const off = onNetEvents(() => { calls++; }, { signal: ac.signal });
  const observer = observerInstances.at(-1);

  observer.fire([mediaEntry(MP4_URL)]);
  await tick();
  assert.equal(calls, 1);

  ac.abort();
  observer.fire([mediaEntry(MP4_URL)]);
  await tick();
  assert.equal(calls, 1, "aborting the signal unsubscribed the handler");
  off();
});

test("a realm without PerformanceObserver stays idle instead of throwing", () => {
  const previous = globalThis.PerformanceObserver;
  const stashed = observerInstances;
  globalThis.PerformanceObserver = undefined;
  observerInstances = [];
  try {
    const off = onNetEvents(() => {});
    assert.equal(observerInstances.length, 0, "no observer was armed");
    off();
  } finally {
    globalThis.PerformanceObserver = previous;
    observerInstances = stashed;
  }
});

test("netSight pushes framework sightings through the same coalesced feed", async () => {
  const seen = [];
  const off = onNetEvents((entries) => seen.push(entries.map((entry) => entry.name)));
  const observer = observerInstances.at(-1);

  observer.fire([mediaEntry(MP4_URL)]);
  netSight({ name: "https://x/proxy.m3u8", via: "proxy", initiatorType: "proxy", responseStatus: 200 });
  await tick();

  assert.equal(seen.length, 1, "observer events and netSight sights share ONE flush");
  assert.deepEqual(
    seen[0],
    [MP4_URL, "https://x/proxy.m3u8"],
    "resource entries and schedules coalesce in insertion order"
  );
  off();
});

test("netSight entries are filtered by name shape like observer entries", async () => {
  const seen = [];
  const off = onNetEvents((entries) => seen.push(entries.map((entry) => entry.name)), { filter: isMedia });

  netSight({ name: "https://x/manifest.m3u8", via: "gm", initiatorType: "other", responseStatus: null });
  netSight({ name: "https://x/logo.svg", via: "interpose", initiatorType: "fetch", responseStatus: null });
  await tick();

  assert.deepEqual(seen, [["https://x/manifest.m3u8"]], "only the media-shaped sight survived the filter");
  off();
});

test("netSight with no subscribers drops immediately and never queues or arms", async () => {
  const startCount = observerInstances.length;
  netSight({ name: MP4_URL, via: "proxy", initiatorType: "proxy", responseStatus: 200 });
  await tick();
  assert.equal(observerInstances.length, startCount, "no observer was armed for an idle feed");

  let calls = 0;
  const off = onNetEvents(() => { calls++; });
  const observer = observerInstances.at(-1);
  assert.equal(calls, 0, "pre-subscription sights never replay (live feed, no look-backs)");
  observer.fire([mediaEntry(MP4_URL)]);
  await tick();
  assert.equal(calls, 1, "post-subscription events still flow");
  off();
});

test("netSight ignores nameless or non-string entries", async () => {
  const seen = [];
  const off = onNetEvents((entries) => seen.push(entries));
  netSight(null);
  netSight({});
  netSight({ name: "" });
  netSight({ name: 42 });
  await tick();
  assert.equal(seen.length, 0, "nothing was scheduled");
  off();
});

test("a teardown before a queued flush never hands the re-armed feed an empty batch", async () => {
  const off = onNetEvents(() => {});
  const observer = observerInstances.at(-1);
  observer.fire([mediaEntry(MP4_URL)]); // queues a flush
  off(); // last subscriber leaves: pendingEntries resets, the flush is already queued

  let calls = 0;
  const off2 = onNetEvents(() => { calls++; }); // re-arms before the queued microtask runs
  await tick();

  assert.equal(calls, 0, "the re-armed subscriber is not delivered the emptied queue");
  off2();
});