import test from "node:test";
import assert from "node:assert/strict";

/**
 * The dropped-frame report (ARCHITECTURE §2.5, §6 item 6): the counters
 * come from `getVideoPlaybackQuality()` and Gecko's mozPresented/mozPainted
 * pair, and rVFC contributes only the edge the sample is taken on.
 *
 * Every test drives a hand-built video rather than a jsdom one: jsdom's
 * HTMLVideoElement has no quality API, so it would take the inert
 * registration path and prove nothing. The quality set is probed on the
 * element itself - all three or nothing, same rule the sampler enforces.
 */

class FakeVideoElement {}
FakeVideoElement.prototype.requestVideoFrameCallback = () => 0;
FakeVideoElement.prototype.getVideoPlaybackQuality = () => ({ droppedVideoFrames: 0 });
FakeVideoElement.prototype.mozPresentedFrames = 0;
FakeVideoElement.prototype.mozPaintedFrames = 0;
globalThis.HTMLVideoElement = FakeVideoElement;

const { setDebugRuntime, watchFrameQuality } = await import("../src/shared/diagnostics.js");

/**
 * A video with controllable counters and a hand-rolled rVFC queue. `rvfc: false`
 * omits the method entirely, which is the per-element case the engine-level
 * flag cannot see - resume.js and diagnostics.js both probe it on the element
 * for exactly that reason.
 */
function makeVideo({ rvfc = true, moz = true } = {}) {
  const listeners = new Map();
  const video = {
    paused: true,
    ended: false,
    seeking: false,
    quality: { droppedVideoFrames: 0, corruptedVideoFrames: 0, totalVideoFrames: 0 },
    pending: new Map(),
    cancelled: [],
    nextHandle: 1,
    ...(moz ? { mozPresentedFrames: 0, mozPaintedFrames: 0 } : {}),
    getVideoPlaybackQuality() {
      return { ...this.quality };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(fn);
      if (index !== -1) {
        list.splice(index, 1);
      }
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn();
      }
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
    /** Deliver one queued frame; false when the presentation edge is not armed. */
    deliverFrame() {
      const next = video.pending.entries().next();
      if (next.done) {
        return false;
      }
      const [handle, callback] = next.value;
      video.pending.delete(handle);
      callback();
      return true;
    }
  };
  if (rvfc) {
    video.requestVideoFrameCallback = (callback) => {
      const handle = video.nextHandle++;
      video.pending.set(handle, callback);
      return handle;
    };
    video.cancelVideoFrameCallback = (handle) => {
      video.cancelled.push(handle);
      video.pending.delete(handle);
    };
  }
  return video;
}

/** Move the three counters together by `n`, the healthy-cadence shape. */
function present(video, n) {
  video.mozPresentedFrames += n;
  video.mozPaintedFrames += n;
}

/**
 * Run `body` with one fresh video, capturing warnings. Disposed and switched
 * off on the way out either way: a registered entry outlives the test that
 * made it otherwise, and would start sampling in the next one.
 */
function withVideo(body, { rvfc = true, moz = true } = {}) {
  const originalWarn = console.warn;
  const warnings = [];
  const video = makeVideo({ rvfc, moz });
  console.warn = (...args) => warnings.push(args.join(" "));
  const dispose = watchFrameQuality(video);
  try {
    body({ video, warnings, dispose });
  } finally {
    dispose();
    setDebugRuntime(false);
    console.warn = originalWarn;
  }
}

/** A frame clock without the slow-frame verdicts: every gap is 16ms. */
function withFrameClock(body) {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  const queued = [];
  let nextId = 1;
  let clock = 0;
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queued.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const index = queued.findIndex((frame) => frame.id === id);
    if (index !== -1) {
      queued.splice(index, 1);
    }
  };
  const step = (t) => {
    clock = t;
    queued.shift().cb(t);
  };
  const advanceTo = (t) => {
    while (clock + 16 <= t) {
      step(clock + 16);
    }
  };
  try {
    body({ step, advanceTo, queued });
  } finally {
    setDebugRuntime(false);
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
  }
}

