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

  // Replicate the shell's one-line fan-out (#forwardMediaEvents) over the
  // exported cadence set - the seam under test IS this set.
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
