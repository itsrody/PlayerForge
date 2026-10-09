import test from "node:test";
import assert from "node:assert/strict";

const { EngineHost, engineHost, parseGeckoVersion } = await import(
  "../src/shared/engine-host.js"
);

/**
 * L0's contract: it states environment facts, once, and holds them still.
 *
 * The interesting cases are the ones that would let a later layer silently
 * re-introduce the problem L0 exists to solve - a fact that mutates, a fact
 * that is guessed rather than read, or a fact that claims more than the host
 * actually reports.
 */

test("the engine is Gecko, because that is the only engine we ship for", () => {
  assert.equal(engineHost.engine, "Gecko");
  assert.equal(new EngineHost().engine, "Gecko");
});

test("parseGeckoVersion reads a release build", () => {
  assert.equal(
    parseGeckoVersion("Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0"),
    "158.0"
  );
});

test("parseGeckoVersion keeps the prerelease suffix instead of flattening it", () => {
  // The channel suffix is in the UA, so nothing outside the script's own realm
  // has to be consulted to know a beta from a release - which is exactly the
  // "prerelease-aware, e.g. 158.0b3" shape the layer model specifies.
  assert.equal(
    parseGeckoVersion("Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0b3"),
    "158.0b3"
  );
  assert.equal(
    parseGeckoVersion("Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0a1"),
    "160.0a1"
  );
  assert.equal(
    parseGeckoVersion("Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0esr"),
    "115.0"
  );
});

test("parseGeckoVersion reports null rather than guessing on a non-Firefox host", () => {
  assert.equal(parseGeckoVersion("Node.js/26"), null);
  assert.equal(parseGeckoVersion("Mozilla/5.0 Chrome/140.0.0.0"), null);
  assert.equal(parseGeckoVersion(""), null);
  assert.equal(parseGeckoVersion(undefined), null);
});

test("the recorded version is what the parser would say about this host", () => {
  // Not asserting a specific number: the harness is Node, where there is no
  // Gecko version to know. Asserting agreement instead keeps the constructor
  // honest without pinning the test to a browser build.
  const expected = parseGeckoVersion(globalThis.navigator?.userAgent ?? "");
  assert.equal(engineHost.version, expected);
  if (expected !== null) {
    assert.match(engineHost.version, /^\d+(?:\.\d+)?(?:[ab]\d+)?$/);
  }
});

test("the realm is a mode the manager could report, or nothing at all", () => {
  // Violentmonkey reports it through GM_info.injectInto (ARCHITECTURE §2.7);
  // the jsdom host provides no GM_info, so null is the honest answer here.
  assert.ok(
    engineHost.realm === null || ["page", "content", "auto"].includes(engineHost.realm),
    `unexpected realm: ${engineHost.realm}`
  );
});

test("scheduler availability is reported, not assumed", () => {
  // tests/loader.mjs installs a timer-backed postTask before any module loads,
  // so a host that had lost it would show up here as false rather than throwing
  // from deep inside a deferred path.
  assert.equal(engineHost.canPostTask, true, "the loader polyfill or native scheduler is live");
  assert.equal(typeof engineHost.canYield, "boolean");
  // The polyfill deliberately implements postTask only: yield() is the API Trap
  // 2 ruled out, so this staying false under the harness is correct - it proves
  // the two methods are tracked separately rather than as one "scheduler" flag.
  assert.equal(engineHost.canYield, false, "the polyfill does not pretend to offer yield()");
});

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
    engineHost.engine = "Chromium";
  }, TypeError);
  assert.throws(() => {
    engineHost.realm = "page";
  }, TypeError);
  assert.equal(engineHost.engine, "Gecko", "the failed write left nothing behind");
});

test("two instances constructed from one host agree", () => {
  const a = new EngineHost();
  const b = new EngineHost();
  assert.equal(a.engine, b.engine);
  assert.equal(a.version, b.version);
  assert.equal(a.realm, b.realm);
  assert.equal(a.canPostTask, b.canPostTask);
  assert.equal(a.canYield, b.canYield);
  assert.equal(a.canMessageChannel, b.canMessageChannel);
  assert.equal(a.canRvfc, b.canRvfc);
  assert.equal(a.canMozQuality, b.canMozQuality);
});
