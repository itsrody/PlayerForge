import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const writes = {};
globalThis.GM_getValue = (key, fallback) => (key in writes ? writes[key] : fallback);
globalThis.GM_setValue = (key, value) => {
  writes[key] = value;
};

const { ResumeTracker } = await import("../src/shell/resume.js");
const { TUNING } = await import("../src/shared/tuning.js");
const { createMediaControls } = await import("../src/shell/media.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeEnv(duration) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  // jsdom rejects AbortSignals from the Node realm; lend the DOM realm's.
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  // jsdom defaults to visibilityState "prerender" (hidden), which would gate
  // every incremental checkpoint; model an active, visible page instead.
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible", configurable: true
  });
  Object.defineProperty(dom.window.document, "hidden", {
    value: false, configurable: true
  });
  const video = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video);
  if (duration != null) {
    Object.defineProperty(video, "duration", { value: duration, configurable: true });
  }
  const seeks = [];
  const toasts = [];
  const shell = {
    video,
    currentTime: 0,
    paused: true,
    seeks,
    toasts,
    media: {
      seekTo(time) {
        seeks.push(time);
        video.currentTime = time;
      }
    },
    toast(payload) {
      toasts.push(payload);
    },
    toastAction(icon, text, group, actions) {
      toasts.push({ icon, text, duration: 4000, group, actions });
    }
  };
  return { dom, video, shell };
}

test("finite duration creates the pf:resume entry without waiting", async () => {
  delete writes["pf:resume"];
  const { shell } = makeEnv(600);
  new ResumeTracker(shell);
  await flush();
  await flush();
  assert.ok(writes["pf:resume"], "store was never touched");
  assert.equal(writes["pf:resume"].entries.length, 1);
  assert.equal(writes["pf:resume"].entries[0].duration, 600);
});

test("off-screen save gate observer is disconnected on destroy", async () => {
  delete writes["pf:resume"];
  let observeCalls = 0;
  let disconnectCalls = 0;
  class FakeIO {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {
      observeCalls++;
    }
    disconnect() {
      disconnectCalls++;
    }
  }
  const realIO = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIO;
  try {
    const { shell } = makeEnv(600);
    const tracker = new ResumeTracker(shell);
    await flush();
    await flush();
    assert.equal(observeCalls, 1, "the on-screen gate armed an observer for the video");

    tracker.destroy();
    assert.equal(disconnectCalls, 1, "destroy disconnects the observer");
  } finally {
    globalThis.IntersectionObserver = realIO;
  }
});

test("missing duration waits for loadedmetadata before creating the entry", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(null);
  new ResumeTracker(shell);
  await flush();
  assert.ok(writes["pf:resume"], "store was warmed eagerly");
  assert.equal(writes["pf:resume"].entries.length, 0, "no entry created before metadata");
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  video.dispatchEvent(new dom.window.Event("loadedmetadata"));
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 1);
  assert.equal(writes["pf:resume"].entries[0].duration, 120);
});

test("late finite duration also resolves through durationchange", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(null);
  new ResumeTracker(shell);
  await flush();
  Object.defineProperty(video, "duration", { value: 90, configurable: true });
  video.dispatchEvent(new dom.window.Event("durationchange"));
  await flush();
  await flush();
  assert.ok(writes["pf:resume"]);
  assert.equal(writes["pf:resume"].entries[0].duration, 90);
});

test("destroy during the metadata wait cancels it without creating the entry", async () => {
  delete writes["pf:resume"];
  const { shell } = makeEnv(null);
  const tracker = new ResumeTracker(shell);
  await flush();
  tracker.destroy();
  await flush();
  await flush();
  assert.ok(writes["pf:resume"], "store was warmed eagerly");
  assert.equal(writes["pf:resume"].entries.length, 0, "no entry created after destroy");
});

test("the metadata wait is event-driven - error gives up with no timer involved", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(null);
  new ResumeTracker(shell);
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 0, "still waiting on media events");
  // The broken-source event is the give-up signal - no deadline is consulted.
  video.dispatchEvent(new dom.window.Event("error"));
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 0, "error ended the wait without an entry");
});

test("a saved position past the threshold seeks and toasts immediately", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{
      id: "abc123",
      domain: "youtube",
      path: "/watch",
      title: "",
      duration: 600,
      resume: 42,
      createdAt: 0,
      updatedAt: Date.now()
    }]
  };
  const { dom, video, shell } = makeEnv(600);
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  assert.deepEqual(shell.seeks, [42], "seek fires immediately without waiting for canplay");
  assert.equal(shell.toasts.length, 1);
  tracker.destroy();
});

