import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const writes = {};
globalThis.GM_getValue = (key, fallback) => (key in writes ? writes[key] : fallback);
globalThis.GM_setValue = (key, value) => {
  writes[key] = value;
};

const { ResumeTracker } = await import("../src/shell/resume.js");

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
  const shell = {
    video,
    currentTime: 0,
    paused: true,
    seeks: [],
    toasts: [],
    seek(time) {
      this.seeks.push(time);
      video.currentTime = time;
    },
    toast(payload) {
      this.toasts.push(payload);
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

test("missing duration waits for loadedmetadata before touching the store", async () => {
  delete writes["pf:resume"];
  const { dom, video, shell } = makeEnv(null);
  new ResumeTracker(shell);
  await flush();
  assert.equal(writes["pf:resume"], undefined, "store touched before metadata");
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
  video.dispatchEvent(new dom.window.Event("loadedmetadata"));
  await flush();
  await flush();
  assert.ok(writes["pf:resume"]);
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

test("destroy during the metadata wait cancels it without touching the store", async () => {
  delete writes["pf:resume"];
  const { shell } = makeEnv(null);
  const tracker = new ResumeTracker(shell);
  await flush();
  tracker.destroy();
  await flush();
  await flush();
  assert.equal(writes["pf:resume"], undefined);
});

test("a saved position past the threshold seeks and toasts on play", async () => {
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
  new ResumeTracker(shell);
  await flush();
  await flush();
  video.dispatchEvent(new dom.window.Event("play"));
  await flush();
  assert.deepEqual(shell.seeks, [42]);
  assert.equal(shell.toasts.length, 1);
});
