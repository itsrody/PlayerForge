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
  const { shell } = makeEnv(600);
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
  const { video, shell } = makeEnv(600);
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

test("pause exit flush uses the rendered frame's mediaTime and cancels superseded frames", async () => {
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
  // The activity reads the shell's paused property at event time, so the
  // harness flips it exactly as Gecko would before firing the edge.
  const play = () => {
    shell.paused = false;
    video.dispatchEvent(new dom.window.Event("play"));
  };
  const pause = () => {
    shell.paused = true;
    video.dispatchEvent(new dom.window.Event("pause"));
  };
  const deliverFrame = (mediaTime) => {
    const [id, cb] = [...queued][0];
    queued.delete(id);
    cb(0, { mediaTime });
  };

  // The flush belongs to the exit edge, so playback must have started.
  play();

  // The decoder position is a decoy: it leads the display, so saving it would
  // move the resume marker to a frame the user never saw.
  shell.currentTime = 10;

  pause();
  assert.equal(queued.size, 1, "the exit flush defers the save to the next frame instead of writing currentTime");
  assert.equal(stored(), 0, "nothing is persisted until the frame arrives");

  shell.currentTime = 999;
  deliverFrame(42);
  assert.equal(stored(), 42, "the rendered frame's mediaTime wins over currentTime");

  // A quick play/pause cycle while a frame is still outstanding supersedes it
  // rather than stacking a second save; rVFC ids are not AbortSignal-
  // cancellable, so this is explicit.
  play();
  pause();
  const pending = [...queued][0][0];
  play();
  pause();
  assert.deepEqual(cancelled, [pending], "the superseded frame callback is cancelled");

  // A frame still outstanding at teardown must not fire into a dead tracker.
  const outstanding = [...queued][0][0];
  tracker.destroy();
  assert.ok(cancelled.includes(outstanding), "destroy() cancels the pending frame callback");
});

test("a paused seek persists the settled position; the detached clock cannot", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "seek", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 0, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  // The wall floor suppresses incremental saves, so the seek must bypass it.
  TUNING.resume.saveIntervalMs = 60000;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  const stored = () => writes["pf:resume"].entries[0].resume;

  shell.paused = false;
  video.dispatchEvent(new dom.window.Event("play"));
  shell.currentTime = 30;
  shell.paused = true;
  video.dispatchEvent(new dom.window.Event("pause"));
  assert.equal(stored(), 30, "the exit flush persists the pre-seek position");

  // The clock listener is gone while paused (and the floor would block a
  // qualifying move anyway), so an incremental tick cannot save the scrub.
  shell.currentTime = 300;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(stored(), 30, "no clock save while paused");

  // The seeked edge is the one that carries a paused scrub.
  video.dispatchEvent(new dom.window.Event("seeked"));
  assert.equal(stored(), 300, "paused seek persisted the settled position");

  tracker.destroy();
});

test("a completed video resets the STORED position, not just the in-memory one [regression]", async () => {
  // #entry is the store's own live entry object, so pre-assigning
  // entry.resume = 0 made updateResume's no-op guard see 0 === 0, return
  // early and skip #persist(). The in-memory value read 0 so the reset looked
  // like it worked, but the finished video kept its ~95% position on disk and
  // resumed near the end on every visit.
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "bbb", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 570, createdAt: 0, updatedAt: Date.now() }]
  };
  const { dom, video, shell } = makeEnv(600);
  TUNING.resume.saveIntervalMs = 0;
  shell.paused = false;
  shell.currentTime = 570;
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  assert.equal(writes["pf:resume"].entries[0].resume, 570, "restored position is in storage");

  // 595/600 = 99.2% - past the completion ratio.
  shell.currentTime = 595;
  video.dispatchEvent(new dom.window.Event("timeupdate"));
  assert.equal(writes["pf:resume"].entries[0].resume, 0,
    "completion reset must reach disk, otherwise the video resumes near the end forever");
  tracker.destroy();
});

