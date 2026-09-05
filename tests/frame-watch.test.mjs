import test from "node:test";
import assert from "node:assert/strict";
import { onFrame } from "../src/kernel/proxy/frame-watch.js";

/**
 * The unified requestVideoFrameCallback seam (§7.8) is a pure funnel over the
 * element's own method, so every consumer (element-route watchdog, resume
 * pause flush) shares one subscription contract. Tests drive a stub video
 * whose requestVideoFrameCallback records the callback it is handed.
 */

function makeVideo({ noMethod = false } = {}) {
  const video = { callbacks: [], removed: [], listeners: {} };
  if (!noMethod) {
    video.requestVideoFrameCallback = (cb) => {
      video.callbacks.push(cb);
      return video.handle = video.callbacks.length;
    };
  }
  video.cancelVideoFrameCallback = (handle) => video.removed.push(handle);
  video.addEventListener = (type, fn) => (video.listeners[type] ??= []).push(fn);
  video.removeEventListener = (type, fn) => {
    video.listeners[type] = (video.listeners[type] ?? []).filter((f) => f !== fn);
  };
  return video;
}

test("onFrame fires the callback once on the next composited frame and unsubscribes", () => {
  const video = makeVideo();
  const seen = [];
  const ok = onFrame(video, (_now, metadata) => seen.push(metadata));
  assert.equal(ok, true, "the method exists so a request is armed");
  assert.equal(video.callbacks.length, 1, "exactly one rVFC request was armed");

  video.callbacks[0](0, { mediaTime: 12.5 });
  assert.deepEqual(seen, [{ mediaTime: 12.5 }], "the frame metadata reached the consumer");
  video.callbacks[0](0, { mediaTime: 99 });
  assert.equal(seen.length, 1, "a second frame does not re-fire (self-unsubscribing)");
  assert.deepEqual(video.removed, [1], "the pending rVFC handle was cancelled");
  assert.equal(video.listeners.error?.length ?? 0, 0, "error listeners were detached");
});

test("onFrame fires onPast on a media error and detaches listeners", () => {
  const video = makeVideo();
  video.addEventListener("error", () => {});
  const past = [];
  onFrame(video, () => { past.push("frame"); }, { onPast: () => past.push("past") });
  assert.equal(video.listeners.error.length, 2, "the error path keeps the page's own listener plus ours");
  video.listeners.error[1]();
  assert.deepEqual(past, ["past"], "the no-frame path won");
  assert.equal(video.listeners.error.length, 1, "only our error listener detached");
});

test("onFrame fires onPast on ended and does not double-fire", () => {
  const video = makeVideo();
  const events = [];
  onFrame(video, () => events.push("frame"), { onPast: () => events.push("past1") });
  video.listeners.ended[0]();
  assert.deepEqual(events, ["past1"]);
  video.listeners.error?.[0]?.();
  assert.deepEqual(events, ["past1"], "error after ended is ignored (already done)");
});

test("an aborted signal fires onPast and cancels the pending request", () => {
  const video = makeVideo();
  const ac = new AbortController();
  const events = [];
  onFrame(video, () => events.push("frame"), { onPast: () => events.push("past"), signal: ac.signal });
  ac.abort();
  assert.deepEqual(events, ["past"], "abort is the past path");
  assert.deepEqual(video.removed, [1], "the rVFC handle was cancelled");
});

test("a pre-aborted signal fires onPast immediately without arming an observer", () => {
  const video = makeVideo();
  const ac = new AbortController();
  ac.abort();
  const events = [];
  const ok = onFrame(video, () => events.push("frame"), { onPast: () => events.push("past"), signal: ac.signal });
  assert.equal(ok, true, "a method-bearing element still answers the seam call");
  assert.deepEqual(events, ["past"]);
  assert.equal(video.callbacks.length, 0, "no observer is armed for a pre-aborted request");
});

test("a method-less element returns false and runs no observer", () => {
  const video = makeVideo({ noMethod: true });
  const events = [];
  const ok = onFrame(video, () => events.push("frame"), { onPast: () => events.push("past") });
  assert.equal(ok, false, "the caller must fall back");
  assert.deepEqual(events, [], "nothing fired on a method-less element (caller owns the fallback)");
  assert.equal(video.callbacks.length, 0, "no observer was armed");
});

test("a null video is a graceful false", () => {
  assert.equal(onFrame(null, () => {}), false);
  assert.equal(onFrame(undefined, () => {}), false);
});