test("debug off: the media edges are never listened for and no frame is requested", () => {
  withVideo(({ video, warnings }) => {
    assert.equal(video.listenerCount("play"), 0, "nothing registered while debug is off");
    assert.equal(video.listenerCount("pause"), 0);
    video.paused = false;
    video.dispatch("play");
    video.dispatch("pause");
    assert.equal(video.pending.size, 0, "no rVFC handle outstanding");
    setDebugRuntime(true);
    setDebugRuntime(false);
    assert.equal(warnings.length, 0, "movement made while debug was off is not attributed here");
  });
});

test("frames lost before the diagnostic was armed are not reported", () => {
  withVideo(({ video, warnings }) => {
    // The element has been dropping frames all session; debug comes on now.
    video.quality.droppedVideoFrames = 9;
    video.mozPresentedFrames = 40;
    video.mozPaintedFrames = 30;
    setDebugRuntime(true);
    setDebugRuntime(false);
    assert.equal(warnings.length, 0, "the baseline read is not an interval");
  });
});

test("dropped frames are reported when debug is switched off", () => {
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    assert.equal(video.pending.size, 1, "the presentation edge is armed while playing");
    video.quality.droppedVideoFrames = 3;
    video.mozPresentedFrames = 30;
    video.mozPaintedFrames = 28;
    assert.ok(video.deliverFrame(), "a frame was presented, so the sample is taken");
    assert.equal(video.pending.size, 1, "re-armed for the next frame while still playing");
    setDebugRuntime(false);
    assert.equal(warnings.length, 1, "buffered drops are reported on the way out");
    assert.match(
      warnings[0],
      /dropped frames: 3 dropped, 30 presented, 2 never painted/,
      "the mozilla pair is reported, and never-painted is derived from it"
    );
  });
});

test("corrupted frames ride the same report as dropped ones", () => {
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    video.quality.droppedVideoFrames = 1;
    video.quality.corruptedVideoFrames = 2;
    video.mozPresentedFrames = 30;
    video.mozPaintedFrames = 28;
    assert.ok(video.deliverFrame(), "a frame was presented, so the sample is taken");
    setDebugRuntime(false);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /dropped frames: 1 dropped, 30 presented, 2 never painted, 2 corrupted/,
      "the decoder's unwatchable count is reported beside the dropped one"
    );
  });
});

test("a window with nothing lost reports nothing", () => {
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    for (let i = 0; i < 5; i += 1) {
      present(video, 60);
      video.deliverFrame();
    }
    setDebugRuntime(false);
    assert.equal(warnings.length, 0, "counters moved, but nothing was dropped");
  });
});

test("the reporting window flushes from the frame loop", () => {
  withFrameClock(({ step, advanceTo }) => {
    withVideo(({ video, warnings }) => {
      setDebugRuntime(true);
      step(0); // seeds the clock, queues the loop
      video.paused = false;
      video.dispatch("play");
      video.quality.droppedVideoFrames = 2;
      video.mozPresentedFrames = 20;
      video.mozPaintedFrames = 17;
      video.deliverFrame();
      assert.equal(warnings.length, 0, "buffered until the window boundary");
      advanceTo(6000); // crosses FLUSH_WINDOW_MS with no long frame anywhere
      assert.equal(warnings.length, 1, "reported by the rAF window, not by teardown");
      assert.match(warnings[0], /dropped frames: 2 dropped, 20 presented, 3 never painted/);
    });
  });
});

test("an element without rVFC samples at the flush instead", () => {
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    assert.equal(video.pending.size, 0, "no presentation edge to ride");
    video.quality.droppedVideoFrames = 1;
    video.mozPresentedFrames = 10;
    video.mozPaintedFrames = 10;
    setDebugRuntime(false);
    assert.equal(warnings.length, 1, "the flush carries the whole interval");
    assert.match(warnings[0], /dropped frames: 1 dropped, 10 presented, 0 never painted/);
  }, { rvfc: false });
});

