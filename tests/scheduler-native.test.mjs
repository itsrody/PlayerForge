import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

/**
 * The branch Firefox runs, and the branch CI never did.
 *
 * shared/scheduler.js calls `globalThis.scheduler.postTask` unconditionally
 * (the Firefox 157 floor always has it), so there is no production fallback
 * for Node to reach. Node has no `scheduler` global at all, so the harness
 * polyfill in tests/loader.mjs normally provides one; this file replaces it
 * with a faithful double to pin the contract the facade relies on: the
 * returned handle does not own the task, it owns an AbortController wired to
 * the task's own signal.
 *
 * Seeding the global before the first call is what makes every assertion
 * below hit the double - node's test runner gives this file its own process,
 * so nothing has called postTask yet when the import below evaluates
 * scheduler.js. The first test asserts the double is live rather than
 * trusting the setup.
 */

const scheduled = [];

/**
 * Faithful postTask double: a task runs only when the test releases it, it
 * returns a promise, and that promise REJECTS when the signal aborts. The
 * rejection matters - it is why the façade attaches `task.catch(() => {})`,
 * and a double that resolved on abort would let a missing catch pass.
 */
globalThis.scheduler = {
  postTask(callback, options = {}) {
    let rejectTask;
    const promise = new Promise((_resolve, reject) => {
      rejectTask = reject;
    });
    const task = {
      callback,
      options,
      get aborted() {
        return options.signal?.aborted === true;
      },
      release() {
        if (task.aborted) {
          return;
        }
        callback();
        // A real task settles its promise when it runs; every caller here
        // ignores the return value.
        promise.catch(() => {});
      }
    };
    options.signal?.addEventListener(
      "abort",
      () => rejectTask(new DOMException("The task was aborted.", "AbortError")),
      { once: true }
    );
    scheduled.push(task);
    return promise;
  }
};

const { postTask } = await import("../src/shared/scheduler.js");

/** Release the given recorded tasks (default: all of them) and drain the log. */
function release(...targets) {
  const tasks = targets.length ? targets : scheduled.splice(0, scheduled.length);
  if (!targets.length) {
    scheduled.length = 0;
  }
  for (const task of tasks) {
    task.release();
  }
}

test("the native branch is the one under test", () => {
  assert.equal(typeof globalThis.scheduler?.postTask, "function", "the seed took effect");
  postTask(() => {});
  assert.equal(scheduled.length, 1, "scheduler.postTask was called, so the façade took the native branch");
  release();
});

test("the task does not run until the host releases it", async () => {
  let ran = 0;
  postTask(() => ran++);
  // A macrotask turn is the most a setTimeout(0) fallback could have needed.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ran, 0, "a host task is not a timer: it waited for the scheduler");
  release();
  assert.equal(ran, 1, "and it ran exactly once on release");
});

test("priority and delay reach the host verbatim, with sensible defaults", () => {
  postTask(() => {});
  assert.equal(scheduled[0].options.priority, "user-visible", "documented default priority");
  assert.equal(scheduled[0].options.delay, 0, "documented default delay");
  release();

  postTask(() => {}, { priority: "background", delay: 250 });
  assert.equal(scheduled[0].options.priority, "background");
  assert.equal(scheduled[0].options.delay, 250, "a removal grace's delay is not swallowed");
  release();
});

test("the handle owns an AbortController, not the host's task", () => {
  postTask(() => {});
  const signal = scheduled[0].options.signal;
  assert.ok(signal instanceof AbortSignal, "the task is scheduled with the handle's own signal");
  assert.equal(signal.aborted, false);
  assert.equal(scheduled[0].aborted, false);
  release();
});

test("handle.abort() cancels the task before it runs", () => {
  let ran = 0;
  const handle = postTask(() => ran++);
  handle.abort();
  assert.equal(scheduled[0].aborted, true, "the task's signal is aborted, so the host drops it");
  release();
  assert.equal(ran, 0, "an aborted task never delivers its callback");
});

test("an owner signal cancels the task, and detaches itself afterwards", () => {
  const owner = new AbortController();
  let ran = 0;
  postTask(() => ran++, { signal: owner.signal });
  assert.equal(getEventListeners(owner.signal, "abort").length, 1, "the façade listens while the task is live");

  owner.abort();
  assert.equal(scheduled[0].aborted, true, "the owner's abort reaches the task's own signal");
  assert.equal(
    getEventListeners(owner.signal, "abort").length,
    0,
    "and the listener is dropped, so a long-lived scope signal collects nothing"
  );
  release();
  assert.equal(ran, 0);
});

test("a task that runs detaches from its owner signal", () => {
  const owner = new AbortController();
  postTask(() => {}, { signal: owner.signal });
  release();
  assert.equal(
    getEventListeners(owner.signal, "abort").length,
    0,
    "a settled task must not keep the owner's signal alive"
  );
});

test("the abort rejection stays off the unhandled-rejection path", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // One task aborted before it ran, one aborted after it already ran. Both
    // reject a promise nobody awaits, which is what the façade's catch eats.
    let ran = 0;
    const dropped = postTask(() => ran++);
    dropped.abort();

    const ranAlready = postTask(() => ran++);
    release();
    ranAlready.abort();

    // Two macrotask turns is what node needs to surface a rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, [], "aborting a task rejects its promise; nothing awaits it");
    assert.equal(ran, 1, "only the released, unaborted task ran");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a task may abort a sibling from inside its own callback", () => {
  // The shape from the module header: whenDomSettled's settle timer cancels
  // its cap sibling from inside the settle callback. This is the case
  // scheduler.yield could not survive - the awaited continuation inherited the
  // aborted signal and rejected with AbortError, which killed shell boot.
  let ran = 0;
  const cap = postTask(() => ran++);
  postTask(() => {
    cap.abort();
    ran++;
  });
  const [capTask, settleTask] = [...scheduled];
  release(settleTask);
  release(capTask);
  assert.equal(ran, 1, "the cap task was dropped by the abort that ran first");
  assert.equal(capTask.aborted, true);
});
