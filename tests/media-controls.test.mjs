import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMediaControls, claimMediaSession, MEDIA_SESSION_SYNC_EVENTS } from "../src/shell/media.js";
import { CTX_RESPONSE_TYPE } from "../src/shared/context.js";

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
  controls.endBoost(1);
  controls.pause();
  await controls.togglePlay();
  await controls.play();

  assert.deepEqual(snap(), before, "no control touches the video before load");
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
  const { dom, video, controls } = makeEnv(4);
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
  const metadatum = [];
  const session = {
    positions,
    metadatum,
    setActionHandler() {},
    setPositionState(state) {
      positions.push({ ...state });
    }
  };
  // media.js assigns session.metadata (null on teardown); capture non-null
  // writes so the title fix can be asserted instead of swallowed by a plain
  // property.
  Object.defineProperty(session, "metadata", {
    get() {
      return null;
    },
    set(value) {
      if (value) {
        metadatum.push(value);
      }
    }
  });
  return session;
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

// jsdom's `window.top` is non-configurable, so an unreachable ancestor is
// simulated with a Proxy whose `top` exposes only an unreadable location
// (SecurityError), exactly like a cross-origin top from inside a frame.
const crossOriginFrame = (win) => new Proxy(win, {
  get(target, prop, receiver) {
    if (prop === "top") {
      const opaque = {};
      Object.defineProperty(opaque, "location", {
        get() {
          const err = new Error("cross-origin top");
          err.name = "SecurityError";
          throw err;
        }
      });
      return opaque;
    }
    return Reflect.get(target, prop, receiver);
  }
});

test("MediaSession metadata title resolves to the parent-page title via the frame bridge", async () => {
  const { dom, video, controls } = makeEnv(4);
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  dom.window.document.title = "embed frame title";

  const session = makeSession();
  // jsdom rejects AbortSignals from the Node realm; lend the DOM realm's.
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = crossOriginFrame(dom.window);
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  const scope = new AbortController();

  let nonce = null;
  const originalPost = dom.window.parent.postMessage.bind(dom.window.parent);
  dom.window.parent.postMessage = (msg) => { nonce = msg.nonce; };
  try {
    claimMediaSession({ controls, video, signal: scope.signal, session });

    // Instant sync placeholder: this window's own title until the bridge settles.
    assert.equal(session.metadatum.at(-1).title, "embed frame title");

    dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      data: { type: CTX_RESPONSE_TYPE, nonce, domain: "hub", path: "/embed/1", title: "Parent Page" },
      origin: "https://hub.test",
      source: dom.window.parent
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.metadatum.length, 2, "placeholder then bridged parent title - never clobbered");
    assert.equal(session.metadatum.at(-1).title, "Parent Page", "parent-page title wins over the embed's own");
  } finally {
    dom.window.parent.postMessage = originalPost;
    scope.abort();
  }
});
