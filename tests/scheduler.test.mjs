import test from "node:test";
import assert from "node:assert/strict";

const { postTask } = await import("../src/shared/scheduler.js");

async function settle(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("postTask runs the task and the abort handle cancels a pending one", async () => {
  const ran = [];
  postTask(() => ran.push("ran"), { delay: 0 });
  const handle = postTask(() => ran.push("cancelled"), { delay: 0 });
  handle.abort();
  await settle();
  assert.deepEqual(ran, ["ran"]);
});

test("postTask with an already-aborted owner signal never runs", async () => {
  const ac = new AbortController();
  ac.abort();
  let ran = 0;
  const handle = postTask(() => { ran++; }, { signal: ac.signal });
  await settle();
  assert.equal(ran, 0, "an already-aborted owner drops the task at the door");
  assert.equal(typeof handle.abort, "function", "a dead handle is still returned");
});

test("postTask cancels a pending task when the owner signal aborts later", async () => {
  const ac = new AbortController();
  let ran = 0;
  postTask(() => { ran++; }, { delay: 20, signal: ac.signal });
  ac.abort();
  await settle(30);
  assert.equal(ran, 0, "aborting the owner tears the pending task down");
});

test("postTask detaches its owner-signal listener once the task runs", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener: (type) => { if (type === "abort") added++; },
    removeEventListener: (type) => { if (type === "abort") removed++; }
  };
  let ran = false;
  postTask(() => { ran = true; }, { signal });
  await settle();
  assert.equal(ran, true, "the task ran");
  assert.equal(added, 1, "the abort listener was attached");
  assert.equal(removed, 1, "natural completion drops the abort listener");
});
