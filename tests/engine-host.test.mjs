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

/**
 * A member factory for the frame flags. Everything the probe asks for is on
 * the prototype - the whole point of reading them from here rather than from an
 * element, which may not have been upgraded yet when the question is asked.
 */
function videoElement({ rvfc = true, quality = true, mozPair = true } = {}) {
  class FakeVideoElement {}
  if (rvfc) {
    FakeVideoElement.prototype.requestVideoFrameCallback = () => 0;
  }
  if (quality) {
    FakeVideoElement.prototype.getVideoPlaybackQuality = () => ({ droppedVideoFrames: 0 });
  }
  if (mozPair) {
    FakeVideoElement.prototype.mozPresentedFrames = 0;
    FakeVideoElement.prototype.mozPaintedFrames = 0;
  }
  return FakeVideoElement;
}

test("the frame facts are read from the prototype and are all-or-nothing", () => {
  const original = globalThis.HTMLVideoElement;
  try {
    // This host has no HTMLVideoElement at all, and the singleton was built
    // from it: absent means false, not a throw from the `in` guards.
    assert.equal(engineHost.canRvfc, false);
    assert.equal(engineHost.canMozQuality, false);

    globalThis.HTMLVideoElement = videoElement();
    assert.equal(new EngineHost().canRvfc, true);
    assert.equal(new EngineHost().canMozQuality, true);

    // The standard half without the mozilla pair cannot produce the
    // submitted-versus-painted number, so it is not recorded as available.
    globalThis.HTMLVideoElement = videoElement({ mozPair: false });
    assert.equal(new EngineHost().canRvfc, true, "the two flags answer separately");
    assert.equal(new EngineHost().canMozQuality, false, "all three or none");

    // And rVFC being absent says nothing about the quality set.
    globalThis.HTMLVideoElement = videoElement({ rvfc: false });
    assert.equal(new EngineHost().canRvfc, false);
    assert.equal(new EngineHost().canMozQuality, true);

    // Deleted rather than undefined: this is the shape where a bare `in`
    // against a missing prototype would have thrown.
    delete globalThis.HTMLVideoElement;
    assert.equal(new EngineHost().canRvfc, false);
    assert.equal(new EngineHost().canMozQuality, false);
  } finally {
    if (original === undefined) {
      delete globalThis.HTMLVideoElement;
    } else {
      globalThis.HTMLVideoElement = original;
    }
  }
});

test("the host is read-only after construction", () => {
  assert.equal(Object.isFrozen(engineHost), true, "the singleton is frozen");
  // ESM is strict, so a getter-only assignment raises rather than silently
  // doing nothing - which is the point: a caller that tries to correct the
  // host gets told, instead of forking the fact.
  assert.throws(() => {
    engineHost.canRvfc = true;
  }, TypeError);
  assert.equal(engineHost.canRvfc, false, "the failed write left nothing behind");
});

test("two instances constructed from one host agree", () => {
  const a = new EngineHost();
  const b = new EngineHost();
  assert.equal(a.canMessageChannel, b.canMessageChannel);
  assert.equal(a.canRvfc, b.canRvfc);
  assert.equal(a.canMozQuality, b.canMozQuality);
});

test("probeEngineHost refreshes the snapshot from current globals", () => {
  const original = globalThis.HTMLVideoElement;
  try {
    // No video element on this host: the snapshot honestly reports absent.
    delete globalThis.HTMLVideoElement;
    assert.equal(probeEngineHost().canRvfc, false);
    // An engine upgrade lands mid-session: re-probing (entry bootstrap does
    // it first thing) picks the new facts up instead of holding import time.
    globalThis.HTMLVideoElement = videoElement();
    const refreshed = probeEngineHost();
    assert.equal(refreshed.canRvfc, true, "re-probing reads the live globals, not import time");
    assert.ok(Object.isFrozen(refreshed), "the refreshed snapshot stays frozen");
  } finally {
    if (original === undefined) {
      delete globalThis.HTMLVideoElement;
    } else {
      globalThis.HTMLVideoElement = original;
    }
    probeEngineHost();
  }
});
