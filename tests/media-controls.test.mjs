import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMediaControls, claimMediaSession, MEDIA_SESSION_SYNC_EVENTS } from "../src/shell/media.js";

function makeEnv(readyState = 0) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  const video = dom.window.document.createElement("video");
  if (readyState != null) {
    Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
  }
  const controls = createMediaControls({ video });
  return { dom, video, controls };
}

test("every control is inert before metadata loads (readyState 0)", async () => {
  const { video, controls } = makeEnv(0);
  const snap = () => ({
    time: video.currentTime,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate
  });

  const before = snap();
  controls.seekTo(50);
  controls.scrubTo(30);
  controls.skip(10);
  controls.stop();
  controls.toggleMute();
  controls.setVolume(0.3);
  controls.nudgeVolume("up");
  controls.beginBoost(2);
  controls.pause();
  await controls.togglePlay();
  await controls.play();

  assert.deepEqual(snap(), before, "no control touches the video before load");
});

test("endBoost restores the rate even after readiness drops mid-hold", () => {
  // A hold that straddles a readiness drop must still put the rate back.
  // `emptied` (src reassigned / load() called under the user's finger) sends
  // readyState to 0; gating the RESTORE on readiness stranded the video at
  // hold speed for the rest of the session. Gecko accepts the write at
  // readyState 0, so the restore has no reason to be gated.
  const { video, controls } = makeEnv(4);
  controls.beginBoost(2);
  assert.equal(video.playbackRate, 2, "boost engaged while ready");

  Object.defineProperty(video, "readyState", { value: 0, configurable: true });
  controls.endBoost(1);

  assert.equal(video.playbackRate, 1, "release restores the rate after `emptied`");
});

test("endBoost at readyState 0 from a cold start is a no-op in effect", () => {
  // The restore writes the rate verbatim, so a release that never boosted
  // writes back the saved rate rather than corrupting one. Pinned so the
  // ungated write cannot quietly become a no-op that strands a live boost.
  const { video, controls } = makeEnv(0);
  video.playbackRate = 1.5;
  controls.endBoost(1);
  assert.equal(video.playbackRate, 1);
});

test("play is inert before metadata loads", async () => {
  const { video, controls } = makeEnv(0);
  let played = false;
  video.play = () => {
    played = true;
    return Promise.resolve();
  };
  await controls.play();
  assert.equal(played, false);
});

test("controls engage once metadata is loaded (readyState 4)", async () => {
  const { video, controls } = makeEnv(4);
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  video.play = () => Promise.resolve();

  controls.setVolume(0.5);
  assert.equal(video.volume, 0.5);

  controls.toggleMute();
  assert.equal(video.muted, true);

  controls.seekTo(60);
  assert.equal(video.currentTime, 60);

  controls.skip(10);
  assert.equal(video.currentTime, 70);

  controls.scrubTo(90);
  assert.equal(video.currentTime, 90);

  controls.beginBoost(2);
  assert.equal(video.playbackRate, 2);
  controls.endBoost(1);
  assert.equal(video.playbackRate, 1);

  await controls.play();
  controls.pause();
  assert.equal(video.paused, true);
});

test("seek applies in the MSE window: duration known while readyState is still 0", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://example.com/watch"
  });
  const video = dom.window.document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 0, configurable: true });
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 0, configurable: true, writable: true });
  const controls = createMediaControls({ video });

  // MSE/streaming players set duration (durationchange) before metadata; a
  // known duration IS a timeline, so the seek must not be silently dropped.
  controls.seekTo(42);
  assert.equal(video.currentTime, 42, "a finite duration is a timeline even at readyState 0");

  controls.seekTo(700);
  assert.equal(video.currentTime, 600, "still clamped to the known duration");
});

test("gating reads live readyState, not a snapshot at creation", async () => {
  const { video, controls } = makeEnv(0);
  let played = 0;
  video.play = () => {
    played++;
    return Promise.resolve();
  };

  await controls.play();
  assert.equal(played, 0, "play no-ops before load");

  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  await controls.play();
  assert.equal(played, 1, "play engages once metadata loads");
});

function makeSession() {
  const positions = [];
  return {
    positions,
    setActionHandler() {},
    setPositionState(state) {
      positions.push({ ...state });
    }
  };
}

