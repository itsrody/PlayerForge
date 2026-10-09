import test from "node:test";
import assert from "node:assert/strict";

const { RenderGate } = await import("../src/shared/render.js");

/**
 * L4, the primitive half of phase 3. What is pinned here is the §5 invariant
 * list as it applies to the gate itself: one commit per state transition
 * (counted, not asserted), no self-rearming postTask, and priorities that
 * route rather than queue.
 *
 * Tasks run on the timer-backed polyfill from tests/loader.mjs, so "one tick"
 * is one macrotask turn; `flush()` waits long enough to cover a task that was
 * aborted and rescheduled at a higher priority (which is a *new* timer).
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Record the priority every postTask in the file is scheduled at. The facade
 * reads `globalThis.scheduler.postTask` at call time, so patching the property
 * is enough to see what RenderGate actually asked for.
 */
function recordPriorities() {
  const seen = [];
  const original = globalThis.scheduler.postTask;
  globalThis.scheduler.postTask = (fn, opts = {}) => {
    seen.push(opts.priority);
    return original(fn, opts);
  };
  return {
    seen,
    restore() {
      globalThis.scheduler.postTask = original;
    }
  };
}

test("N requests in one tick are one commit", async () => {
  let runs = 0;
  const gate = new RenderGate({ commit: () => { runs += 1; } });

  assert.equal(gate.commits, 0, "nothing scheduled, nothing committed");
  assert.equal(gate.pending, false);

  const scheduled = [
    gate.request("user-visible"),
    gate.request("user-visible"),
    gate.request("user-visible"),
    gate.request("user-visible"),
    gate.request("user-visible")
  ];
  assert.deepEqual(scheduled, [true, false, false, false, false],
    "only the first request schedules; the rest coalesce into it");
  assert.equal(gate.pending, true);
  assert.equal(runs, 0, "the commit is not inline");

  await flush();
  assert.equal(runs, 1, "one commit for five requests");
  assert.equal(gate.commits, 1, "the §5 counter agrees");
  assert.equal(gate.pending, false);

  gate.request();
  await flush();
  assert.equal(runs, 2, "the gate is reusable after a commit");
  assert.equal(gate.commits, 2);
  gate.dispose();
});

test("the commit reads state at commit time, not at request time", async () => {
  let state = "playing";
  let seen = null;
  const gate = new RenderGate({ commit: () => { seen = state; } });

  gate.request();
  state = "paused"; // the edge that lands after the request
  await flush();

  assert.equal(seen, "paused", "the commit observed the state that survived the tick");
  gate.dispose();
});

test("a higher-priority request re-raises the pending task to one commit", async () => {
  const priorities = recordPriorities();
  let runs = 0;
  try {
    const gate = new RenderGate({ commit: () => { runs += 1; } });

    assert.equal(gate.request("background"), true);
    assert.equal(gate.priority, "background");
    assert.equal(gate.request("user-blocking"), true,
      "a higher priority replaces the pending task rather than queueing behind it");
    assert.equal(gate.priority, "user-blocking");

    await flush();
    assert.equal(runs, 1, "re-raising still yields exactly one commit this tick");
    assert.equal(gate.commits, 1);
    assert.deepEqual(priorities.seen, ["background", "user-blocking"],
      "the background task was aborted and the task that ran was user-blocking");
    gate.dispose();
  } finally {
    priorities.restore();
  }
});

test("a same-or-lower priority request is absorbed by the pending one", async () => {
  const priorities = recordPriorities();
  let runs = 0;
  try {
    const gate = new RenderGate({ commit: () => { runs += 1; } });

    assert.equal(gate.request("user-blocking"), true);
    assert.equal(gate.request("user-visible"), false, "lower cannot displace higher");
    assert.equal(gate.request("background"), false, "background never displaces anything");
    assert.equal(gate.request("user-blocking"), false, "equal does not reschedule");
    assert.equal(gate.priority, "user-blocking", "the queued priority is untouched");

    await flush();
    assert.equal(runs, 1);
    assert.deepEqual(priorities.seen, ["user-blocking"], "scheduled exactly once");
    gate.dispose();
  } finally {
    priorities.restore();
  }
});

