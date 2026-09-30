import test from "node:test";
import assert from "node:assert/strict";
import { setDebugRuntime } from "../src/shared/diagnostics.js";

/**
 * The jank diagnostic is a debug-only rAF frame-gap watchdog (Gecko has no
 * long-animation-frame entry type - see the module header), paired with a
 * debug-only Event Timing observer for interaction latency. These tests drive
 * the frame half off a fake frame clock and the observer half off a fake
 * PerformanceObserver, so thresholds, the reporting window, the worst-first cap,
 * the interactionId grouping and the teardown flush are all deterministic.
 *
 * `advanceTo` walks the clock in realistic 16ms frames: jumping straight to a
 * timestamp would register as one enormous frame gap and fabricate exactly the
 * jank a test is trying to measure.
 *
 * The observer fake is necessary rather than incidental: node's own
 * `supportedEntryTypes` has no `event` entry, so the real PerformanceObserver
 * can never install here. That also means these tests would stay green if the
 * install path silently broke - the fake asserts the subscribe explicitly.
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

/* - Event Timing - */

/**
 * Run `body` with a fake PerformanceObserver. `supportedEntryTypes` is
 * settable per-test so the "engine has no event timing" path is reachable.
 * `emit` delivers entries to the live observer the way the browser would.
 */
function withEventObserver(body, { supported = ["event"] } = {}) {
  const originalPO = globalThis.PerformanceObserver;
  const originalWarn = console.warn;
  const instances = [];
  const warnings = [];

  globalThis.PerformanceObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.options = null;
      this.disconnected = false;
      instances.push(this);
    }
    observe(options) {
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  Object.defineProperty(globalThis.PerformanceObserver, "supportedEntryTypes", {
    value: supported,
    configurable: true
  });
  console.warn = (...args) => warnings.push(args.join(" "));

  /** Deliver entries to every still-connected observer. */
  const emit = (...entries) => {
    for (const inst of instances) {
      if (!inst.disconnected) {
        inst.cb(entries, inst);
      }
    }
  };

  try {
    body({ emit, instances, warnings });
  } finally {
    setDebugRuntime(false);
    globalThis.PerformanceObserver = originalPO;
    console.warn = originalWarn;
  }
}

test("debug off: no Event Timing observer is constructed", () => {
  withEventObserver(({ instances }) => {
    setDebugRuntime(false);
    assert.equal(instances.length, 0, "no observer while debug is off");
  });
});

test("debug on: subscribes to event timing with buffered entries", () => {
  withEventObserver(({ instances }) => {
    setDebugRuntime(true);
    assert.equal(instances.length, 1, "exactly one observer");
    assert.deepEqual(instances[0].options, {
      type: "event",
      durationThreshold: 16,
      buffered: true
    });
  });
});

test("a slow interaction is reported when the reporting window flushes", () => {
  withEventObserver(({ emit, warnings }) => {
    setDebugRuntime(true);
    emit({ interactionId: 7, duration: 450, name: "pointerdown" });
    assert.equal(warnings.length, 0, "buffered, not reported immediately");
    // No rAF here, so drive the flush the way the frame loop would.
    setDebugRuntime(false);
    assert.equal(warnings.length, 1, "flushed on teardown");
    assert.match(warnings[0], /slow interaction: 450ms \(pointerdown\)/);
  });
});

test("the four events of one interaction report once, as the worst of them", () => {
  withEventObserver(({ emit, warnings }) => {
    setDebugRuntime(true);
    // keydown is fast; the pointerup that finishes the click is the slow one.
    emit({ interactionId: 12, duration: 40, name: "keydown" });
    emit({ interactionId: 12, duration: 300, name: "pointerup" });
    emit({ interactionId: 12, duration: 120, name: "click" });
    setDebugRuntime(false);
    assert.equal(warnings.length, 1, "one interaction, one line");
    assert.match(warnings[0], /slow interaction: 300ms \(pointerup\)/);
  });
});

test("interactions under the INP threshold and entries without an id stay silent", () => {
  withEventObserver(({ emit, warnings }) => {
    setDebugRuntime(true);
    emit({ interactionId: 1, duration: 199, name: "pointerup" });
    // A lone keyup with no interactionId carries no latency verdict.
    emit({ duration: 900, name: "keyup" });
    setDebugRuntime(false);
    assert.equal(warnings.length, 0, "nothing reportable was buffered");
  });
});

test("only the worst few interactions are reported, worst first", () => {
  withEventObserver(({ emit, warnings }) => {
    setDebugRuntime(true);
    emit({ interactionId: 1, duration: 250, name: "pointerdown" });
    emit({ interactionId: 2, duration: 800, name: "pointerup" });
    emit({ interactionId: 3, duration: 500, name: "click" });
    emit({ interactionId: 4, duration: 300, name: "pointerdown" });
    setDebugRuntime(false);
    assert.equal(warnings.length, 3, "capped at MAX_REPORT");
    assert.match(warnings[0], /800ms/);
    assert.match(warnings[1], /500ms/);
    assert.match(warnings[2], /300ms/);
  });
});

test("teardown disconnects the observer", () => {
  withEventObserver(({ instances, emit, warnings }) => {
    setDebugRuntime(true);
    setDebugRuntime(false);
    assert.equal(instances[0].disconnected, true, "observer released on the way out");
    // Post-teardown entries must not resurrect the diagnostic.
    emit({ interactionId: 99, duration: 900, name: "pointerup" });
    assert.equal(warnings.length, 0, "disconnected observer receives nothing");
  });
});

test("an engine without event timing installs nothing and never throws", () => {
  withEventObserver(({ instances, warnings }) => {
    setDebugRuntime(true);
    assert.equal(instances.length, 0, "skipped cleanly, no observer");
    setDebugRuntime(false);
    assert.equal(warnings.length, 0);
  }, { supported: ["mark", "measure"] });
});

test("the observer survives a context with no requestAnimationFrame", () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalWarn = console.warn;
  delete globalThis.requestAnimationFrame;
  try {
    withEventObserver(({ instances, emit, warnings }) => {
      setDebugRuntime(true);
      assert.equal(instances.length, 1, "event timing does not depend on rAF");
      emit({ interactionId: 3, duration: 640, name: "pointerup" });
      setDebugRuntime(false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /slow interaction: 640ms/);
    });
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
    console.warn = originalWarn;
  }
});
