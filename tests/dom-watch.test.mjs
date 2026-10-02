import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.MutationObserver = window.MutationObserver;
// jsdom validates addEventListener's `signal` against its own AbortSignal
// class; the deferred-flush visibility listener must resolve to it too.
globalThis.AbortController = window.AbortController;

const { onDomMutations } = await import("../src/shared/dom-watch.js");

function tick() {
  return new Promise((resolve) => queueMicrotask(() => setTimeout(resolve, 0)));
}

test("fan-out delivers coalesced records to every subscriber", async () => {
  const seen = [];
  const offA = onDomMutations((records) => seen.push(["a", records.length]));
  const offB = onDomMutations((records) => seen.push(["b", records.length]));

  const div = document.createElement("div");
  document.body.appendChild(div);
  await tick();

  assert.equal(seen.filter(([who]) => who === "a").length, 1);
  assert.equal(seen.filter(([who]) => who === "b").length, 1);
  offA();
  offB();
});

test("multiple mutations in one task arrive as one batch", async () => {
  let calls = 0;
  let total = 0;
  const off = onDomMutations((records) => {
    calls++;
    total += records.length;
  });
  for (let i = 0; i < 5; i++) {
    document.body.appendChild(document.createElement("span"));
  }
  await tick();
  assert.equal(calls, 1);
  assert.ok(total >= 5);
  off();
});

test("unsubscribe tears the observer down when the last subscriber leaves", async () => {
  let calls = 0;
  const off = onDomMutations(() => {
    calls++;
  });
  off();

  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 0);

  // Re-subscribing after full teardown must observe again.
  let calls2 = 0;
  const off2 = onDomMutations(() => {
    calls2++;
  });
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls2, 1);
  off2();
});

test("a throwing subscriber never aborts delivery to its peers [uBO safeObserverHandler rule]", async () => {
  const delivered = [];
  const offBad = onDomMutations(() => {
    throw new Error("consumer bug");
  });
  const offGood = onDomMutations((records) => {
    delivered.push(records.length);
  });

  document.body.appendChild(document.createElement("span"));
  await tick();

  assert.ok(delivered.length >= 1, "the healthy peer still received the batch");

  offBad();
  offGood();
});

test("every flush delivers only its own batch (recycled buffers are drained)", async () => {
  const batches = [];
  const off = onDomMutations((records) => batches.push(records.length));
  // One mutation + flush per round: the pool swaps buffers between flushes, so
  // any buffer that is re-armed without being emptied re-delivers records from
  // an earlier round alongside the current one.
  for (let round = 0; round < 5; round++) {
    document.body.appendChild(document.createElement("span"));
    await tick();
  }
  off();
  assert.deepEqual(batches, [1, 1, 1, 1, 1]);
});

test("unsubscribe still works after slot compaction (identity-stable handles)", async () => {
  // Regression: off() used to close over the subscribe-time index. With 5
  // subscribers and 4 gone, the next flush compacts (5 > 1*4), moving the
  // survivor from index 4 to index 0 - after which the survivor's off()
  // wrote to a stale index, no-opped, and left a zombie subscriber (and the
  // document observer) running forever.
  const counts = { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0 };
  const offs = Object.keys(counts).map((id) => onDomMutations(() => counts[id]++));
  for (let i = 0; i < 4; i++) {
    offs[i]();
  }

  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(counts.s4, 1, "survivor received the pre-compaction batch");
  // End of that flush: compaction ran, survivor slot moved to index 0.

  offs[4]();
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(counts.s4, 1, "survivor stopped after its off() at the compacted position");

  // Double-off must be inert, and post-compaction subscribers must survive
  // the old handle (a positional off() would tombstone their slot instead).
  let fresh = 0;
  const offFresh = onDomMutations(() => fresh++);
  offs[4]();
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(fresh, 1, "post-compaction subscriber keeps receiving");
  assert.equal(counts.s4, 1, "zombie never resurrects");
  offFresh();
});

test("an already-aborted signal is a no-op subscription", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const off = onDomMutations(() => { calls++; }, { signal: ac.signal });
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 0, "aborted subscription never observes");
  off(); // inert handle
});