test("destroy while paused at 0 stores 0, not a NaN that serializes to null [regression]", async () => {
  writes["pf:resume"] = {
    version: 1,
    entries: [{ id: "ccc", domain: "youtube", path: "/watch", title: "", duration: 600, resume: 120, createdAt: 0, updatedAt: 1 }]
  };
  const { shell } = makeEnv(600);
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  await flush();
  shell.currentTime = 0;
  shell.paused = true;
  tracker.destroy();
  const entry = writes["pf:resume"].entries[0];
  assert.equal(entry.resume, 0, "a real 0 position must not become NaN -> null");
  assert.notEqual(entry.resume, null);
});

test("two players in one document share one store, so a delete cannot come back", async () => {
  // There is one resume store per document. Each tracker used to build its own,
  // so a row deleted through one player's History was rewritten by the other
  // player's next save out of its stale copy - the user deleted a row and it
  // reappeared. Sharing the store makes the second player's save land on the
  // state the delete already pruned.
  delete writes["pf:resume"];
  const subscribes = [];
  globalThis.GM_addValueChangeListener = (key, cb) => {
    subscribes.push({ key, cb });
    return `sub${subscribes.length}`;
  };
  globalThis.GM_removeValueChangeListener = () => {};

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;

  const shellFor = () => {
    const video = dom.window.document.createElement("video");
    dom.window.document.body.appendChild(video);
    Object.defineProperty(video, "duration", { value: 600, configurable: true });
    return {
      video,
      currentTime: 0,
      paused: true,
      seeks: [],
      toasts: [],
      media: { seekTo(t) { this.video.currentTime = t; } },
      toast() {},
      toastAction() {}
    };
  };

  const first = new ResumeTracker(shellFor());
  await flush();
  await flush();
  const second = new ResumeTracker(shellFor());
  await flush();
  await flush();

  const id = first.getEntries()[0]?.id;
  assert.ok(id, "the first tracker created the entry");
  assert.equal(subscribes.length, 1, `one document means one pf:resume subscription, got ${subscribes.length}`);
  assert.equal(second.getEntries().length, 1, "the second player sees the same entry");

  // Player 1 deletes it from History.
  first.removeEntry(id);
  assert.equal(writes["pf:resume"].entries.length, 0, "the delete reached storage");
  assert.equal(second.getEntries().length, 0, "and the other player's list, live");

  // Player 2's next save must have nothing to write back.
  second.resetEntry(id);
  assert.equal(writes["pf:resume"].entries.length, 0, "a sibling player must not resurrect the deleted row");

  first.destroy();
  second.destroy();
  globalThis.GM_addValueChangeListener = undefined;
  globalThis.GM_removeValueChangeListener = undefined;
});

test("a cross-tab write reaches every player's History list", async () => {
  delete writes["pf:resume"];
  let deliver = null;
  globalThis.GM_addValueChangeListener = (key, cb) => {
    deliver = cb;
    return "sub";
  };
  globalThis.GM_removeValueChangeListener = () => {};

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;

  const shellFor = () => {
    const video = dom.window.document.createElement("video");
    dom.window.document.body.appendChild(video);
    Object.defineProperty(video, "duration", { value: 600, configurable: true });
    return {
      video, currentTime: 0, paused: true, seeks: [], toasts: [],
      media: { seekTo(t) { this.video.currentTime = t; } }, toast() {}, toastAction() {}
    };
  };

  const first = new ResumeTracker(shellFor());
  await flush();
  await flush();
  const second = new ResumeTracker(shellFor());
  await flush();
  await flush();

  const structural = [];
  first.onChange((s) => structural.push(["first", s]));
  second.onChange((s) => structural.push(["second", s]));

  // Another tab writes a brand-new row.
  const now = Date.now();
  deliver("pf:resume", null, {
    version: 1,
    entries: [{
      id: "from-another-tab", domain: "youtube", path: "/elsewhere", title: "Elsewhere",
      duration: 600, resume: 5, createdAt: now, updatedAt: now
    }]
  }, true);

  assert.equal(first.getEntries().length, 2, "player 1 adopted the foreign row");
  assert.equal(second.getEntries().length, 2, "player 2 sees it too, without its own read");
  assert.deepEqual(
    structural.filter(([, s]) => s).map(([who]) => who),
    ["first", "second"],
    "both History lists were told to re-render"
  );

  first.destroy();
  second.destroy();
  globalThis.GM_addValueChangeListener = undefined;
  globalThis.GM_removeValueChangeListener = undefined;
});
/** A bare document, distinct per call, with the globals the tracker reads. */
function newDoc() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.AbortController = dom.window.AbortController;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  return dom.window.document;
}

