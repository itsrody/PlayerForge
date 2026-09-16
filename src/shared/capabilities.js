/**
 * Browser capability detection.
 *
 * Runs once at module load and freezes the results as boolean constants.
 * Eliminates per-event `typeof` lookups on hot paths (pointer scrub,
 * media controls, resume saves) in favor of a single boolean read.
 *
 * Each capability is gated on the prototype chain — the check runs once
 * and is never re-evaluated, so SpiderMonkey/WarpJIT can fold them as
 * invariants.
 */

/** HTMLElement.prototype.checkVisibility — layout-free visibility gate (Firefox 106+). */
export const HAS_CHECK_VISIBILITY =
  typeof HTMLElement !== "undefined" &&
  typeof HTMLElement.prototype.checkVisibility === "function";

/** PointerEvent.prototype.getCoalescedEvents — high-rate pointer samples. */
export const HAS_GET_COALESCED =
  typeof PointerEvent !== "undefined" &&
  typeof PointerEvent.prototype.getCoalescedEvents === "function";

/** PointerEvent.prototype.getPredictedEvents — speculative velocity shaping. */
export const HAS_GET_PREDICTED =
  typeof PointerEvent !== "undefined" &&
  typeof PointerEvent.prototype.getPredictedEvents === "function";

/** HTMLVideoElement.prototype.requestPictureInPicture — native PiP. */
export const HAS_REQUEST_PIP =
  typeof HTMLVideoElement !== "undefined" &&
  typeof HTMLVideoElement.prototype.requestPictureInPicture === "function";

/** HTMLVideoElement.prototype.requestVideoFrameCallback — exact media-time on pause. */
export const HAS_RVFC =
  typeof HTMLVideoElement !== "undefined" &&
  typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";

/** IntersectionObserver — viewport visibility gating. */
export const HAS_INTERSECTION_OBSERVER =
  typeof IntersectionObserver === "function";

/** MutationObserver — DOM observation. */
export const HAS_MUTATION_OBSERVER =
  typeof MutationObserver === "function";

/** scheduler.postTask — priority-aware scheduling (Firefox 101+). */
export const HAS_POST_TASK =
  typeof globalThis.scheduler?.postTask === "function";

/** requestIdleCallback — idle-time work scheduling. */
export const HAS_REQUEST_IDLE_CALLBACK =
  typeof requestIdleCallback === "function";

/** Object.freeze the entire registry so consumers cannot accidentally mutate. */
Object.freeze({
  HAS_CHECK_VISIBILITY,
  HAS_GET_COALESCED,
  HAS_GET_PREDICTED,
  HAS_REQUEST_PIP,
  HAS_RVFC,
  HAS_INTERSECTION_OBSERVER,
  HAS_MUTATION_OBSERVER,
  HAS_POST_TASK,
  HAS_REQUEST_IDLE_CALLBACK
});
