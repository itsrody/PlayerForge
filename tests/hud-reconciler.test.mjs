import test from "node:test";
import assert from "node:assert/strict";

const { HudReconciler } = await import("../src/shared/render.js");

/**
 * A bindings table that records every invocation instead of touching a DOM.
 * The reconciler is deliberately DOM-agnostic, so the discipline it enforces
 * (compare before write) is observable without one.
 */
function recorder(fields) {
  const calls = [];
  const bindings = {};
  for (const field of fields) {
    bindings[field] = (next, prev, snapshot) => calls.push({ field, next, prev, snapshot });
  }
  return { calls, bindings };
}

test("the first apply runs every binding and counts each write", () => {
  const { calls, bindings } = recorder(["paused", "muted", "text"]);
  const hud = new HudReconciler({ bindings });
  assert.equal(hud.writes, 0);
  assert.equal(hud.applied, null);

  const snap = { paused: "1", muted: "0", text: "hi" };
  assert.equal(hud.apply(snap), true);
  assert.equal(hud.writes, 3);
  assert.equal(hud.applied, snap);
  assert.deepEqual(calls.map((c) => c.field), ["paused", "muted", "text"]);
});

test("a first apply skips fields whose value is undefined", () => {
  const { calls, bindings } = recorder(["a", "b"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ a: 1 });
  assert.deepEqual(calls.map((c) => c.field), ["a"]);
  assert.equal(hud.writes, 1);
});

test("re-applying an equal snapshot writes nothing", () => {
  const { calls, bindings } = recorder(["a", "b"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ a: 1, b: "x" });

  assert.equal(hud.apply({ a: 1, b: "x" }), false);
  assert.equal(hud.writes, 2);
  assert.equal(calls.length, 2);
});

test("only the fields that changed run their binding", () => {
  const { calls, bindings } = recorder(["a", "b"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ a: 1, b: "x" });
  hud.apply({ a: 1, b: "y" });

  assert.equal(hud.writes, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].field, "b");
  assert.equal(calls[2].prev, "x");
  assert.equal(calls[2].next, "y");
});

test("the identity fast path short-circuits the diff", () => {
  const { calls, bindings } = recorder(["a"]);
  const hud = new HudReconciler({ bindings });
  const snap = { a: 1 };
  hud.apply(snap);

  // The documented hazard: mutating a snapshot already handed to apply() is
  // invisible. Snapshots are immutable once applied; producers that re-use
  // an object must build a fresh one per call (see shell/chrome/toast.js).
  snap.a = 2;
  assert.equal(hud.apply(snap), false);
  assert.equal(hud.writes, 1);
  assert.equal(calls.length, 1);
});

test("the snapshot is adopted even when it wrote nothing", () => {
  const { bindings } = recorder(["a"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ a: 1 });
  const next = { a: 1 };
  assert.equal(hud.apply(next), false);
  assert.equal(hud.applied, next);
});

test("spreading the applied snapshot and flipping one field writes exactly one", () => {
  const { calls, bindings } = recorder(["visible", "text"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ visible: true, text: "hi" });

  const applied = hud.applied;
  hud.apply({ ...applied, visible: false });

  assert.equal(hud.writes, 3);
  assert.deepEqual(calls.map((c) => c.field), ["visible", "text", "visible"]);
  assert.equal(calls[2].next, false);
  assert.equal(calls[2].prev, true);
});

test("a textContent-style binding is gated like every other field", () => {
  // §4 L5: treat textContent as the expensive case and gate it hardest.
  let textWrites = 0;
  const hud = new HudReconciler({ bindings: { text: () => { textWrites += 1; } } });
  hud.apply({ text: "one" });
  assert.equal(textWrites, 1);
  hud.apply({ text: "one" });
  assert.equal(textWrites, 1);
  hud.apply({ text: "two" });
  assert.equal(textWrites, 2);
});

test("nullish snapshots are dropped rather than throwing", () => {
  const { bindings } = recorder(["a"]);
  const hud = new HudReconciler({ bindings });
  hud.apply({ a: 1 });

  assert.equal(hud.apply(null), false);
  assert.equal(hud.apply(undefined), false);
  assert.equal(hud.writes, 1);
  assert.equal(hud.applied.a, 1);
});

test("a non-object snapshot is a programming error, not a readiness drop", () => {
  const { bindings } = recorder(["a"]);
  const hud = new HudReconciler({ bindings });
  assert.throws(() => hud.apply("paused"), TypeError);
});

test("snapshot keys with no binding are inert", () => {
  const { bindings } = recorder(["a"]);
  const hud = new HudReconciler({ bindings });
  assert.equal(hud.apply({ a: 1, ghost: "x" }), true);
  assert.equal(hud.writes, 1);
  hud.apply({ a: 1, ghost: "y" });
  assert.equal(hud.writes, 1);
  assert.equal(hud.applied.ghost, "y");
});

test("the bindings table is validated at construction", () => {
  assert.throws(() => new HudReconciler(), TypeError);
  assert.throws(() => new HudReconciler({}), TypeError);
  assert.throws(() => new HudReconciler({ bindings: [] }), TypeError);
  assert.throws(() => new HudReconciler({ bindings: { a: 1 } }), /not a function/);
});
