import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
// jsdom validates addEventListener's `signal` against its own AbortSignal.
globalThis.AbortController = window.AbortController;

const { createActivity } = await import("../src/shared/activity.js");

/**
 * A target plus the mutable platform state an activity derives from, so the
 * test owns the "Gecko property" the activity reads. `onEnter` attaches a
 * `tick` listener to the work scope, which is exactly the kind of work a real
 * consumer does - if the scope is disposed, the tick must go silent.
 */
function harness(initial = false) {
  const target = document.createElement("div");
  const state = { running: initial };
  const log = [];
  const owner = new AbortController();
  const activity = createActivity({
    target,
    events: ["start", "stop", "progress"],
    isActive: () => state.running,
    onEnter: (work) => {
      log.push("enter");
      target.addEventListener("tick", () => log.push("tick"), { signal: work.signal });
      work.onDispose(() => log.push("work:dispose"));
    },
    onExit: () => log.push("exit"),
    signal: owner.signal
  });
  return { target, state, log, owner, activity };
}

const fire = (target, type) => target.dispatchEvent(new window.Event(type));

test("starts passive: no work until the platform says it is running", () => {
  const { log, activity } = harness(false);
  assert.deepEqual(log, []);
  assert.equal(activity.active, false);
});

test("seeds active from the property when the state is already true", () => {
  const { log, activity } = harness(true);
  assert.deepEqual(log, ["enter"]);
  assert.equal(activity.active, true);
});

test("entering mints a work scope; leaving disposes it and detaches its listeners", () => {
  const { target, state, log, activity } = harness(false);

  state.running = true;
  fire(target, "start");
  assert.equal(activity.active, true);
  assert.deepEqual(log, ["enter"]);
  fire(target, "tick");
  assert.deepEqual(log, ["enter", "tick"], "work listener is live while active");

  state.running = false;
  fire(target, "stop");
  assert.equal(activity.active, false);
  assert.deepEqual(log, ["enter", "tick", "work:dispose", "exit"], "scope dies before the flush");
  fire(target, "tick");
  assert.deepEqual(log, ["enter", "tick", "work:dispose", "exit"], "no work survives the window");
});

test("transitions are edges: a duplicate start does not re-enter", () => {
  const { target, state, log } = harness(false);
  state.running = true;
  fire(target, "start");
  fire(target, "start");
  fire(target, "progress");
  assert.deepEqual(log, ["enter"]);
  state.running = false;
  fire(target, "stop");
  fire(target, "stop");
  assert.deepEqual(log, ["enter", "work:dispose", "exit"]);
});

test("a second window mints a fresh work scope", () => {
  const { target, state, log, activity } = harness(false);

  state.running = true;
  fire(target, "start");
  state.running = false;
  fire(target, "stop");

  state.running = true;
  fire(target, "start");
  fire(target, "tick");
  assert.equal(activity.active, true);
  assert.deepEqual(log, ["enter", "work:dispose", "exit", "enter", "tick"]);
  assert.equal(
    log.filter((entry) => entry === "work:dispose").length,
    1,
    "the first window's scope is disposed exactly once"
  );
});

test("refresh re-reads the property when no event announced the change", () => {
  const { log, state, activity } = harness(false);
  state.running = true;
  activity.refresh();
  assert.deepEqual(log, ["enter"]);
  state.running = false;
  activity.refresh();
  assert.deepEqual(log, ["enter", "work:dispose", "exit"]);
  activity.refresh();
  assert.deepEqual(log, ["enter", "work:dispose", "exit"], "a redundant refresh is a no-op");
});

test("an owner abort tears down the work and the detection listeners", () => {
  const { target, state, log, owner, activity } = harness(false);
  state.running = true;
  fire(target, "start");
  assert.equal(activity.active, true);

  owner.abort();
  assert.equal(activity.active, false);
  assert.deepEqual(log, ["enter", "work:dispose"], "no exit flush on abort - the owner is gone");
  fire(target, "start");
  assert.deepEqual(log, ["enter", "work:dispose"], "detection listener was removed by the signal");
});

test("a disposed activity cannot re-enter through a stale event or refresh", () => {
  const { target, state, log, activity } = harness(false);
  state.running = true;
  fire(target, "start");
  activity.dispose();
  assert.equal(activity.active, false);
  assert.deepEqual(log, ["enter", "work:dispose"]);

  // The property still says "running": a stale event or a late refresh must
  // not mint a second window behind dispose's back.
  activity.refresh();
  fire(target, "start");
  assert.equal(activity.active, false);
  assert.deepEqual(log, ["enter", "work:dispose"]);
});

test("dispose removes every detection listener, exactly once", () => {
  const removed = [];
  const target = {
    addEventListener() {},
    removeEventListener(type) {
      removed.push(type);
    }
  };
  const activity = createActivity({
    target,
    events: ["play", "pause"],
    isActive: () => false
  });
  activity.dispose();
  activity.dispose();
  assert.deepEqual(removed, ["play", "pause"], "each listener is removed once, on the first dispose");
});

test("an abort that arrives before enter does not open a window", () => {
  const owner = new AbortController();
  owner.abort();
  const target = document.createElement("div");
  let entered = 0;
  const activity = createActivity({
    target,
    events: ["start"],
    isActive: () => true,
    onEnter: () => entered++,
    signal: owner.signal
  });
  assert.equal(entered, 0, "cannot enter into an aborted owner scope");
  assert.equal(activity.active, false);
});
