import test from "node:test";
import assert from "node:assert/strict";

const { EngineHost, engineHost, probeEngineHost } = await import(
  "../src/shared/engine-host.js"
);

/**
 * L0's contract: it states capability facts, once, and holds them still.
 *
 * The interesting cases are the ones that would let a later layer silently
 * re-introduce the problem L0 exists to solve - a fact that mutates, a fact
 * that is guessed rather than read, or a fact that claims more than the host
 * actually reports.
 */

test("MessageChannel availability is one shared answer", () => {
  assert.equal(
    engineHost.canMessageChannel,
    typeof MessageChannel === "function",
    "L0 must agree with the host it was read from"
  );
});

test("the host is read-only after construction", () => {
  assert.equal(Object.isFrozen(engineHost), true, "the singleton is frozen");
  // ESM is strict, so a getter-only assignment raises rather than silently
  // doing nothing - which is the point: a caller that tries to correct the
  // host gets told, instead of forking the fact.
  assert.throws(() => {
    engineHost.canMessageChannel = false;
  }, TypeError);
  assert.equal(engineHost.canMessageChannel, true, "the failed write left nothing behind");
});

test("two instances constructed from one host agree", () => {
  const a = new EngineHost();
  const b = new EngineHost();
  assert.equal(a.canMessageChannel, b.canMessageChannel);
});

test("probeEngineHost refreshes the snapshot from current globals", () => {
  // Shadow the global with an own property (never delete the real one):
  // removing MessageChannel must read as absent, restoring must read back.
  Object.defineProperty(globalThis, "MessageChannel", { value: undefined, configurable: true });
  try {
    assert.equal(probeEngineHost().canMessageChannel, false);
    const refreshed = probeEngineHost();
    assert.ok(Object.isFrozen(refreshed), "the refreshed snapshot stays frozen");
  } finally {
    delete globalThis.MessageChannel;
    probeEngineHost();
  }
  assert.equal(engineHost.canMessageChannel, true, "re-probing reads the live globals, not import time");
});
