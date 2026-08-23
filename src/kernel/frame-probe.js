import { logger } from "../shared/logger.js";
import { videoFromEvent } from "./sdk.js";

/**
 * Cheap sentinel that defers the full kernel boot until a document actually
 * shows a video candidate. Under @run-at document-start nothing pre-exists
 * us: SDK-created players trip the insertion observer the moment their
 * <video> enters the DOM, and static players fire loadeddata/play right
 * after parse. The first size-qualified candidate fires onCandidate exactly
 * once; documents without video never pay for a kernel.
 */
export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;

  function qualifies(video) {
    try {
      const rect = video.getBoundingClientRect();
      return rect.width >= minWidth && rect.height >= minHeight;
    } catch {
      return false;
    }
  }

  function onMediaEvent(event) {
    if (done) {
      return;
    }
    const video = videoFromEvent(event);
    if (video && qualifies(video)) {
      fire();
    }
  }

  function onInsertions(mutations) {
    if (done) {
      return;
    }
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const candidates = node.localName === "video"
          ? [node]
          : node.querySelectorAll ? [...node.querySelectorAll("video")] : [];
        for (const video of candidates) {
          if (qualifies(video)) {
            fire();
            return;
          }
        }
      }
    }
  }

  function stop() {
    observer.disconnect();
    document.removeEventListener("loadeddata", onMediaEvent, true);
    document.removeEventListener("play", onMediaEvent, true);
  }

  function fire() {
    done = true;
    stop();
    logger.log("probe", "Video candidate found — booting kernel");
    onCandidate();
  }

  const observer = new MutationObserver(onInsertions);
  document.addEventListener("loadeddata", onMediaEvent, true);
  document.addEventListener("play", onMediaEvent, true);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return stop;
}
