/**
 * Presence probe - framework video detection.
 *
 * Two-phase sentinel that defers the full kernel boot until a document
 * actually shows a video candidate - without paying for a full-document
 * MutationObserver on pages that never host a player.
 *
 * Phase 1 (cheap, no observer): capture-phase loadedmetadata/loadeddata/play
 * listeners plus a one-time DOM-ready <video> presence check. SDK players fire
 * media events through the composed path, so a real player surfaces here with
 * zero subtree observer cost.
 *
 * Escalation (commits to the full-document observer) happens only once there
 * is evidence of a player: a rendered static <video> in the parsed DOM, or a
 * media event for a rendered <video> that has not yet reached player size. A
 * hidden <video> (no painted box) is not evidence and stays on the cheap tap,
 * so documents that only carry non-player videos never open the subtree
 * observer either.
 *
 * The first size-qualified candidate fires onCandidate exactly once;
 * documents without a usable player never boot a kernel.
 */
import { logger } from "../shared/logger.js";
import { watchMediaEvents, meetsMinSize, createLayoutGate, hasPresentBox, forEachVideoInMutations } from "./sdk.js";
import { onDomMutations } from "../shared/dom-watch.js";

/**
 * Returns an idempotent stop() that cancels discovery when the kernel never
 * boots. It is a no-op after onCandidate fires (finish() already detached), so
 * the caller owns the pagehide decision: keep discovery across a bfcache hide
 * and release it on a real unload.
 */
export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  let escalated = false;
  let offMutations = null;
  let stopEvents = null;
  // Re-checks candidates that failed the size gate when their box grows: the
  // observer-driven layout-presence gate re-reads the delivered box (no forced
  // reflow) and lands off the mutation batch, so a candidate that only reaches
  // player size later would otherwise never fire onCandidate.
  const layoutGate = createLayoutGate({ minWidth, minHeight });

  const detach = () => {
    stopEvents?.();
    stopEvents = null;
    offMutations?.();
    offMutations = null;
    layoutGate.stop();
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

  const consider = (video) => {
    if (done) {
      return;
    }
    if (meetsMinSize(video, minWidth, minHeight)) {
      finish();
      return;
    }
    // Commit to the full-document observer only when the video is actually
    // rendered. A hidden <video> is common and not a player: a decoder/canvas
    // texture source (display:none), a pre-rendered off-screen embed, or a
    // content-visibility:auto subtree that is skipped. Escalating for one of
    // those keeps a document-wide observer (and its per-batch JS scan) alive
    // for the whole page on a site that will never boot a kernel. A hidden
    // candidate still goes under the layout gate, so a later reveal that
    // changes its box can qualify it, and a hidden-but-real player is caught
    // when it starts loading/playing (media events route back here).
    if (hasPresentBox(video)) {
      escalate();
    }
    layoutGate.watch(video, () => {
      if (!done) {
        finish();
      }
    });
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
      // consider() owns the escalation decision per video (present-and-small
      // escalates; hidden does not), so there is no blanket escalate() here -
      // that would arm the observer for a page whose only videos are hidden.
      consider(video);
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
