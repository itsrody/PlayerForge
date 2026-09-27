import test from "node:test";
import assert from "node:assert/strict";

const { Scope } = await import("../src/shared/scope.js");

test("dispose aborts the signal and runs disposers in reverse order", () => {
  const scope = new Scope();
  const calls = [];
  scope.onDispose(() => calls.push("first"));
  scope.onDispose(() => calls.push("second"));
  assert.equal(scope.disposed, false);
  assert.equal(scope.aborted, false);

  scope.dispose();

  assert.equal(scope.disposed, true);
  assert.equal(scope.aborted, true);
  assert.deepEqual(calls, ["second", "first"]);
});

test("dispose is idempotent - disposers run exactly once", () => {
  const scope = new Scope();
  let runs = 0;
  scope.onDispose(() => runs++);
  scope.dispose();
  scope.dispose();
  scope.dispose();
  assert.equal(runs, 1);
});

test("signal listeners fire on dispose", () => {
  const scope = new Scope();
  let fired = 0;
  scope.signal.addEventListener("abort", () => fired++, { once: true });
  scope.dispose();
  assert.equal(fired, 1);
});

test("onDispose after dispose runs synchronously (never outlives owner)", () => {
  const scope = new Scope();
  scope.dispose();
  let ran = false;
  scope.onDispose(() => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("a throwing disposer cannot strand the rest", () => {
  const scope = new Scope();
  const calls = [];
  scope.onDispose(() => calls.push("a"));
  scope.onDispose(() => {
    throw new Error("boom");
  });
  scope.onDispose(() => calls.push("c"));
  scope.dispose();
  assert.deepEqual(calls, ["c", "a"]);
  assert.equal(scope.disposed, true);
});

test("re-entrant dispose from inside a disposer is a no-op", () => {
  const scope = new Scope();
  let inner = 0;
  scope.onDispose(() => {
    inner++;
    scope.dispose();
  });
  scope.dispose();
  assert.equal(inner, 1);
  assert.equal(scope.disposed, true);
});

test("child scopes dispose with the parent, or early on their own", () => {
  const parent = new Scope();
  const withParent = parent.child();
  const early = parent.child();
  let independent = 0;
  early.onDispose(() => independent++);

  early.dispose();
  assert.equal(early.disposed, true);
  assert.equal(parent.disposed, false);

  parent.dispose();
  assert.equal(withParent.disposed, true);
  assert.equal(independent, 1, "early child's disposer ran once total");

  // child() on an already-disposed scope yields an already-disposed scope.
  const late = parent.child();
  assert.equal(late.disposed, true);
});
