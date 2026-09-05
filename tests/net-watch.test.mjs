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

const { onNetEvents } = await import("../src/kernel/net-watch.js");

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