test("MediaSession position state stays live off the media clock", async () => {
  const { dom, video, controls } = makeEnv(4);
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  Object.defineProperty(video, "playbackRate", { value: 1, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 5, configurable: true });
  Object.defineProperty(video, "paused", { value: false, configurable: true });

  const session = makeSession();
  // jsdom rejects AbortSignals from the Node realm; lend the DOM realm's.
  globalThis.AbortController = dom.window.AbortController;
  const scope = new AbortController();
  claimMediaSession({ controls, video, signal: scope.signal, session });

  // Replicate sync's cadence over the exported set: the shell drives sync
  // from status commits plus the clock now, not from this fan-out - but the
  // set still defines which edges must reach the bridge, so the test drives
  // the bridge directly against it.
  for (const name of MEDIA_SESSION_SYNC_EVENTS) {
    video.addEventListener(name, () => {
      session.positions.push({ synced: true });
    });
  }
  const synced = () => session.positions.filter((p) => p.synced).length;

  Object.defineProperty(video, "currentTime", { value: 30, configurable: true });
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(synced(), 1, "timeupdate pushes live position while playing");

  assert.equal(MEDIA_SESSION_SYNC_EVENTS.has("timeupdate"), true);
  scope.abort();
});

test("URL.canParse gates MediaSession poster artwork", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://example.com/watch?v=1"
  });
  Object.defineProperty(dom.window.document, "title", { value: "Demo", configurable: true });
  const video = dom.window.document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  const previousMetadata = globalThis.MediaMetadata;
  globalThis.MediaMetadata = class MediaMetadata {
    constructor(options) {
      this._captured = options;
    }
  };
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;

  const session = {
    playbackState: "none",
    metadata: null,
    setActionHandler() {},
    setPositionState() {}
  };
  const scope = new dom.window.AbortController();
  const controls = createMediaControls({ video });
  try {
    video.poster = "// not a url wording ^^";
    claimMediaSession({ controls, video, signal: scope.signal, session });
    assert.deepEqual(session.metadata._captured.artwork, [], "malformed poster drops artwork");

    video.poster = "/posters/front.jpg";
    video.dispatchEvent(new dom.window.Event("loadedmetadata"));
    assert.equal(session.metadata._captured.artwork[0].src, "https://example.com/posters/front.jpg");
  } finally {
    globalThis.MediaMetadata = previousMetadata;
    delete globalThis.document;
    delete globalThis.location;
  }
});

/** Session double that RECORDS action handlers, so a UA action can be fired. */
function makeActionSession() {
  const handlers = new Map();
  return {
    handlers,
    playbackState: "none",
    metadata: null,
    setActionHandler(action, fn) {
      handlers.set(action, fn);
    },
    setPositionState() {}
  };
}

/**
 * Claim a session against a video and hand back the seekto handler. jsdom's
 * media element has NO fastSeek, which is exactly the host that used to throw.
 */
function claimSeekto({ withFastSeek = false, readyState = 4, duration = 120 } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://example.com/watch?v=1"
  });
  const video = dom.window.document.createElement("video");
  Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  const fastSeekCalls = [];
  if (withFastSeek) {
    video.fastSeek = (t) => fastSeekCalls.push(t);
  }

  const session = makeActionSession();
  const controls = createMediaControls({ video });
  const scope = new dom.window.AbortController();
  const saved = {
    doc: globalThis.document, loc: globalThis.location,
    md: globalThis.MediaMetadata, ac: globalThis.AbortController,
  };
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.MediaMetadata = class MediaMetadata { constructor(o) { this.o = o; } };
  globalThis.AbortController = dom.window.AbortController;
  try {
    claimMediaSession({ controls, video, signal: scope.signal, session });
  } finally {
    globalThis.document = saved.doc;
    globalThis.location = saved.loc;
    globalThis.MediaMetadata = saved.md;
    globalThis.AbortController = saved.ac;
  }
  return { video, session, fastSeekCalls, seekto: session.handlers.get("seekto") };
}

test("seekto uses the clamped command plane when fastSeek is not requested", () => {
  const { video, seekto } = claimSeekto();
  seekto({ seekTime: 42 });
  assert.equal(video.currentTime, 42, "plain seekto lands on the requested time");

  seekto({ seekTime: 9999 });
  assert.equal(video.currentTime, 120, "and stays clamped to duration");
});

