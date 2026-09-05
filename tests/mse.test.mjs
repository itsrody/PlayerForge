import test from "node:test";
import assert from "node:assert/strict";
import { MSEFactory, MediaSink } from "../src/shell/proxy/mse.js";
import { SegmentError } from "../src/shell/proxy/segment-manager.js";

class FakeSourceBuffer {
  constructor(mime) {
    this.mimeType = mime;
    this.updating = false;
    this.records = [];
    this.windowsAtAppend = [];
    this.listeners = {};
    this.appendWindowStart = 0;
    this.appendWindowEnd = Infinity;
    this.#quotaAfter = 0;
  }

  #quotaAfter = 0;
  setQuotaAfter(n) {
    this.#quotaAfter = n;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  emit(type) {
    for (const fn of this.listeners[type] ?? []) fn();
  }

  appendBuffer(bytes) {
    if (this.#quotaAfter > 0) {
      this.#quotaAfter--;
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    }
    this.records.push([...bytes]);
    this.windowsAtAppend.push({
      start: this.appendWindowStart,
      end: this.appendWindowEnd
    });
    this.updating = true;
  }

  finishAppend() {
    this.updating = false;
    this.emit("updateend");
  }

  abort() {
    this.updating = false;
    this.emit("abort");
  }
}

class FakeMediaSource {
  constructor() {
    this.readyState = "closed";
    this.sourceBuffers = [];
    this.listeners = {};
    this.ended = false;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  emit(type) {
    for (const fn of this.listeners[type] ?? []) fn();
  }

  addSourceBuffer(mime) {
    const sb = new FakeSourceBuffer(mime);
    this.sourceBuffers.push(sb);
    return sb;
  }

  endOfStream() {
    this.ended = true;
    this.readyState = "ended";
  }
}

function hangar() {
  const ms = new FakeMediaSource();
  const revoked = [];
  const created = [];
  const seams = {
    mediaSource: ms,
    createObjectURL: (m) => {
      created.push(m);
      return "blob:pf-test";
    },
    revokeObjectURL: (u) => revoked.push(u),
    delay: async () => {}
  };
  const video = { src: null };
  return { seams, ms, video, revoked, created };
}

async function settleAppend(sb) {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
    if (sb.updating) break;
  }
  if (sb.updating) sb.finishAppend();
}

test("create() opens the MediaSource, attaches the object URL, resolves after sourceopen", async () => {
  const { seams, ms, video, created } = hangar();
  const factory = new MSEFactory(seams);
  let stateSeen = [];
  const createPromise = factory.create({ video, mimeType: 'video/mp4; codecs="avc1"', onStateChange: (s) => stateSeen.push(s) });
  assert.equal(video.src, "blob:pf-test", "object URL is attached before sourceopen resolves");
  assert.equal(created.length, 1);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await createPromise;
  assert.equal(sink.readyState, "open");
  assert.equal(sink.objectURL, "blob:pf-test");
  assert.ok(sink instanceof MediaSink);
});

test("enqueue lands segments in strict order, one updateend at a time", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const first = sink.enqueue(1, Uint8Array.from([10, 11]));
  const sb = ms.sourceBuffers[0];
  assert.ok(sb, "source buffer created synchronously by enqueue");
  assert.equal(sb.records.length, 0, "append happens on the chain, not synchronously in enqueue");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sb.updating, true, "first append started");
  sb.finishAppend();
  await first;

  const second = sink.enqueue(2, Uint8Array.from([20, 21]));
  await Promise.resolve();
  await Promise.resolve();
  sb.finishAppend();
  await second;

  assert.deepEqual(sb.records, [[10, 11], [20, 21]]);
});

test("a second enqueue while the lane is updating waits for the first updateend (serial append)", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const first = sink.enqueue(1, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sb.updating, true);

  const second = sink.enqueue(2, Uint8Array.from([2]));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sb.records.length, 1, "second never appends before first updateend");
  assert.equal(sb.updating, true);

  sb.finishAppend();
  await first;
  assert.equal(sb.records.length, 1, "still one record right after first updateend");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sb.updating, true, "second append now in flight");
  sb.finishAppend();
  await second;
  assert.deepEqual(sb.records, [[1], [2]]);
});

