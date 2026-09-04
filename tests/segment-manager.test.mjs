import test from "node:test";
import assert from "node:assert/strict";
import { SegmentManager, SegmentError, STATUS } from "../src/shell/proxy/segment-manager.js";

const BYTE = new Uint8Array([1]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeManager(overrides = {}) {
  const log = {
    appended: [],
    fetched: [],
    fetchedUris: [],
    decrypt: [],
    refresh: [],
    events: [],
    scheduled: [],
    now: 0
  };
  const sources = overrides.sources ?? new Map();
  const options = { ...overrides.options };
  const { clock: customClock, scheduler: customScheduler, ...rest } = options;
  const clock = customClock ?? (() => log.now);
  const scheduler = customScheduler ?? ((fn) => { log.scheduled.push(fn); });

  const fetch = overrides.fetch ?? (async (seg) => {
    log.fetched.push(seg.id);
    log.fetchedUris.push(seg.uri);
    const hit = sources.get(seg.uri);
    if (hit instanceof Error) {
      throw hit;
    }
    if (hit !== undefined) {
      return hit;
    }
    throw new SegmentError("missing", { status: 404 });
  });
  const append = overrides.append ?? (async (seg) => { log.appended.push(seg.id); });
  const decrypt = overrides.decrypt ?? null;
  const refresh = overrides.refresh ?? null;

  const manager = new SegmentManager({ ...rest, fetch, append, decrypt, refresh, clock, scheduler });
  manager.onChange((event) => log.events.push(event));
  return { manager, log, sources, drain: manager.waitDrain() };
}

test("delivers buffered segments in ascending order and drains", async () => {
  const { manager, log, sources, drain } = makeManager();
  const groups = ["a", "b", "c"];
  groups.forEach((uri, id) => sources.set(uri, new Uint8Array([id])));
  manager.enqueue({ id: 0, uri: "a" });
  manager.enqueue({ id: 1, uri: "b" });
  manager.enqueue({ id: 2, uri: "c" });
  await drain;
  assert.deepEqual(log.appended, [0, 1, 2]);
  assert.equal(manager.inFlight, 0);
  assert.equal(manager.statusOf(1), STATUS.DONE);
});

test("out-of-order completions are reorder-buffered, never appended early", async () => {
  const gates = new Map();
  const { manager, log, drain } = makeManager({
    fetch: (seg) => { log.fetched.push(seg.id); const g = deferred(); gates.set(seg.id, g); return g.promise; },
    options: { concurrency: 3 }
  });
  manager.enqueue({ id: 0, uri: "a" });
  manager.enqueue({ id: 1, uri: "b" });
  manager.enqueue({ id: 2, uri: "c" });
  await flush();
  assert.deepEqual(log.fetched, [0, 1, 2], "all three fetch slots open");

  gates.get(2).resolve(BYTE);
  await flush();
  assert.deepEqual(log.appended, [], "seg 2 waits for 0 and 1 to fill the order");
  assert.equal(manager.statusOf(2), STATUS.BUFFERING);

  gates.get(0).resolve(BYTE);
  await flush();
  assert.deepEqual(log.appended, [0], "0 delivered once in order; 1 still pending");

  gates.get(1).resolve(BYTE);
  await drain;
  assert.deepEqual(log.appended, [0, 1, 2]);
});

test("encrypted segments take the DECRYPTING lane before BUFFERING", async () => {
  const { manager, log, sources, drain } = makeManager({
    decrypt: async (seg) => { log.decrypt.push(seg.id); return Uint8Array.of(9); }
  });
  sources.set("e", BYTE);
  manager.enqueue({ id: 0, uri: "e", encrypted: true });
  await drain;
  assert.deepEqual(log.decrypt, [0]);
  const tos = log.events.filter((e) => e.type === "status" && e.id === 0).map((e) => e.to);
  assert.deepEqual(tos, [STATUS.IDLE, STATUS.FETCHING, STATUS.DECRYPTING, STATUS.BUFFERING, STATUS.DONE]);
});

test("encrypted segment without a decrypt seam is skipped, not half-appended", async () => {
  const { manager, log, sources } = makeManager({ options: { maxRetries: 1 } });
  sources.set("e", BYTE);
  manager.enqueue({ id: 0, uri: "e", encrypted: true });
  await flush();
  assert.equal(manager.statusOf(0), STATUS.SKIPPED);
  assert.deepEqual(log.appended, []);
  assert.ok(log.events.some((e) => e.type === "skip" && e.id === 0));
});

test("a non-retryable decrypt failure skips immediately - no retry loop", async () => {
  const { manager, log, sources, drain } = makeManager({
    sources: new Map([["e", BYTE], ["ok", BYTE]]),
    decrypt: async () => { throw new SegmentError("corrupt ciphertext", { retryable: false }); },
    options: { scheduler: (fn) => { log.scheduled.push(fn); }, clock: () => log.now }
  });
  manager.enqueue({ id: 0, uri: "e", encrypted: true });
  manager.enqueue({ id: 1, uri: "ok" });
  await drain;
  assert.equal(manager.statusOf(0), STATUS.SKIPPED);
  const skip = log.events.find((e) => e.type === "skip" && e.id === 0);
  assert.equal(skip.reason, "decode", "non-retryable failures skip as decode faults");
  assert.equal(skip.attempts, 0);
  assert.equal(log.scheduled.length, 0, "never enters retry backoff");
  assert.deepEqual(log.appended, [1], "the stream continues past the corrupt segment");
});

test("bounded retries recover a transient failure on a deterministic backoff", async () => {
  let calls = 0;
  const { manager, log, drain } = makeManager({
    fetch: async () => {
      calls++;
      if (calls < 3) {
        throw new SegmentError("502", { status: 502 });
      }
      return BYTE;
    },
    options: { maxRetries: 3, scheduler: (fn) => { log.scheduled.push(fn); }, clock: () => log.now }
  });
  manager.enqueue({ id: 0, uri: "x" });
  await flush();
  assert.equal(calls, 1, "first fetch failed, retry scheduled - not looped");
  assert.equal(manager.statusOf(0), STATUS.IDLE, "rearmed but in cooling");
  assert.equal(log.scheduled.length, 1);

  log.now += 150;
  log.scheduled.shift()();
  await flush();
  assert.equal(calls, 2, "second attempt happened exactly once");

  log.now += 300;
  log.scheduled.shift()();
  await drain;
  assert.equal(calls, 3);
  assert.deepEqual(log.appended, [0]);
});

test("exhausted retries end FAILED then SKIPPED; later segments still play", async () => {
  const { manager, log, sources, drain } = makeManager({
    sources: new Map([["ok", BYTE]]),
    options: { maxRetries: 2, scheduler: (fn) => { log.scheduled.push(fn); }, clock: () => log.now }
  });
  manager.enqueue({ id: 0, uri: "always-missing" });
  manager.enqueue({ id: 1, uri: "ok" });
  await flush();
  assert.equal(manager.statusOf(0), STATUS.IDLE, "first 404 rearmed for a bounded retry");
  log.scheduled.shift()();
  await flush();
  const skip = log.events.find((e) => e.type === "skip" && e.id === 0);
  assert.equal(skip.reason, "fail");
  assert.equal(skip.attempts, 2);
  assert.equal(manager.statusOf(0), STATUS.SKIPPED);
  await drain;
  assert.deepEqual(log.appended, [1], "the stream continues past the skipped segment");
});

test("403/410 is the normal token-expiry signal: refresh rewrites and re-fetches", async () => {
  const { manager, log, drain } = makeManager({
    fetch: async (seg) => {
      log.fetchedUris.push(seg.uri);
      if (seg.uri === "old-uri") {
        throw new SegmentError("expired", { status: 403 });
      }
      return BYTE;
    },
    refresh: async (seg) => {
      log.refresh.push(seg.uri);
      return { uri: "new-uri" };
    }
  });
  manager.enqueue({ id: 0, uri: "old-uri" });
  await drain;
  assert.deepEqual(log.fetchedUris, ["old-uri", "new-uri"], "refetch uses the refreshed URI");
  assert.deepEqual(log.refresh, ["old-uri"], "one refresh for the stream");
  assert.deepEqual(log.appended, [0]);
  assert.equal(log.scheduled.length, 0, "token path is not a retry backoff");
  assert.equal(log.events.filter((e) => e.type === "refresh").length, 1);
});

test("token refresh is bounded: repeated 403 slides into bounded retries then SKIP", async () => {
  const { manager, log } = makeManager({
    fetch: async () => { throw new SegmentError("expired", { status: 403 }); },
    refresh: async () => { log.refresh++; return { uri: "next" }; },
    options: { maxRefreshes: 2, maxRetries: 1 }
  });
  manager.enqueue({ id: 0, uri: "start" });
  await flush();
  assert.equal(log.refresh, 2, "refresh consulted until maxRefreshes");
  assert.equal(manager.statusOf(0), STATUS.SKIPPED);
  const skip = log.events.find((e) => e.type === "skip" && e.id === 0);
  assert.equal(skip.reason, "fail");
});

test("abort cancels in-flight fetches, abandons queued work, and drains", async () => {
  const { manager, log, drain } = makeManager({
    fetch: (seg, signal) => new Promise((_, reject) => {
      log.fetched.push(seg.id);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  manager.enqueue({ id: 0, uri: "a" });
  manager.enqueue({ id: 1, uri: "b" });
  await flush();
  manager.abort();
  await drain;
  assert.equal(manager.aborted, true);
  assert.equal(manager.statusOf(0), STATUS.SKIPPED);
  assert.equal(manager.statusOf(1), STATUS.SKIPPED);
  assert.equal(manager.inFlight, 0);
  assert.deepEqual(log.appended, []);
  assert.ok(log.events.some((e) => e.type === "abort"));
});

test("destroy is idempotent and tolerates an external abort signal", () => {
  const ac = new AbortController();
  const { manager } = makeManager({ options: { signal: ac.signal } });
  manager.destroy();
  manager.destroy();
  assert.equal(manager.aborted, true);
  ac.abort();
});

test("byte-cap backpressure blocks new fetches until buffered bytes clear", async () => {
  const gates = new Map();
  const { manager, log, sources, drain } = makeManager({
    fetch: (seg) => {
      log.fetched.push(seg.id);
      const g = deferred();
      gates.set(seg.id, g);
      return g.promise;
    },
    options: { concurrency: 4, maxPendingBytes: 25 }
  });
  for (let id = 0; id < 5; id++) {
    manager.enqueue({ id, uri: String(id), byteHint: 10 });
  }
  await flush();
  assert.equal(log.fetched.length, 3, "three in flight (30 bytes) saturate the 25-byte cap");
  assert.equal(manager.pendingBytes, 30);
  assert.equal(manager.statusOf(4), STATUS.IDLE, "the fifth is parked by the cap");

  gates.get(0).resolve(BYTE);
  await flush();
  assert.equal(log.fetched.length, 4, "freeing 10 bytes opens one more fetch");

  for (const [id, gate] of gates) {
    if (!manager.aborted) {
      gate.resolve(BYTE);
    }
  }
  await flush();
  if (gates.has(4)) {
    gates.get(4).resolve(BYTE);
  }
  await drain;
  assert.deepEqual(log.appended, [0, 1, 2, 3, 4]);
  assert.equal(manager.pendingBytes, 0);
});

test("maxQueued caps the reorder buffer; finalized heads free slots", async () => {
  const gates = new Map();
  const { manager, log, drain } = makeManager({
    fetch: (seg) => {
      log.fetched.push(seg.id);
      const g = deferred();
      gates.set(seg.id, g);
      return g.promise;
    },
    options: { concurrency: 4, maxQueued: 3 }
  });
  for (let id = 0; id < 4; id++) {
    manager.enqueue({ id, uri: String(id) });
  }
  await flush();
  assert.deepEqual(log.fetched, [0, 1, 2], "the fourth waits at the reorder cap");
  gates.get(0).resolve(BYTE);
  await flush();
  assert.deepEqual(log.fetched, [0, 1, 2, 3], "a delivered head frees the slot");
  for (const [id, gate] of gates) {
    if (!manager.aborted) {
      gate.resolve(BYTE);
    }
  }
  await drain;
  assert.deepEqual(log.appended, [0, 1, 2, 3]);
});

test("strict ordering (default) waits on a hole and never slides", async () => {
  const { manager, log, sources } = makeManager();
  sources.set("b", BYTE);
  sources.set("c", BYTE);
  manager.enqueue({ id: 1, uri: "b" });
  manager.enqueue({ id: 2, uri: "c" });
  await flush();
  assert.deepEqual(log.appended, []);
  assert.equal(manager.statusOf(1), STATUS.BUFFERING, "later segments buffer behind the hole");
  assert.equal(log.scheduled.length, 0, "strict mode never schedules a gap slide");
});

test("allowGaps slides past stale holes in delivery order (injected clock)", async () => {
  const { manager, log, sources } = makeManager({
    sources: new Map([["c", BYTE]]),
    options: { allowGaps: true, gapTimeoutMs: 100 }
  });
  manager.enqueue({ id: 2, uri: "c" });
  await flush();
  assert.equal(manager.statusOf(2), STATUS.BUFFERING);
  assert.deepEqual(log.appended, []);
  assert.equal(log.scheduled.length, 1, "one gap recheck parked");

  log.now += 100;
  log.scheduled.shift()();
  await flush();
  const skip0 = log.events.find((e) => e.type === "skip" && e.id === 0);
  assert.equal(skip0.reason, "gap", "hole 0 slides after its timeout");
  assert.deepEqual(log.appended, [], "still waiting at the next hole (1)");
  assert.equal(log.scheduled.length, 1);

  log.now += 100;
  log.scheduled.shift()();
  await flush();
  const skip1 = log.events.find((e) => e.type === "skip" && e.id === 1);
  assert.equal(skip1.reason, "gap");
  assert.deepEqual(log.appended, [2], "2 delivers once the holes clear");
});

test("append failures skip the segment and the stream continues", async () => {
  const { manager, log, sources, drain } = makeManager({
    append: async (seg) => {
      if (seg.id === 1) {
        throw new Error("codec mismatch");
      }
      log.appended.push(seg.id);
    }
  });
  sources.set("a", BYTE);
  sources.set("b", BYTE);
  sources.set("c", BYTE);
  manager.enqueue({ id: 0, uri: "a" });
  manager.enqueue({ id: 1, uri: "b" });
  manager.enqueue({ id: 2, uri: "c" });
  await drain;
  assert.deepEqual(log.appended, [0, 2]);
  const skip = log.events.find((e) => e.type === "skip" && e.id === 1);
  assert.equal(skip.reason, "append");
  assert.equal(manager.statusOf(1), STATUS.SKIPPED);
});

test("waitDrain stays pending through retry backoff, then resolves", async () => {
  let calls = 0;
  const { manager, log, drain } = makeManager({
    fetch: async () => {
      calls++;
      if (calls < 2) {
        throw new SegmentError("502", { status: 502 });
      }
      return BYTE;
    },
    options: { maxRetries: 3, scheduler: (fn) => { log.scheduled.push(fn); }, clock: () => log.now }
  });
  manager.enqueue({ id: 0, uri: "x" });
  await flush();
  assert.equal(calls, 1);
  let resolved = false;
  drain.then(() => { resolved = true; });
  assert.equal(resolved, false, "backoff keeps the stream live");
  log.now += 150;
  log.scheduled.shift()();
  await drain;
  assert.equal(resolved, true);
  assert.equal(calls, 2);
  assert.deepEqual(log.appended, [0]);
});

test("pruneThrough drops only finalized bookkeeping", async () => {
  const { manager, sources } = makeManager();
  sources.set("a", BYTE);
  sources.set("b", BYTE);
  manager.enqueue({ id: 0, uri: "a" });
  manager.enqueue({ id: 1, uri: "b" });
  await manager.waitDrain();
  manager.pruneThrough(0);
  assert.equal(manager.statusOf(0), null);
  assert.equal(manager.statusOf(1), STATUS.DONE, "unpruned entries survive");
  manager.pruneThrough(1);
  assert.equal(manager.statusOf(1), null);
});

test("duplicate and out-of-window enqueues are idempotent", async () => {
  const { manager, sources, drain } = makeManager();
  sources.set("a", BYTE);
  assert.equal(manager.enqueue({ id: 0, uri: "a" }), true);
  assert.equal(manager.enqueue({ id: 0, uri: "b" }), true, "duplicate id is absorbed, first uri wins");
  await drain;
  assert.equal(manager.statusOf(0), STATUS.DONE);
  manager.pruneThrough(0);
  manager.enqueue({ id: 0, uri: "late" });
  assert.equal(manager.enqueue({ id: 4, uri: "unset" }), true, "stream is still live after delivery");
  manager.destroy();
});