test("a request raised from inside the commit does not re-arm the task", async () => {
  const priorities = recordPriorities();
  let runs = 0;
  let nestedSame = null;
  let nestedHigher = null;
  try {
    const gate = new RenderGate({
      commit: () => {
        runs += 1;
        nestedSame = gate.request("user-visible");
        // The dangerous one: a higher priority taken while #pending is still
        // true would otherwise abort the running handle and schedule again.
        nestedHigher = gate.request("user-blocking");
      }
    });

    gate.request("background");
    await flush();

    assert.equal(runs, 1, "one commit, no chain");
    assert.equal(gate.commits, 1, "the counter did not grow without a task");
    assert.equal(gate.pending, false, "the guard released after the commit");
    assert.equal(nestedSame, false, "same-priority re-request dropped");
    assert.equal(nestedHigher, false, "higher-priority re-request dropped too - Trap 1 is not priority-dependent");
    assert.deepEqual(priorities.seen, ["background"],
      "no second task was ever scheduled");
    gate.dispose();
  } finally {
    priorities.restore();
  }
});

test("dispose cancels a commit that has not run yet", async () => {
  let runs = 0;
  const gate = new RenderGate({ commit: () => { runs += 1; } });

  gate.request();
  assert.equal(gate.pending, true);
  gate.dispose();

  await flush();
  assert.equal(runs, 0, "the pending task was aborted, not fired into a dead DOM");
  assert.equal(gate.commits, 0);
  assert.equal(gate.disposed, true);
  assert.equal(gate.pending, false, "dispose does not leave the guard wedged");
});

test("the owner signal disposes the gate", async () => {
  const controller = new AbortController();
  let runs = 0;
  const gate = new RenderGate({ commit: () => { runs += 1; }, signal: controller.signal });

  gate.request();
  controller.abort();

  assert.equal(gate.disposed, true, "the session scope going down takes the gate with it");
  await flush();
  assert.equal(runs, 0);
  gate.dispose(); // idempotent
  assert.equal(gate.disposed, true);
});

test("a signal already aborted at construction never arms at all", async () => {
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  const gate = new RenderGate({ commit: () => { runs += 1; }, signal: controller.signal });

  assert.equal(gate.disposed, true);
  assert.equal(gate.request("user-visible"), false);
  await flush();
  assert.equal(runs, 0);
  assert.equal(gate.commits, 0);
});

test("an unknown priority normalises to user-visible", async () => {
  const priorities = recordPriorities();
  try {
    const gate = new RenderGate({ commit: () => {} });
    gate.request("not-a-real-priority");
    assert.equal(gate.priority, "user-visible", "never reaches the host as an unknown string");
    await flush();
    assert.deepEqual(priorities.seen, ["user-visible"]);
    gate.dispose();
  } finally {
    priorities.restore();
  }
});

test("a throwing commit is reported, counted, and does not wedge the gate", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    let runs = 0;
    const gate = new RenderGate({
      commit: () => {
        runs += 1;
        throw new Error("commit failed");
      }
    });

    gate.request();
    await flush();

    assert.equal(runs, 1);
    assert.equal(gate.commits, 1, "the attempt counts - §5 counts commits, not successes");
    assert.equal(gate.pending, false, "the finally cleared the guard");
    assert.equal(errors.length, 1, "a throw from a commit is a real defect and is surfaced");
    assert.ok(
      errors[0].some((arg) => String(arg).includes("postTask callback threw")),
      `logger.error was called with the facade's message, got ${JSON.stringify(errors[0])}`
    );

    // Not wedged: the guard released, so the next edge commits normally.
    gate.dispose();
    let ok = 0;
    const healthy = new RenderGate({ commit: () => { ok += 1; } });
    healthy.request();
    await flush();
    assert.equal(ok, 1);
    healthy.dispose();
  } finally {
    console.error = originalError;
  }
});

test("a gate built without a commit function is a construction error", () => {
  assert.throws(() => new RenderGate({}), /commit function/);
  assert.throws(() => new RenderGate(), /commit function/);
});
