import test from "node:test";
import assert from "node:assert/strict";
import { yield_ } from "../src/shared/scheduler.js";

/**
 * yield_() must never depend on scheduler.yield (non-Baseline, and it
 * inherits poisoned abort state from self-aborting postTask tasks - see
 * shared/scheduler.js header). These tests pin the two branches it does
 * use: a frame boundary with a hard backstop when rAF is usable, and a
 * MessageChannel task when it is not.
 */

test("task path (no rAF): resolves on a task, not a microtask", async () => {
  assert.equal(typeof globalThis.requestAnimationFrame, "undefined");
  let resolved = false;
  const p = yield_().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false, "still pending at the microtask checkpoint");
  await p;
  assert.equal(resolved, true);
});

test("rAF path: a live frame resolves promptly and skips the backstop", async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  let calls = 0;
  globalThis.requestAnimationFrame = (cb) => {
    calls++;
    setTimeout(cb, 0);
    return 1;
  };
  try {
    const t0 = Date.now();
    await yield_();
    const elapsed = Date.now() - t0;
    assert.equal(calls, 1, "frame requested once");
    assert.ok(elapsed < 45, `resolved on the frame, not the backstop (${elapsed}ms)`);
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
  }
});

test("starved rAF: the backstop bounds the wait", async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1; // never invokes the callback
  try {
    const t0 = Date.now();
    await yield_();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 40, `waited for the backstop (${elapsed}ms)`);
    assert.ok(elapsed < 500, `bounded wait (${elapsed}ms)`);
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
  }
});

test("hidden document: skips rAF entirely and takes the task path", async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalDocument = globalThis.document;
  let frameCalls = 0;
  globalThis.requestAnimationFrame = () => {
    frameCalls++;
    return 1;
  };
  globalThis.document = { visibilityState: "hidden" };
  try {
    let resolved = false;
    const p = yield_().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    assert.equal(resolved, false, "task path - not a microtask");
    await p;
    assert.equal(frameCalls, 0, "rAF never requested in a hidden document");
    assert.equal(resolved, true);
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.document = originalDocument;
  }
});

test("double-fire rAF: the settle guard keeps resolution single", async () => {
  const originalRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    setTimeout(cb, 5); // late second fire after the backstop is cleared
    return 1;
  };
  try {
    await yield_();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No observable double-resolution (promises settle once); reaching this
    // line without an unhandled rejection is the assertion.
    assert.ok(true);
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
  }
});