test("resume seeks land through the real command plane even when metadata lags (MSE window)", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{
      id: "mse1",
      domain: "youtube",
      path: "/watch",
      title: "",
      duration: 600,
      resume: 42,
      createdAt: 0,
      updatedAt: Date.now()
    }]
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  const video = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video);
  // MSE preamble: the player sets duration (durationchange) while readyState
  // is still HAVE_NOTHING (0) - the resume seek must not be dropped by the
  // command plane's metadata gate.
  Object.defineProperty(video, "readyState", { value: 0, configurable: true });
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 0, configurable: true, writable: true });
  const shell = {
    video,
    currentTime: 0,
    paused: true,
    media: createMediaControls({ video }),
    toast() {},
    toastAction() {}
  };
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  assert.equal(video.currentTime, 42, "the resume position applies despite readyState 0");
  tracker.destroy();
});

test("autoplaying video seeks immediately without waiting for canplay", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{
      id: "xyz789",
      domain: "youtube",
      path: "/watch",
      title: "",
      duration: 600,
      resume: 100,
      createdAt: 0,
      updatedAt: Date.now()
    }]
  };
  const { dom, video, shell } = makeEnv(600);
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  assert.deepEqual(shell.seeks, [100], "seek fires immediately without canplay");
  assert.equal(shell.toasts.length, 1);
  tracker.destroy();
});

test("qualifying timeupdate persists progress; sub-epsilon moves do not", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "aaa", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 42, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // Span collapses to zero so the test isolates the epsilon gate.
  TUNING.resume.minCheckpointSeconds = 0;
  TUNING.resume.maxCheckpointSeconds = 0;
  shell.paused = false;
  shell.currentTime = 42;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 45; // +3 from last save: exactly at epsilon, qualifies
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 45, "3s of motion persists");

  shell.currentTime = 46; // +1 since the last save: under epsilon, skipped
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 45, "sub-epsilon drift does not persist");
  tracker.destroy();
});

test("content span gates incremental timeupdate saves but never the pause flush", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "bbb", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // Pin the span wide: a 10s advance is far past epsilon but inside the span.
  TUNING.resume.minCheckpointSeconds = 60;
  TUNING.resume.maxCheckpointSeconds = 60;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 10; // far past epsilon, but inside the content span
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 0, "incremental save blocked by the content span");

  shell.paused = true;
  video.dispatchEvent(new dom.window.Event("pause"));
  assert.equal(stored(), 10, "pause flush bypasses the content span");
  tracker.destroy();
});

test("already-playing video persists on its first qualifying timeupdate - no interval", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "ccc", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.minCheckpointSeconds = 0;
  TUNING.resume.maxCheckpointSeconds = 0;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;
  assert.equal(stored(), 0);

  shell.currentTime = 5;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 5, "the media clock covers autoplay without a timer");
  tracker.destroy();
});

test("off-screen IntersectionObserver observation gates incremental resume saves", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "ddd", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  // Install a controllable IO whose callbacks we fire manually, driving the
  // on-screen gate the production code consults on every timeupdate.
  const RealIO = globalThis.IntersectionObserver;
  let callback = null;
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe() {}
    disconnect() {}
  };
  try {
    const { dom, video, shell } = makeEnv(600);
    TUNING.resume.minCheckpointSeconds = 0;
    TUNING.resume.maxCheckpointSeconds = 0;
    shell.paused = false;
    shell.currentTime = 0;
    const tracker = new ResumeTracker(shell);
    await flush();
    await flush();
    await flush();
    const stored = () => writes["pf:resume"].entries[0].resume;
    assert.equal(stored(), 0);

    // Player scrolls off-screen: subsequent media-clock saves are suppressed.
    callback([{ isIntersecting: false }]);
    shell.currentTime = 7;
    video.dispatchEvent(new dom.window.Event("timeupdate"));
    assert.equal(stored(), 0, "off-screen video did not persist on timeupdate");

    // Back on-screen: saves resume.
    callback([{ isIntersecting: true }]);
    shell.currentTime = 9;
    video.dispatchEvent(new dom.window.Event("timeupdate"));
    assert.equal(stored(), 9, "on-screen video persisted once visible");

    // The pause flush still lands even while off-screen (never loses final pos).
    callback([{ isIntersecting: false }]);
    shell.paused = true;
    shell.currentTime = 15; // >3s past 9 => clears the epsilon gate
    video.dispatchEvent(new dom.window.Event("pause"));
    assert.equal(stored(), 15, "pause flush bypasses the visibility gate");

    tracker.destroy();
  } finally {
    globalThis.IntersectionObserver = RealIO;
  }
});

