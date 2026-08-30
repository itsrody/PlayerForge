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
import { logger } from "../shared/logger.js";
import { watchMediaEvents, meetsMinSize, videosFromMutations } from "./sdk.js";
import { onDomMutations } from "./dom-watch.js";

export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  let escalated = false;
  let offMutations = null;
  let stopEvents = null;

  const detach = () => {
    stopEvents?.();
    stopEvents = null;
    offMutations?.();
    offMutations = null;
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
      for (const video of videosFromMutations(mutations)) {
        consider(video);
      }
    });
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
    // observer so SDK-inserted siblings that may qualify are caught.
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
    for (const video of present) {
      consider(video);
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
