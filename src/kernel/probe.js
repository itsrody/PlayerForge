/**
 * Presence probe - framework video detection.
 *
 * Two-phase sentinel that defers the full kernel boot until a document
 * actually shows a video candidate - without paying for a full-document
 * MutationObserver on pages that never host a player.
 *
 * Phase 1 (cheap, no observer): capture-phase loadeddata/play listeners plus
 * a one-time DOM-ready <video> presence check. SDK players fire media events
 * through the composed path, so a real player surfaces here with zero subtree
 * observer cost.
 *
 * Escalation (commits to the full-document observer) happens only once there
 * is evidence of a player: a static <video> in the parsed DOM, or a media
 * event for a <video> that has not yet reached player size. Documents without
 * video therefore never open the subtree observer at all.
 *
 * The first size-qualified candidate fires onCandidate exactly once;
 * documents without a usable player never boot a kernel.
 */
import { logger } from "../shared/diagnostics.js";
import { watchMediaEvents, meetsMinSize, forEachVideoInMutations } from "./sdk.js";
import { onDomMutations } from "../shared/dom-manager.js";

export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  let escalated = false;
  let offMutations = null;
  let stopEvents = null;
  let sizeWatcher = null;

  const detach = () => {
    stopEvents?.();
    stopEvents = null;
    offMutations?.();
    offMutations = null;
    sizeWatcher?.disconnect();
    sizeWatcher = null;
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    detach();
    logger.log("probe", "Video candidate found - booting kernel");
    onCandidate();
  };

  const escalate = () => {
    if (escalated) {
      return;
    }
    escalated = true;
    offMutations = onDomMutations((mutations) => {
      if (done) {
        return;
      }
      forEachVideoInMutations(mutations, consider);
    });
  };

  /**
   * Watch a candidate that failed the size gate, so the gate can re-run when
   * the box actually changes.
   *
   * Without this the failure is final unless something else happens to fire:
   * the shared mutation feed observes childList only, so a style or class
   * change that grows or reveals an existing video produces no record - and
   * the media tap cannot re-fire an event that is already spent (a video that
   * ran loadeddata while hidden, or has no src at all, will never fire again).
   * Verified on the live bundle: a Plyr video that fails the gate and is then
   * grown by a style-only write is never re-checked, while a fresh qualifying
   * insertion on the same page boots immediately - the candidate was missed
   * for the life of the document.
   *
   * ResizeObserver observes the box itself, which is exactly the signal the
   * gate is about; Gecko holds observed targets weakly per the spec (unobserve
   * happens on qualification, and a detached candidate simply drops out when
   * GC collects it), so watching failures cannot pin elements. The re-check
   * runs at observation delivery - after layout, never inside the page's
   * mutation checkpoint (the shared feed dispatches past it via yield_ in
   * scheduleFlush), so this adds no forced-layout work to page script.
   */
  const watchGateFailure = (video) => {
    if (!sizeWatcher) {
      sizeWatcher = new ResizeObserver((entries) => {
        if (done) {
          return;
        }
        for (const { target } of entries) {
          if (!meetsMinSize(target, minWidth, minHeight)) {
            continue;
          }
          sizeWatcher.unobserve(target);
          consider(target);
        }
      });
    }
    sizeWatcher.observe(video);
  };

  const consider = (video) => {
    if (done) {
      return;
    }
    if (meetsMinSize(video, minWidth, minHeight)) {
      finish();
      return;
    }
    // A real <video> exists but isn't player-sized yet - commit to the
    // observer so SDK-inserted siblings that may qualify are caught, and
    // watch this one's box so a later in-place grow/reveal re-runs the gate.
    watchGateFailure(video);
    escalate();
  };

  stopEvents = watchMediaEvents(consider);

  // Cheap deferred check (atomic, no observer): videos already in the parsed
  // DOM surface without any media event or mutation subscription.
  const checkStatic = () => {
    if (done) {
      return;
    }
    const present = document.querySelectorAll("video");
    // Index walk, not for..of: a static NodeList is a cheap array underneath,
    // and the iterator protocol here costs more than the walk it replaces.
    for (let i = 0; i < present.length; i++) {
      consider(present[i]);
    }
    if (!done && present.length) {
      // Static video(s) exist but none qualified yet - keep the observer armed
      // so SDK-inserted successors that may reach player size are caught.
      escalate();
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkStatic, { once: true });
  } else {
    checkStatic();
  }

  return () => {
    if (!done) {
      done = true;
      detach();
    }
  };
}