test("appendWindowStart/End are applied for the append and reset after updateend", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const p = sink.enqueue(7, Uint8Array.from([3]), { startTime: 1.25, endTime: 2.5 });
  const sb = ms.sourceBuffers[0];
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sb.windowsAtAppend, [{ start: 1.25, end: 2.5 }]);
  sb.finishAppend();
  await p;
  assert.equal(sb.appendWindowStart, 0, "window reset to 0 after the append");
  assert.equal(sb.appendWindowEnd, Infinity, "window reset to Infinity after the append");
});

test("duplicate and out-of-order enqueues are refused non-retryably", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const first = sink.enqueue(3, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  await Promise.resolve();
  await Promise.resolve();
  sb.finishAppend();
  await first;
  await assert.rejects(
    sink.enqueue(3, Uint8Array.from([2])),
    (err) => err instanceof SegmentError && err.retryable === false && /duplicate/.test(err.message)
  );
  await assert.rejects(
    sink.enqueue(2, Uint8Array.from([3])),
    (err) => err instanceof SegmentError && err.retryable === false && /out-of-order/.test(err.message)
  );
});

test("QuotaExceededError backs off and retries until the append lands", async () => {
  const { seams, ms, video } = hangar();
  const delays = [];
  const factory = new MSEFactory({ ...seams, delay: async (ms) => delays.push(ms) });
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const p = sink.enqueue(1, Uint8Array.from([9]));
  const sb = ms.sourceBuffers[0];
  sb.setQuotaAfter(2);
  for (let i = 0; i < 10 && sb.records.length === 0; i++) await Promise.resolve();
  assert.equal(sb.records.length, 1, "third attempt succeeds after two quota strikes");
  assert.deepEqual(delays.slice(0, 2), [2, 4], "backoff doubles per quota strike");
  sb.finishAppend();
  await p;
});

test("a non-quota appendBuffer error surfaces as a non-retryable SegmentError", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });
  const p = sink.enqueue(1, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  sb.appendBuffer = () => {
    const err = new Error("codec spew");
    err.name = "NotSupportedError";
    throw err;
  };
  await assert.rejects(
    p,
    (err) => err instanceof SegmentError && err.retryable === false && /appendBuffer failed/.test(err.message)
  );
});

test("addSourceBuffer failure is a non-retryable SegmentError", async () => {
  const { seams, ms, video } = hangar();
  ms.addSourceBuffer = () => {
    const err = new Error("mime not supported");
    err.name = "NotSupportedError";
    throw err;
  };
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="bogus"' });
  await assert.rejects(
    sink.enqueue(1, Uint8Array.from([1])),
    (err) => err instanceof SegmentError && err.retryable === false && /addSourceBuffer/.test(err.message)
  );
});

test("end() signals endOfStream once", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });
  sink.end();
  sink.end();
  assert.equal(ms.ended, true);
  assert.equal(sink.readyState, "ended");
});

test("destroy() revokes the URL, aborts the in-flight append, and refuses further enqueues", async () => {
  const { seams, ms, video, revoked } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"' });

  const first = sink.enqueue(1, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sb.updating, true, "append in flight before destroy");

  sink.destroy();
  assert.deepEqual(revoked, ["blob:pf-test"]);
  await first;
  await assert.rejects(
    sink.enqueue(2, Uint8Array.from([2])),
    (err) => err instanceof SegmentError && err.retryable === false && /sink destroyed/.test(err.message)
  );
  assert.equal(sb.records.length, 1, "the aborted append's bytes still landed");
});

test("destroy() is idempotent and fires no second state change", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const states = [];
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1"', onStateChange: (s) => states.push(s) });
  sink.destroy();
  sink.destroy();
  assert.deepEqual(states.map((s) => s.type), ["destroyed"]);
});

test("setInit appends the init segment before the first media fragment", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1."' });

  const INIT = Uint8Array.from([77, 68, 65, 84]);
  sink.setInit(INIT, { mimeType: 'video/mp4; codecs="avc1."' });
  const p = sink.enqueue(1, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  await settleAppend(sb);
  await settleAppend(sb);
  await p;

  assert.deepEqual(sb.records, [[...INIT], [1]], "init lands first, then the fragment");
  assert.equal(sb.windowsAtAppend[0].start, 0, "init append uses the default window");
});