test("SPA route change flushes the leaving entry and adopts the new route's media", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.minCheckpointSeconds = 0;
  TUNING.resume.maxCheckpointSeconds = 0;
  shell.paused = false;
  shell.currentTime = 100;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 1);
  assert.equal(writes["pf:resume"].entries[0].path, "/watch");

  // Watch some progress, then let the SPA push a different route.
  shell.currentTime = 120;
  dom.window.history.pushState({}, "", "/shorts/xyz");
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  await flush();
  await flush();

  const entries = () => writes["pf:resume"].entries;
  const watchEntry = () => entries().find((e) => e.path === "/watch");
  assert.equal(watchEntry().resume, 120, "navigation flushed the position being left behind");

  // The element selects the new resource: loadstart resets the playhead, and
  // a pause flush landing inside that window must not clobber the entry the
  // navigation flush just wrote (saves are muted until re-adoption).
  video.dispatchEvent(new dom.window.Event("loadstart"));
  shell.currentTime = 0;
  video.dispatchEvent(new dom.window.Event("pause"));
  await flush();
  await flush();
  await flush();

  assert.equal(entries().length, 2, "the new route earned its own entry");
  const next = entries().find((e) => e.path === "/shorts/xyz");
  assert.ok(next, "an entry exists keyed by the new path");
  assert.equal(next.duration, 600, "the re-adopted entry uses the resource's own duration");
  assert.equal(watchEntry().resume, 120, "the swap-window pause did not stamp 0 onto the leaving entry");

  tracker.destroy();
});

test("a hash-only navigation does not re-adopt - same path, same entry", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(600);
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 1);

  // pathname is untouched by a fragment change; only the hash moves.
  dom.window.history.pushState({}, "", "/watch#chapter=2");
  dom.window.dispatchEvent(new dom.window.Event("popstate"));
  await flush();
  await flush();
  // Arm would have happened only if the path differed; a loadstart here is a
  // resource swap that must NOT be claimed by this tracker's route logic.
  video.dispatchEvent(new dom.window.Event("loadstart"));
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries.length, 1, "no re-adoption for a same-path navigation");

  tracker.destroy();
});

/* --- Dynamic content cadence + playback-status flushes ---------------- */

test("the checkpoint span scales with duration rather than wall time", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "span1", domain: "youtube", path: "/watch", title: "", duration: 6000, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(6000);
  // Defaults: 0.01 * 6000 = 60s span.
  TUNING.resume.checkpointRatio = 0.01;
  TUNING.resume.minCheckpointSeconds = 10;
  TUNING.resume.maxCheckpointSeconds = 60;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 30; // under the duration-derived 60s span
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 0, "no checkpoint under the duration-scaled span");

  shell.currentTime = 61;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 61, "checkpoint at the duration-scaled span");
});

test("a seeked flush persists the landed position, bypassing the span", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "seek1", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // Wide span: only the explicit seek flush can write.
  TUNING.resume.minCheckpointSeconds = 60;
  TUNING.resume.maxCheckpointSeconds = 60;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 300;
  video.dispatchEvent(new dom.window.Event("seeked"));
  assert.equal(stored(), 300, "the seek target persists immediately");
});

test("ended resets the entry so the next visit restarts", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "end1", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.minCheckpointSeconds = 0;
  TUNING.resume.maxCheckpointSeconds = 0;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 300;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 300);

  shell.currentTime = 600;
  video.dispatchEvent(new dom.window.Event("ended"));
  assert.equal(stored(), 0, "completion resets the entry");
});

test("a hidden tab flushes and suspends checkpoints until visible again", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "vis1", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.minCheckpointSeconds = 0;
  TUNING.resume.maxCheckpointSeconds = 0;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;
  const doc = dom.window.document;

  shell.currentTime = 25;
  Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
  Object.defineProperty(doc, "hidden", { value: true, configurable: true });
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(stored(), 25, "hiding flushes the position immediately");

  shell.currentTime = 40;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 25, "checkpoints are suspended while hidden");

  Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(doc, "hidden", { value: false, configurable: true });
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  shell.currentTime = 45;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 45, "checkpoints resume once visible again");
});

test("pagehide and freeze flush the final position", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "life1", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // Wide span: only the lifecycle flushes can write.
  TUNING.resume.minCheckpointSeconds = 60;
  TUNING.resume.maxCheckpointSeconds = 60;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 25;
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(stored(), 25, "pagehide flushes the final position");

  shell.currentTime = 50;
  dom.window.document.dispatchEvent(new dom.window.Event("freeze"));
  assert.equal(stored(), 50, "freeze flushes the final position");
});

test("the rVFC crank checkpoints on presented frames within the dynamic span", async (t) => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "rvfc1", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.minCheckpointSeconds = 10;
  TUNING.resume.maxCheckpointSeconds = 10;
  shell.paused = false;
  shell.currentTime = 0;
  let frameCb = null;
  video.requestVideoFrameCallback = (cb) => {
    frameCb = cb;
    return 1;
  };
  video.cancelVideoFrameCallback = () => {
    frameCb = null;
  };
  const tracker = new ResumeTracker(shell);
  t.after(() => tracker.destroy());
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  assert.equal(typeof frameCb, "function", "the crank armed a frame callback");
  frameCb(0, { mediaTime: 4 });
  assert.equal(stored(), 0, "a frame under the span does not checkpoint");
  assert.equal(typeof frameCb, "function", "the crank re-armed itself");

  frameCb(0, { mediaTime: 12 });
  assert.equal(stored(), 12, "a presented frame past the span checkpoints");
});