/**
 * A shell anchored to a NEW video in the current document, so several shells
 * can share one document - which is the only arrangement in which they share
 * one resume store, and therefore the only arrangement that can test sharing.
 */
function makeShellIn(doc, duration = 600) {
  const video = doc.createElement("video");
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  doc.body.appendChild(video);
  const seeks = [];
  return {
    video,
    currentTime: 0,
    paused: true,
    seeks,
    toasts: [],
    media: {
      seekTo(time) {
        seeks.push(time);
        video.currentTime = time;
      }
    },
    toast() {},
    toastAction() {}
  };
}

test("a destroyed tracker stops hearing store changes while a sibling keeps them", async () => {
  // The shared store outlives any single player, so a History panel whose shell
  // was torn down must not stay subscribed to it. Before the unsubscribe was
  // bound to the tracker's own scope, the stale callback kept running for as
  // long as ANY tracker in the document lived, re-rendering a detached shadow
  // root on every cross-tab write.
  delete writes["pf:resume"];
  const subscribes = [];
  globalThis.GM_addValueChangeListener = (key, cb) => {
    subscribes.push({ key, cb });
    return `sub${subscribes.length}`;
  };
  globalThis.GM_removeValueChangeListener = () => {};

  const doc = newDoc();
  const first = new ResumeTracker(makeShellIn(doc));
  const second = new ResumeTracker(makeShellIn(doc));
  await flush();
  await flush();

  const heard = [];
  first.onChange(() => heard.push("first"));
  second.onChange(() => heard.push("second"));

  first.destroy();

  const now = Date.now();
  // One shared store, so one subscription carries the write to every listener.
  // The GM callback is (name, oldValue, newValue, remote).
  const listener = subscribes.find((s) => s.key === "pf:resume");
  listener.cb(
    "pf:resume",
    null,
    {
      version: 1,
      entries: [{
        id: "after-teardown", domain: "youtube", path: "/later", title: "Later",
        duration: 600, resume: 9, createdAt: now, updatedAt: now
      }]
    },
    true
  );

  assert.deepEqual(heard, ["second"], "only the surviving tracker's listener ran");
  assert.equal(second.getEntries().length, 2, "the live store still absorbed the write");

  second.destroy();
  globalThis.GM_addValueChangeListener = undefined;
  globalThis.GM_removeValueChangeListener = undefined;
});

test("a tracker destroyed after its document was replaced still releases its store", async () => {
  // The release has to name the realm the store was acquired against. Recomputing
  // "the current document" at teardown time loses the WeakMap entry, and then
  // nothing ever destroys the store: its GM subscription outlives every tracker,
  // and the next document builds a SECOND store on pf:resume - which is the
  // divergent-copies bug the sharing exists to prevent.
  delete writes["pf:resume"];
  const subscribes = [];
  const removed = [];
  globalThis.GM_addValueChangeListener = (key, cb) => {
    subscribes.push({ key, cb });
    return `sub${subscribes.length}`;
  };
  globalThis.GM_removeValueChangeListener = (id) => removed.push(id);

  const docA = newDoc();
  const doomed = new ResumeTracker(makeShellIn(docA));
  await flush();
  const docB = newDoc();
  const live = new ResumeTracker(makeShellIn(docB));
  await flush();

  assert.equal(
    subscribes.length,
    2,
    "each document built its own store, rather than one store spanning both"
  );

  doomed.destroy();
  assert.deepEqual(
    removed,
    ["sub1"],
    "the abandoned document's subscription was removed even though it was no longer current"
  );

  live.destroy();
  assert.deepEqual(removed, ["sub1", "sub2"], "the live document's store releases on its own turn");
  globalThis.GM_addValueChangeListener = undefined;
  globalThis.GM_removeValueChangeListener = undefined;
});

