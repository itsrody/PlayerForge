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
  // Floor passes immediately so the test isolates the epsilon gate.
  TUNING.resume.saveIntervalMs = 0;
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

test("wall floor gates incremental timeupdate saves but never the pause flush", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "bbb", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // The real 60s floor: elapsed wall time in a test never reaches it.
  TUNING.resume.saveIntervalMs = 60000;
  shell.paused = false;
  shell.currentTime = 0;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.currentTime = 10; // far past epsilon, but inside the wall floor
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 0, "incremental save blocked by the wall floor");

  shell.paused = true;
  video.dispatchEvent(new dom.window.Event("pause"));
  assert.equal(stored(), 10, "pause flush bypasses the wall floor");
  tracker.destroy();
});

test("already-playing video persists on its first qualifying timeupdate - no interval", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "ccc", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.saveIntervalMs = 0;
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
    TUNING.resume.saveIntervalMs = 0;
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

test("pause flush uses the rendered frame's mediaTime and cancels superseded frames", async () => {
  // jsdom has no requestVideoFrameCallback, so the fallback branch above is the
  // only one the other tests can reach. This installs a frame clock so the
  // Gecko path (platform/capabilities.json: requestVideoFrameCallback) is
  // actually exercised rather than merely declared.
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "ccc", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  const queued = new Map();
  const cancelled = [];
  let next = 1;
  video.requestVideoFrameCallback = (cb) => {
    const id = next++;
    queued.set(id, cb);
    return id;
  };
  video.cancelVideoFrameCallback = (id) => {
    cancelled.push(id);
    queued.delete(id);
  };
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;
  const pause = () => video.dispatchEvent(new dom.window.Event("pause"));
  const deliverFrame = (mediaTime) => {
    const [id, cb] = [...queued][0];
    queued.delete(id);
    cb(0, { mediaTime });
  };

  // The decoder position is a decoy: it leads the display, so saving it would
  // move the resume marker to a frame the user never saw.
  shell.currentTime = 10;
  pause();
  assert.equal(queued.size, 1, "pause defers the save to the next frame instead of writing currentTime");
  assert.equal(stored(), 0, "nothing is persisted until the frame arrives");

  shell.currentTime = 999;
  deliverFrame(42);
  assert.equal(stored(), 42, "the rendered frame's mediaTime wins over currentTime");

  // A second pause supersedes the still-pending frame rather than stacking a
  // second save; ids are not AbortSignal-cancellable, so this is explicit.
  pause();
  const pending = [...queued][0][0];
  pause();
  assert.deepEqual(cancelled, [pending], "the superseded frame callback is cancelled");

  // A frame still outstanding at teardown must not fire into a dead tracker.
  const outstanding = [...queued][0][0];
  tracker.destroy();
  assert.ok(cancelled.includes(outstanding), "destroy() cancels the pending frame callback");
});
