import test from "node:test";
import assert from "node:assert/strict";
import { setDebugRuntime } from "../src/shared/diagnostics.js";

/**
 * The jank diagnostic is a debug-only rAF frame-gap watchdog (Gecko has no
 * long-animation-frame entry type - see the module header). These tests drive
 * it off a fake frame clock, so the threshold, the reporting window, the
 * worst-first cap and the teardown flush are all deterministic.
 *
 * `advanceTo` walks the clock in realistic 16ms frames: jumping straight to a
 * timestamp would register as one enormous frame gap and fabricate exactly the
 * jank a test is trying to measure.
 */

/** Run `body` with a stubbed rAF clock; collects the warnings logger emitted. */
function withFrameClock(body) {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  const originalWarn = console.warn;
  /** Pending frames as { id, cb }, mirroring the browser's frame queue. */
  const queued = [];
  const cancelled = [];
  const warnings = [];
  let nextId = 1;
  let clock = 0;
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queued.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const index = queued.findIndex((frame) => frame.id === id);
    if (index !== -1) {
      queued.splice(index, 1);
    }
    cancelled.push(id);
  };
  console.warn = (...args) => warnings.push(args.join(" "));
  /** Deliver one frame at `t`. */
  const step = (t) => {
    clock = t;
    queued.shift().cb(t);
  };
  /** Deliver 16ms frames until the clock reaches `t`. */
  const advanceTo = (t) => {
    while (clock + 16 <= t) {
      step(clock + 16);
    }
  };
  try {
    body({ step, advanceTo, queued, cancelled, warnings });
  } finally {
    setDebugRuntime(false);
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    console.warn = originalWarn;
  }
}

test("debug off: no frame loop is installed", () => {
  withFrameClock(({ queued }) => {
    setDebugRuntime(false);
    assert.equal(queued.length, 0, "rAF untouched while debug is off");
  });
});

test("a slow frame is reported when the reporting window flushes", () => {
  withFrameClock(({ step, advanceTo, warnings }) => {
    setDebugRuntime(true);
    step(0); // seeds the clock
    step(200); // 200ms gap - over the 150ms threshold
    assert.equal(warnings.length, 0, "buffered, not reported mid-window");
    advanceTo(6000); // crosses the window boundary
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /long frame: 200ms/);
  });
});

test("frames under the threshold stay silent", () => {
  withFrameClock(({ step, advanceTo, warnings }) => {
    setDebugRuntime(true);
    step(0);
    step(16);
    step(32);
    advanceTo(6000);
    assert.equal(warnings.length, 0, "a healthy frame cadence reports nothing");
  });
});

test("only the worst few frames of a window are reported, worst first", () => {
  withFrameClock(({ step, advanceTo, warnings }) => {
    setDebugRuntime(true);
    step(0);
    step(200); // 200ms gap
    step(400); // 200ms gap
    step(900); // 500ms gap
    step(1500); // 600ms gap
    step(1700); // 200ms gap
    advanceTo(8000);
    assert.equal(warnings.length, 3, "capped at MAX_REPORT");
    assert.match(warnings[0], /600ms/, "worst frame reported first");
  });
});

test("teardown cancels the pending frame and flushes what was buffered", () => {
  withFrameClock(({ step, queued, cancelled, warnings }) => {
    setDebugRuntime(true);
    step(0);
    step(900);
    assert.equal(warnings.length, 0, "still buffered");
    setDebugRuntime(false);
    assert.equal(warnings.length, 1, "flushed on the way out");
    assert.match(warnings[0], /900ms/);
    assert.equal(queued.length, 0, "no frame left pending");
    assert.equal(cancelled.length, 1, "the pending frame was cancelled");
  });
});