test("a throwing store subscriber never aborts its peers", async () => {
  // Dispatch isolation, matching the status/fullscreen fan-outs: History
  // rendering throwing must not silence later subscribers or escape.
  delete writes["pf:resume"];
  const { shell } = makeEnv(600);
  const tracker = new ResumeTracker(shell);
  const seen = [];
  tracker.onChange(() => { throw new Error("render boom"); });
  tracker.onChange((structural) => seen.push(structural));
  await flush();
  await flush();
  assert.ok(seen.includes(true), "the peer still heard the structural adoption");
  tracker.destroy();
});

test("same-millisecond cross-tab writes converge on content, not direction", async () => {
  // Two documents share one GM table but keep separate stores. Same-id,
  // same-millisecond writes with different positions must converge on one
  // winner whichever direction the merge runs, or the tabs diverge forever.
  delete writes["pf:resume"];
  const envA = makeEnv(600);
  const envB = makeEnv(600);
  const trackerA = new ResumeTracker(envA.shell);
  const trackerB = new ResumeTracker(envB.shell);
  await flush();
  await flush();
  const template = { ...trackerA.getEntries()[0] };
  const stamp = template.updatedAt;
  const doc = (resume) => JSON.stringify({
    version: 1,
    entries: [{ ...template, resume, updatedAt: stamp }]
  });
  trackerA.importResume(doc(10));
  trackerB.importResume(doc(20));
  trackerA.importResume(trackerB.exportResume());
  trackerB.importResume(trackerA.exportResume());
  assert.equal(trackerA.getEntries()[0].resume, 20, "A converged on the content winner");
  assert.equal(trackerB.getEntries()[0].resume, 20, "B converged on the same winner");
  trackerA.destroy();
  trackerB.destroy();
});

test("Start over persists the reset instead of waiting for the next tick", async () => {
  // A seeded 300s marker raises the resume toast; the action must write 0
  // now - closing the tab before another save would otherwise resurrect the
  // old marker.
  delete writes["pf:resume"];
  const { hashEntry } = await import("../src/shared/context.js");
  const now = Date.now();
  writes["pf:resume"] = {
    version: 1,
    entries: [{
      id: hashEntry("youtube", "/watch", 600),
      domain: "youtube",
      path: "/watch",
      title: "T",
      duration: 600,
      resume: 300,
      createdAt: now,
      updatedAt: now
    }]
  };
  const { shell } = makeEnv(600);
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  const toast = shell.toasts.find((t) => t.actions?.length);
  assert.ok(toast, "the saved marker raised the resume toast");
  assert.equal(shell.seeks.at(-1), 300, "adopt sought the marker");
  toast.actions[0].onClick();
  assert.equal(tracker.getEntries()[0].resume, 0, "the reset landed on disk now, not next tick");
  assert.equal(shell.seeks.at(-1), 0);
  tracker.destroy();
});

test("import drops pending entries instead of displaying dead rows", async () => {
  // Pending imports are provisional and never resumable: like the load-time
  // purge, they join nothing rather than sitting visible-but-dead until reload.
  delete writes["pf:resume"];
  const { shell } = makeEnv(600);
  const tracker = new ResumeTracker(shell);
  await flush();
  await flush();
  const ghost = {
    id: "ghost", domain: "youtube", path: "/ghost", title: "G",
    duration: 600, resume: 10, createdAt: 1, updatedAt: Date.now(), pending: true
  };
  const result = tracker.importResume(JSON.stringify({ version: 1, entries: [ghost] }));
  assert.equal(result.added, 0, "provisional imports join nothing");
  assert.ok(!tracker.getEntries().some((e) => e.id === "ghost"), "no dead row until reload");
  tracker.destroy();
});