test("setInit re-arms a lane when the init bytes change (re-init before next fragment)", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1."' });

  const first = sink.setInit(Uint8Array.from([1, 2, 3]));
  let enq = sink.enqueue(1, Uint8Array.from([10]));
  const sb = ms.sourceBuffers[0];
  await settleAppend(sb);
  await settleAppend(sb);
  await enq;

  const second = sink.setInit(Uint8Array.from([4, 5, 6]), { mimeType: 'video/mp4; codecs="avc1."' });
  enq = sink.enqueue(2, Uint8Array.from([20]));
  await settleAppend(sb);
  await settleAppend(sb);
  await enq;

  assert.deepEqual(sb.records, [[1, 2, 3], [10], [4, 5, 6], [20]], "new init bytes re-appear before the next fragment");
});

test("setInit null clears the lane init expectation", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1."' });

  sink.setInit(Uint8Array.from([9]));
  sink.setInit(null, { mimeType: 'video/mp4; codecs="avc1."' });
  const p = sink.enqueue(1, Uint8Array.from([1]));
  const sb = ms.sourceBuffers[0];
  await settleAppend(sb);
  await p;
  assert.deepEqual(sb.records, [[1]], "no init append after clearing");
});

test("separate mimeType lanes get their own init and ordering", async () => {
  const { seams, ms, video } = hangar();
  const factory = new MSEFactory(seams);
  ms.readyState = "open";
  ms.emit("sourceopen");
  const sink = await factory.create({ video, mimeType: 'video/mp4; codecs="avc1."' });

  sink.setInit(Uint8Array.from([11]), { mimeType: 'video/mp4; codecs="avc1."' });
  sink.setInit(Uint8Array.from([22]), { mimeType: 'audio/mp4; codecs="mp4a.40.2"' });
  const v = sink.enqueue(1, Uint8Array.from([1]), { mimeType: 'video/mp4; codecs="avc1."' });
  const a = sink.enqueue(1, Uint8Array.from([2]), { mimeType: 'audio/mp4; codecs="mp4a.40.2"' });

  const sbv = ms.sourceBuffers[0];
  const sba = ms.sourceBuffers[1];
  await settleAppend(sbv);
  await settleAppend(sbv);
  await v;
  await settleAppend(sba);
  await settleAppend(sba);
  await a;

  assert.deepEqual(sbv.records, [[11], [1]], "video lane: init then fragment");
  assert.deepEqual(sba.records, [[22], [2]], "audio lane: its own init then fragment");
});

test("MSEFactory refuses a missing MediaSource seam", () => {
  assert.throws(() => new MSEFactory({ mediaSource: undefined }), TypeError);
});

test("a lane mime the engine cannot demux is rejected before addSourceBuffer", async () => {
  class PickyMediaSource extends FakeMediaSource {
    static isTypeSupported(mime) {
      return mime === "video/mp4";
    }
  }
  const ms = new PickyMediaSource();
  const factory = new MSEFactory({
    mediaSource: PickyMediaSource,
    createObjectURL: () => "blob:pf-picky",
    revokeObjectURL: () => {},
    delay: async () => {}
  });
  const sink = new MediaSink({
    mediaSource: ms,
    objectURL: "blob:pf-picky",
    mimeType: "video/mp4",
    seams: factory,
    onStateChange: () => {}
  });
  await assert.rejects(
    sink.enqueue(0, new Uint8Array([1]), { mimeType: "audio/mp4" }),
    (err) => err instanceof SegmentError && /unsupported mime type/.test(err.message),
    "a mime isTypeSupported flags as false throws before addSourceBuffer"
  );
  assert.equal(ms.sourceBuffers.length, 0, "no SourceBuffer was created for the unsupported mime");
  const pending = sink.enqueue(0, new Uint8Array([2]));
  await settleAppend(ms.sourceBuffers[0]);
  assert.deepEqual(ms.sourceBuffers[0].records, [[2]], "a supported mime still creates its lane");
  await pending;
});