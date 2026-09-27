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
