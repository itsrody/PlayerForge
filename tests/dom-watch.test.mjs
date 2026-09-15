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

/** Simulate a genuinely hidden/visible doc: both primitives must flip. */
function setDocHidden(hidden) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
}

test("hidden document defers dispatch until visibility resumes", async () => {
  setDocHidden(true);
  try {
    let delivered = 0;
    let recordsTotal = 0;
    const off = onDomMutations((records) => {
      delivered++;
      recordsTotal += records.length;
    });

    for (let i = 0; i < 3; i++) {
      document.body.appendChild(document.createElement("span"));
    }
    await tick();
    assert.equal(delivered, 0, "hidden doc never dispatches to subscribers");

    setDocHidden(false);
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(delivered, 1, "resume flushed one coalesced batch");
    assert.ok(recordsTotal >= 3, "all accumulated records arrived in that batch");
    off();
  } finally {
    setDocHidden(false);
  }
});

test("hidden deferral never stalls past the visibility cap", async () => {
  setDocHidden(true);
  try {
    let delivered = 0;
    const off = onDomMutations(() => {
      delivered++;
    });
    document.body.appendChild(document.createElement("span"));
    await tick();
    assert.equal(delivered, 0, "deferred while hidden");

    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(delivered, 1, "cap elapsed - flush landed despite hidden");
    off();
  } finally {
    setDocHidden(false);
  }
});

test("teardown while hidden clears the deferral, and re-subscription re-arms cleanly", async () => {
  setDocHidden(true);
  try {
    let calls = 0;
    const off = onDomMutations(() => {
      calls++;
    });
    document.body.appendChild(document.createElement("span"));
    await tick();
    assert.equal(calls, 0, "batch deferred while hidden");
    off(); // last subscriber leaves while deferred -> teardown clears timer+listener

    setDocHidden(false);
    document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, 0, "no stale dispatch after hidden teardown");

    let calls2 = 0;
    const off2 = onDomMutations(() => {
      calls2++;
    });
    document.body.appendChild(document.createElement("span"));
    await tick();
    assert.equal(calls2, 1, "fresh subscription observes again after hidden teardown");
    off2();
  } finally {
    setDocHidden(false);
  }
});