test("the standard half without the moz pair registers nothing", () => {
  // All three or none, enforced on the element: Gecko reports the standard
  // presentedFrames as null, so half a quality set cannot produce the
  // submitted-versus-painted number and must not arm at all.
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    assert.equal(video.listenerCount("play"), 0, "no edges armed without the full set");
    video.dispatch("pause");
    assert.equal(warnings.length, 0, "nothing sampled, nothing reported");
    setDebugRuntime(false);
  }, { moz: false });
});

test("pause cancels the outstanding frame and playing arms it again", () => {
  withVideo(({ video }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    assert.equal(video.pending.size, 1);
    video.paused = true;
    video.dispatch("pause");
    assert.equal(video.pending.size, 0, "a stopped player holds no handle");
    assert.equal(video.cancelled.length, 1);
    // Re-arming is driven by the media edge, not by the frame callback: the
    // callback cannot fire when it has just been cancelled.
    video.paused = false;
    video.dispatch("playing");
    assert.equal(video.pending.size, 1, "armed again on play");
    video.seeking = true;
    video.dispatch("seeking");
    assert.equal(video.pending.size, 0, "seeking is a cancel edge too");
  });
});

test("a frame callback does not re-arm once the media has paused", () => {
  withVideo(({ video }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    // Pause before the callback runs: Gecko will not deliver the frame, but a
    // host that does must not leave a handle queued against a stopped video.
    video.paused = true;
    assert.ok(video.deliverFrame(), "the last frame still arrives");
    assert.equal(video.pending.size, 0, "the callback re-arms only while unpaused");
  });
});

test("a new resource rebases the counters instead of reporting the reset", () => {
  withVideo(({ video, warnings }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    video.quality.droppedVideoFrames = 6;
    video.mozPresentedFrames = 120;
    video.mozPaintedFrames = 120;
    video.deliverFrame();
    // emptied / a new src: the cumulative counters start over low, and a
    // plain subtraction would walk them backwards (-115 presented).
    video.quality.droppedVideoFrames = 2;
    video.mozPresentedFrames = 5;
    video.mozPaintedFrames = 5;
    setDebugRuntime(false);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /dropped frames: 8 dropped, 125 presented, 0 never painted/,
      "both runs count forward: 6 + 2 dropped, 120 + 5 presented, nothing fabricated"
    );
  });
});

test("disposing reports what was buffered and cancels the outstanding frame", () => {
  withVideo(({ video, warnings, dispose }) => {
    setDebugRuntime(true);
    video.paused = false;
    video.dispatch("play");
    video.quality.droppedVideoFrames = 4;
    video.mozPresentedFrames = 8;
    video.mozPaintedFrames = 6;
    video.deliverFrame();
    assert.equal(video.pending.size, 1);
    dispose();
    assert.equal(video.pending.size, 0, "the handle is cancelled, not abandoned");
    assert.equal(warnings.length, 1, "the run's drops go out with the shell");
    assert.match(warnings[0], /dropped frames: 4 dropped, 8 presented, 2 never painted/);
    // Second dispose is a no-op rather than a second report.
    dispose();
    assert.equal(warnings.length, 1);
  });
});

test("registering while debug is already on arms the entry immediately", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  const video = makeVideo();
  let dispose = null;
  try {
    setDebugRuntime(true);
    dispose = watchFrameQuality(video);
    assert.equal(video.listenerCount("play"), 1, "armed on registration, not on the next toggle");
    video.paused = false;
    video.dispatch("play");
    assert.equal(video.pending.size, 1);
  } finally {
    dispose?.();
    setDebugRuntime(false);
    console.warn = originalWarn;
  }
});
