/**
 * Unified playback-progress incident feed via `requestVideoFrameCallback`
 * (§7.8). The framework has two independent consumers that both reach down to
 * the media element's "a frame was actually composited" signal:
 *  - the element MP4 route's dead-bytes watchdog (arm a deadline, disarm when
 *    the first rendered frame proves the blob is live media);
 *  - resume's pause flush (save the exact mediaTime of the last rendered
 *    frame, which is what the user saw, not the decoder's leading/trailing
 *    currentTime).
 * Each inlined its own `requestVideoFrameCallback` callback. This module is
 * the single seam: `onFrame(video, cb, { signal })` arms one rVFC request and
 * fires `cb(frame)` (the VideoFrameCallbackMetadata) exactly once on the next
 * composited frame, then unsubscribes itself; it also disarms on `error` /
 * `emptied` / `ended`, surfaces via an optional `onPast` so a watchdog can keep
 * its deadline ticking.
 *
 * Firefox-native: requestVideoFrameCallback is FF 132+ (baseline 2024) and is
 * invoked unguarded on the element - the same no-feature-detect contract as
 * every FF-155-native API. The only guard is for a bare mock video in a test
 * host that lacks the method: instead of arming a dead observer, `onFrame`
 * returns false and the caller's own fallback runs (resume already falls back
 * to `currentTime`; the watchdog treats a method-less mock as "can't prove
 * dead, keep the route").
 *
 * Deterministic: every consumer passes the same seam is not enough - the
 * observer class is not global here, the *method* is element-owned, so
 * headless tests inject a stub `requestVideoFrameCallback`. The module is a
 * pure funnel: no DOM, no network, nothing beyond the element method.
 */

/** Fire `cb(now, frame)` on the next composited frame, mirroring the browser's
 *  requestVideoFrameCallback callback shape, or `onPast(now)` when the video
 *  will never present one (error/emptied/ended). Self-unsubscribing. Returns
 *  true when the method existed and a request was armed, false on a
 *  method-less element (caller runs its own fallback). `signal` (optional)
 *  aborts the pending request and detaches any listener.
 */
export function onFrame(video, cb, { onPast = () => {}, signal = null } = {}) {
  if (!video || typeof video.requestVideoFrameCallback !== "function") {
    return false;
  }
  let done = false;
  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    video.cancelVideoFrameCallback?.(handle);
    removeEventListeners();
    signal?.removeEventListener("abort", abort);
    fn(...args);
  };
  const abort = () => {
    finish(onPast);
  };
  const onError = () => finish(onPast);
  const onEnded = () => finish(onPast);
  const removeEventListeners = () => {
    video.removeEventListener?.("error", onError);
    video.removeEventListener?.("emptied", onError);
    video.removeEventListener?.("ended", onEnded);
  };
  if (signal?.aborted) {
    onPast();
    return true;
  }
  const frameCb = (now, metadata) => finish(cb, now, metadata);
  const handle = video.requestVideoFrameCallback(frameCb);
  video.addEventListener?.("error", onError);
  video.addEventListener?.("emptied", onError);
  video.addEventListener?.("ended", onEnded);
  signal?.addEventListener("abort", abort, { once: true });
  return true;
}