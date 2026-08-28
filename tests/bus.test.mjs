import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { EventBus } = await import("../src/kernel/bus.js");

function makeEnv() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://example.com/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

test("audit is inert (zero cost) when debug is off", () => {
  makeEnv();
  const bus = new EventBus();
  bus.emit("a", { x: 1 });
  bus.emit("b", { y: 2 });
  const summary = bus.auditSummary();
  assert.deepEqual(summary, { emits: 0, allocs: 0, byType: {} });
});

test("audit tallies two young allocations per emit by type when debug is on", () => {
  makeEnv();
  const bus = new EventBus();
  bus.debug = true;
  bus.emit("progress", { t: 1 });
  bus.emit("progress", { t: 2 });
  bus.emit("ended", {});
  const summary = bus.auditSummary();
  assert.equal(summary.emits, 3);
  assert.equal(summary.allocs, 6);
  assert.deepEqual(summary.byType.progress, { emits: 2, allocs: 4 });
  assert.deepEqual(summary.byType.ended, { emits: 1, allocs: 2 });
});

test("resetAudit zeroes tallies but keeps the audit armed", () => {
  makeEnv();
  const bus = new EventBus();
  bus.debug = true;
  bus.emit("a", {});
  bus.resetAudit();
  assert.deepEqual(bus.auditSummary(), { emits: 0, allocs: 0, byType: {} });
  bus.emit("b", {});
  assert.equal(bus.auditSummary().emits, 1);
});

test("disabling debug clears the audit and returns snapshots to zero", () => {
  makeEnv();
  const bus = new EventBus();
  bus.debug = true;
  bus.emit("a", {});
  bus.debug = false;
  assert.equal(bus.auditSummary().allocs, 0);
  bus.emit("a", {});
  assert.equal(bus.auditSummary().allocs, 0);
});

test("window rolls over and auto-log is disabled but tallies still accumulate", () => {
  makeEnv();
  const bus = new EventBus();
  bus.debug = true;
  // Push past the AUDIT_WINDOW so the auto-summary fires (logging is gated on
  // console output only; tallies continue within the fresh window).
  for (let i = 0; i < 220; i++) {
    bus.emit("tick", { i });
  }
  const summary = bus.auditSummary();
  assert.equal(summary.emits, 20);
  assert.equal(summary.allocs, 40);
});