test("seekto takes the Gecko fastSeek path when the host provides it", () => {
  const { video, fastSeekCalls, seekto } = claimSeekto({ withFastSeek: true });
  seekto({ seekTime: 42, fastSeek: true });
  assert.deepEqual(fastSeekCalls, [42], "fastSeek is used when present");
  assert.equal(video.currentTime, 0, "and bypasses the clamped seek");
});

test("seekto survives a host without fastSeek instead of throwing", () => {
  // Regression: an unguarded video.fastSeek() threw a TypeError into the
  // page's error channel from inside a UA action handler. Gecko itself sends
  // seekto with fastSeek set from its own media keys, so the flag cannot be
  // treated as implying the method exists.
  const { video, seekto } = claimSeekto({ withFastSeek: false });
  assert.doesNotThrow(() => seekto({ seekTime: 42, fastSeek: true }), "no TypeError on a host without fastSeek");
  assert.equal(video.currentTime, 42, "falls back to the clamped command-plane seek");
});

test("seekto without a seekTime is inert", () => {
  const { video, seekto } = claimSeekto();
  seekto({});
  seekto({ fastSeek: true });
  seekto(undefined);
  assert.equal(video.currentTime, 0, "no target means no seek");
});

/**
 * navigator.mediaSession is one global per window, so the bridge registry is
 * module-level state. These cases each need a pristine one: a bridge left
 * alive by an earlier test in this file would otherwise be promoted instead of
 * the shell under test. A cache-busting specifier gets a fresh module instance.
 */
let mediaModuleSeq = 0;
function freshMedia() {
  return import(`../src/shell/media.js?fresh=${mediaModuleSeq++}`);
}

/** A session fake that records handlers and the two writable fields. */
function makeRichSession() {
  const handlers = new Map();
  return {
    handlers,
    playbackState: "none",
    metadata: null,
    setActionHandler(action, fn) {
      if (fn === null) {
        handlers.delete(action);
      } else {
        handlers.set(action, fn);
      }
    },
    setPositionState() {}
  };
}

function readyEnv(dom, paused) {
  const video = dom.window.document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "paused", { value: paused, configurable: true });
  Object.defineProperty(video, "duration", { value: 100, configurable: true });
  Object.defineProperty(video, "playbackRate", { value: 1, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 10, configurable: true });
  return { video, controls: createMediaControls({ video }) };
}

test("destroying the session owner hands it to a surviving shell", async () => {
  const claim = (await freshMedia()).claimMediaSession;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.AbortController = dom.window.AbortController;
  const session = makeRichSession();
  const a = readyEnv(dom, true);
  const b = readyEnv(dom, false);
  const scopeA = new AbortController();
  const scopeB = new AbortController();

  claim({ controls: a.controls, video: a.video, signal: scopeA.signal, session });
  claim({ controls: b.controls, video: b.video, signal: scopeB.signal, session });
  assert.equal(session.playbackState, "playing", "the newest claim owns the session");

  scopeB.abort();

  // B was the owner and left; A's shell is still alive and must get the OS
  // surface back rather than leaving the window with no controls at all.
  assert.equal(session.handlers.has("play"), true, "the survivor got no action handlers");
  assert.equal(session.playbackState, "paused", "the survivor's state was not pushed");
});

test("a displaced bridge stops writing the shared session", async () => {
  const claim = (await freshMedia()).claimMediaSession;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.AbortController = dom.window.AbortController;
  const session = makeRichSession();
  const a = readyEnv(dom, true);
  const b = readyEnv(dom, false);
  const scopeA = new AbortController();
  const scopeB = new AbortController();

  const bridgeA = claim({ controls: a.controls, video: a.video, signal: scopeA.signal, session });
  claim({ controls: b.controls, video: b.video, signal: scopeB.signal, session });
  assert.equal(session.playbackState, "playing");

  // A's shell is still listening to its own media events. navigator.mediaSession
  // is one global, so A syncing anyway would make two players overwrite each
  // other's state on every tick.
  bridgeA.sync();
  assert.equal(session.playbackState, "playing", "the displaced bridge overwrote the owner");

  scopeA.abort();
  scopeB.abort();
});

