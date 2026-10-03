import test from "node:test";
import assert from "node:assert/strict";

/**
 * Fill mode writes inline `transform` and `object-fit` onto the embed's own
 * <video>. A gesture binding dies with the shell's AbortSignal, but a signal
 * cannot undo a style it already wrote - so releaseShellActions is the only
 * thing standing between a shell destroyed mid-fill (pagehide, host evicted,
 * SPA swap) and an embed left permanently scaled and letterboxed.
 *
 * These cases drive the real pinch gesture rather than poking the state pool,
 * so the capture and the release are exercised across the same boundary
 * production uses.
 */
globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = () => {};

const {
  attachInputActions,
  releaseShellActions,
  GESTURE_EVENTS
} = await import("../src/shell/inputs/actions.js");

function makeEnv({ objectFit = "", transform = "" } = {}) {
  const host = new EventTarget();
  const video = {
    videoWidth: 1920,
    videoHeight: 1080,
    style: { objectFit, transform, transition: "", willChange: "" },
    addEventListener() {},
    removeEventListener() {},
    closest: () => null
  };
  const toasts = [];
  const shell = {
    video,
    referenceBox: { width: 400, height: 400 },
    toastFlash: (...args) => toasts.push(args),
    toast: () => {},
    toastInfo: () => {},
    toastHint: () => {},
    toastAction: () => {}
  };
  const controller = new AbortController();
  attachInputActions(shell, host, controller.signal);

  const pinch = (direction) => {
    host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.pinch, {
      detail: { direction, method: "touch" }
    }));
  };

  return { shell, video, pinch, toasts, controller };
}

test("pinch-out captures the embed's own object-fit and transform", () => {
  const { video, pinch } = makeEnv({ objectFit: "cover", transform: "rotate(1deg)" });

  pinch("out");

  assert.equal(video.style.objectFit, "contain", "precondition: fill mode took object-fit");
  assert.match(video.style.transform, /scale\(/, "precondition: fill mode took transform");
});

test("releasing a shell mid-fill hands both host styles back", () => {
  const { shell, video, pinch } = makeEnv({ objectFit: "cover", transform: "rotate(1deg)" });
  pinch("out");

  releaseShellActions(shell);

  // Snap, not ease: teardown has no frames left to animate into.
  assert.equal(video.style.objectFit, "cover", "the embed's object-fit was not restored");
  assert.equal(video.style.transform, "rotate(1deg)", "the embed's transform was not restored");
  assert.equal(video.style.transition, "", "a transition was left armed on the embed");
  assert.equal(video.style.willChange, "", "a will-change layer was left promoted");
});

test("releasing a shell that never filled is inert", () => {
  const { shell, video } = makeEnv({ objectFit: "cover", transform: "rotate(1deg)" });

  releaseShellActions(shell);

  assert.equal(video.style.objectFit, "cover");
  assert.equal(video.style.transform, "rotate(1deg)");
});

test("releasing a shell with no video does not throw", () => {
  const { shell } = makeEnv();
  shell.video = null;
  assert.doesNotThrow(() => releaseShellActions(shell));
});

test("pinch-in releases the same way teardown does", () => {
  const { video, pinch } = makeEnv({ objectFit: "cover", transform: "rotate(1deg)" });
  pinch("out");
  pinch("in");

  assert.equal(video.style.objectFit, "cover", "pinch-in did not restore object-fit");
  // This host has no WAAPI, so easeTransformTo takes the transition fallback,
  // which commits the target inline immediately. The point of the case is that
  // the animated path restores the same value teardown snaps to.
  assert.equal(video.style.transform, "rotate(1deg)", "pinch-in did not restore the transform");
});

test("a released shell can be filled again from a clean slate", () => {
  const { shell, video, pinch } = makeEnv({ objectFit: "cover", transform: "rotate(1deg)" });
  pinch("out");
  releaseShellActions(shell);

  pinch("out");
  assert.equal(video.style.objectFit, "contain", "precondition: second fill took object-fit");

  releaseShellActions(shell);
  // The second capture must have read the embed's values again, not the
  // leftovers the first release wrote.
  assert.equal(video.style.objectFit, "cover");
  assert.equal(video.style.transform, "rotate(1deg)");
});
