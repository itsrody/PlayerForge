import test from "node:test";
import assert from "node:assert/strict";

const { EventBus } = await import("../src/kernel/bus.js");
const { logger } = await import("../src/shared/logger.js");

function createDebugBus() {
  const bus = new EventBus();
  bus.debug = true;
  return bus;
}

function logHas(logs, pattern) {
  return logs.some((args) => args.some((a) => typeof a === "string" && pattern.test(a)));
}

test("sampled type aggregates emits within a 1 s window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = createDebugBus();
  logger.enable();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);

  bus.emit("pf:shell-timeupdate", { shellId: "a", event: null });
  bus.emit("pf:shell-timeupdate", { shellId: "a", event: null });
  bus.emit("pf:shell-timeupdate", { shellId: "a", event: null });

  assert.equal(logs.length, 0, "no log before flush");

  t.mock.timers.tick(1000);

  assert.ok(logHas(logs, /sampled/), "aggregate line emitted after flush");
  assert.ok(logHas(logs, /×3/), "count matches emit count");

  console.log = orig;
  logger.disable();
  t.mock.timers.reset();
});

test("non-sampled type logs immediately without aggregation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = createDebugBus();
  logger.enable();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);

  bus.emit("pf:shell-play", { shellId: "a", event: null });

  assert.ok(logHas(logs, /pf:shell-play/), "non-sampled event logged synchronously");

  t.mock.timers.tick(1000);
  console.log = orig;
  logger.disable();
  t.mock.timers.reset();
});

test("disabling debug flushes pending aggregate silently", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = createDebugBus();
  logger.enable();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);

  bus.emit("pf:shell-timeupdate", { shellId: "a", event: null });
  bus.debug = false;

  // debug off drops the pending count — no aggregate logged.
  assert.ok(!logHas(logs, /sampled/), "no aggregate after debug off");

  console.log = orig;
  logger.disable();
  t.mock.timers.reset();
});

test("single emit flushes ×1 after 1 s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = createDebugBus();
  logger.enable();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);

  bus.emit("pf:shell-timeupdate", { shellId: "a", event: null });
  t.mock.timers.tick(1000);

  assert.equal(logs.length, 1, "exactly one aggregate line");
  assert.ok(logHas(logs, /×1/), "single emit counted as ×1");

  console.log = orig;
  logger.disable();
  t.mock.timers.reset();
});