test("displacing an owner does not blank the session mid-handoff", async () => {
  const claim = (await freshMedia()).claimMediaSession;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.AbortController = dom.window.AbortController;
  const session = makeRichSession();
  const a = readyEnv(dom, true);
  const b = readyEnv(dom, false);
  const scopeA = new AbortController();
  const scopeB = new AbortController();

  claim({ controls: a.controls, video: a.video, signal: scopeA.signal, session });
  const seen = [];
  Object.defineProperty(session, "playbackState", {
    get: () => seen.at(-1) ?? "none",
    set: (v) => seen.push(v),
    configurable: true
  });

  claim({ controls: b.controls, video: b.video, signal: scopeB.signal, session });

  // The old owner was destroyed rather than displaced, so it cleared the
  // global session on its way out and the new owner had to rewrite it.
  assert.equal(seen.includes("none"), false, "the session was blanked during handoff");

  scopeA.abort();
  scopeB.abort();
});

test("the last bridge leaving clears the session outright", async () => {
  const claim = (await freshMedia()).claimMediaSession;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.AbortController = dom.window.AbortController;
  const session = makeRichSession();
  const a = readyEnv(dom, true);
  const scopeA = new AbortController();

  claim({ controls: a.controls, video: a.video, signal: scopeA.signal, session });
  scopeA.abort();

  assert.equal(session.handlers.size, 0, "handlers outlived the last shell");
  assert.equal(session.playbackState, "none");
  assert.equal(session.metadata, null);
});

/* - Screen wake lock - */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** WakeLock double: records requests, hands out controllable sentinels. */
function makeWakeLock({ reject = false } = {}) {
  const requests = [];
  const sentinels = [];
  return {
    requests,
    sentinels,
    api: {
      request(type) {
        requests.push(type);
        if (reject) {
          return Promise.reject(new Error("denied"));
        }
        const sentinel = {
          released: false,
          listeners: new Map(),
          release() {
            this.released = true;
          },
          addEventListener(name, fn) {
            this.listeners.set(name, fn);
          }
        };
        sentinels.push(sentinel);
        return Promise.resolve(sentinel);
      }
    }
  };
}

function installNavigator(value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value, writable: true, configurable: true
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
    } else {
      delete globalThis.navigator;
    }
  };
}

async function claimWakeBridge({ paused, wake } = {}) {
  const claim = (await freshMedia()).claimMediaSession;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.AbortController = dom.window.AbortController;
  const session = makeRichSession();
  const { video, controls } = readyEnv(dom, paused);
  const scope = new AbortController();
  // The fake stays installed for the test's lifetime: sync() re-reads the
  // host on every call, so restoring right after claim would test the
  // TypeError catch instead of the design. Callers run cleanup last.
  const cleanupNavigator = installNavigator(wake ? { wakeLock: wake.api } : undefined);
  const bridge = claim({ controls, video, signal: scope.signal, session });
  const cleanup = () => {
    scope.abort();
    cleanupNavigator();
  };
  return { bridge, video, cleanup };
}

function setPaused(video, paused) {
  Object.defineProperty(video, "paused", { value: paused, configurable: true });
}

test("a playing bridge holds a screen wake lock and releases it on pause", async () => {
  const wake = makeWakeLock();
  const { bridge, video, cleanup } = await claimWakeBridge({ paused: false, wake });
  try {
    await tick();
    assert.deepEqual(wake.requests, ["screen"], "one screen-lock request while playing");
    bridge.sync();
    bridge.sync();
    await tick();
    assert.equal(wake.requests.length, 1, "repeat syncs stack no second request");

    setPaused(video, true);
    bridge.sync();
    assert.equal(wake.sentinels[0].released, true, "pause releases the held lock");
    bridge.sync();
    await tick();
    assert.equal(wake.requests.length, 1, "paused syncs never request");
  } finally {
    cleanup();
  }
});

test("a denied wake-lock request stays silent and retries on the next sync", async () => {
  const wake = makeWakeLock({ reject: true });
  const { bridge, cleanup } = await claimWakeBridge({ paused: false, wake });
  try {
    await tick();
    assert.equal(wake.requests.length, 1, "first attempt issued");
    bridge.sync();
    await tick();
    assert.equal(wake.requests.length, 2, "denial clears the flag so the next sync retries");
  } finally {
    cleanup();
  }
});

