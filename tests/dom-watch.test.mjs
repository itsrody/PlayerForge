import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.MutationObserver = window.MutationObserver;

const { onDomMutations } = await import("../src/kernel/dom-watch.js");

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