test("a host without wakeLock degrades silently", async () => {
  const { bridge, video, cleanup } = await claimWakeBridge({ paused: false });
  try {
    // No navigator.wakeLock at all: sync must neither throw nor record.
    bridge.sync();
    await tick();
    setPaused(video, true);
    bridge.sync();
    assert.ok(true, "survived a lock-less host without throwing");
  } finally {
    cleanup();
  }
});

test("destroying a shell releases its held wake lock", async () => {
  const wake = makeWakeLock();
  const { bridge, cleanup } = await claimWakeBridge({ paused: false, wake });
  await tick();
  assert.equal(wake.sentinels.length, 1, "precondition: the lock is held");
  cleanup();
  assert.equal(wake.sentinels[0].released, true, "teardown banks no screen-on");
});

test("a request resolving after pause banks no lock for the stopped video", async () => {
  const requests = [];
  let resolveRequest;
  const api = {
    request() {
      requests.push(1);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    }
  };
  const wake = { api };
  const { bridge, video, cleanup } = await claimWakeBridge({ paused: false, wake });
  try {
    await tick();
    assert.equal(requests.length, 1, "precondition: one request in flight");
    // Pause while the request is still pending.
    setPaused(video, true);
    bridge.sync();
    const sentinel = { released: false, release() { this.released = true; }, addEventListener() {} };
    resolveRequest(sentinel);
    await tick();
    assert.equal(sentinel.released, true, "the late lock is released, not banked");
    assert.equal(requests.length, 1, "no second request issued while paused");

    // Playing again self-heals on the next sync.
    setPaused(video, false);
    bridge.sync();
    await tick();
    assert.equal(requests.length, 2, "resume re-acquires");
  } finally {
    cleanup();
  }
});

test("a UA revocation clears the field so the next sync re-acquires", async () => {
  const wake = makeWakeLock();
  const { bridge, cleanup } = await claimWakeBridge({ paused: false, wake });
  try {
    await tick();
    assert.equal(wake.sentinels.length, 1, "precondition: the lock is held");
    // The UA revokes on hide; the sentinel's release event is the signal.
    wake.sentinels[0].listeners.get("release")();
    bridge.sync();
    await tick();
    assert.equal(wake.requests.length, 2, "a revoked lock is re-acquired while still playing");
  } finally {
    cleanup();
  }
});

/* - Scrub fastSeek - */

function scrubEnv({ withFastSeek = false, duration = 120 } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const video = dom.window.document.createElement("video");
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  const fastSeekCalls = [];
  if (withFastSeek) {
    video.fastSeek = (t) => fastSeekCalls.push(t);
  }
  return { video, controls: createMediaControls({ video }), fastSeekCalls };
}

test("per-move scrub seeks ride fastSeek where the engine offers it", () => {
  const { video, controls, fastSeekCalls } = scrubEnv({ withFastSeek: true });
  controls.scrubToLatched(42.5, 120);
  assert.deepEqual(fastSeekCalls, [42.5], "the move went through fastSeek");
});

test("per-move scrub falls back to precise currentTime without fastSeek", () => {
  // jsdom has no fastSeek, which is exactly the host this guards.
  const { video, controls, fastSeekCalls } = scrubEnv();
  controls.scrubToLatched(42.5, 120);
  assert.deepEqual(fastSeekCalls, [], "no fastSeek to call");
  assert.equal(video.currentTime, 42.5, "the precise write it always was");
});

test("latched seeks clamp in both arms", () => {
  const fast = scrubEnv({ withFastSeek: true });
  fast.controls.scrubToLatched(500, 120);
  assert.deepEqual(fast.fastSeekCalls, [120], "fastSeek clamps to duration");
  fast.controls.scrubToLatched(-5, 120);
  assert.deepEqual(fast.fastSeekCalls, [120, 0], "fastSeek clamps to zero");

  const precise = scrubEnv();
  precise.controls.scrubToLatched(500, 120);
  assert.equal(precise.video.currentTime, 120);
});

test("the release settle writes the exact target even with fastSeek", () => {
  const { video, controls, fastSeekCalls } = scrubEnv({ withFastSeek: true });
  controls.scrubToLatched(42.5, 120);
  controls.scrubSettle(42.5);
  assert.deepEqual(fastSeekCalls, [42.5], "the settle is not another fastSeek");
  assert.equal(video.currentTime, 42.5, "the release lands precisely");
});
