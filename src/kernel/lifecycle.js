import { logger } from "../shared/diagnostics.js";
import { postTask } from "../shared/scheduler.js";

/**
 * Resolve once the container's child list has been quiet for a run of
 * consecutive quiet time, or when the cap expires - whichever comes first.
 * SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 *
 * Settle detection is a MutationObserver trailing quiet-period timer rather
 * than an rAF quiet-frame counter, so the window is frame-rate independent
 * (an 144 Hz display settles 2.4x faster than 60 Hz, and a missed frame or
 * a throttled background tab still resolves on the quiet clock).
 *
 * Both timers are scheduler.postTask handles (background-tab throttling and
 * pagehide abort are native), re-armed per mutation. An optional AbortSignal
 * additionally resolves the wait immediately - so a video removed / page
 * hidden mid-window never leaves the observer + its two timers running for
 * the full cap.
 *
 * The watch covers the container SUBTREE, not just its direct children. SDKs
 * build their chrome nested several levels down (control bars inside
 * wrappers inside the anchor), and a childList-only watch never re-arms for
 * those - so settle could fire mid-build, the host would land, and the SDK's
 * next innerHTML wipe would take it out again (recovered by the watchdog,
 * but churn on every such player). The extra records only extend the window,
 * never beyond the cap, so a chatty build costs latency, not correctness.
 */
function whenDomSettled(container, { quietMs = 50, capMs = 150, signal } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let settled = false;
  let settleHandle = null;
  let capHandle = null;

  const done = () => {
    if (settled) {
      return;
    }
    settled = true;
    observer.disconnect();
    settleHandle?.abort();
    capHandle?.abort();
    // Normal settle must release the abort listener too: with `{ once: true }`
    // it only self-removes on abort, so a quiet-page settle would otherwise
    // keep the kernel-scope signal subscribed for the whole page lifetime.
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
    resolve();
  };

  const observer = new MutationObserver(() => {
    // Any mutation re-arms the trailing quiet window from scratch.
    settleHandle?.abort();
    settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
  });

  settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
  capHandle = postTask(done, { priority: "user-visible", delay: capMs });

  observer.observe(container, { childList: true, subtree: true });

  const onAbort = () => done();
  signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

/**
 * Bridges video discovery to shell creation: the kernel calls onVideoFound /
 * onVideoRemoved directly (single listener - no bus broadcast needed) and the
 * lifecycle invokes the shell factory once the SDK's DOM has settled. Creation
 * is deferred (quiescence-capped) so the parasite overlay never lands
 * mid-build, with post-wait guards against videos that vanished or were
 * adopted meanwhile. A ready shell is handed to the onShellCreated callback
 * (the kernel's coordinator). Page-unload cleanup is owned by the kernel.
 */
export class LifecycleManager {
  #registry;
  #onShellCreated;
  /** Told which video's shell failed to come up, so the kernel can re-arm. */
  #onShellFailed;
  /** Told which video's settle completed while it was detached. The kernel
   *  keeps that fact on its removal watch: the reconnect edge must re-enter
   *  adoption, because #seenVideos still claims the video and the discovery
   *  tap has already downgraded by then. */
  #onSettleSkipped;
  #shellFactory = null;
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();
  /** Abort source for in-flight settle waits; aborted by destroy() (pagehide). */
  #scope = new AbortController();

  /**
   * @param {object} registry shell slot
   * @param {(shell: object) => void} onShellCreated ready-shell fan-out
   * @param {(video: HTMLVideoElement) => void} [onShellFailed] a boot that
   *   threw after the shell rolled itself back. The shell has already undone
   *   its DOM by then, so the video is unmarked and adoptable again - the
   *   callback decides whether to re-arm it.
   * @param {(video: HTMLVideoElement) => void} [onSettleSkipped] the settle
   *   finished with the video (or container) detached. Nothing is created,
   *   but the kernel has already claimed the video - it needs to know so the
   *   removal watch can re-adopt on reconnect.
   */
  constructor(registry, onShellCreated, onShellFailed, onSettleSkipped) {
    this.#registry = registry;
    this.#onShellCreated = onShellCreated;
    this.#onShellFailed = onShellFailed;
    this.#onSettleSkipped = onSettleSkipped;
  }

  setShellFactory(factory) {
    this.#shellFactory = factory;
  }

  async onVideoFound({ video, container, sdk }) {
    logger.log("lifecycle", `video:found - ${sdk.name}`);
    if (this.#registry.getByVideo(video)) {
      logger.log("lifecycle", "Video already has a shell, skipping");
      return;
    }
    if (!this.#shellFactory) {
      logger.error("lifecycle", "No shell factory set!");
      return;
    }
    if (this.#pending.has(video)) {
      return;
    }
    this.#pending.add(video);
    await whenDomSettled(container, { signal: this.#scope.signal });
    this.#pending.delete(video);
    // container.contains(): the video can also be moved OUT of its container
    // mid-settle (a re-parent lands inside the quiet window) while both nodes
    // stay connected - booting there would strand the host in the abandoned
    // container. Same one-shot offer as the detached case: the movedOut edge
    // has already re-anchored the watch to the new chain, so the next nearby
    // mutation re-enters adoption against the CURRENT container.
    if (!video.isConnected || !container.isConnected || !container.contains(video)) {
      logger.log("lifecycle", `${sdk.name} video left its container before settle - skipping`);
      // The claim stands (#seenVideos) and the discovery tap is downgraded,
      // so this video is unreachable unless the removal watch's reconnect
      // edge re-offers it. Hand the kernel the fact it needs for that.
      this.#onSettleSkipped?.(video);
      return;
    }
    if (this.#registry.getByVideo(video)) {
      return;
    }
    try {
      const shell = this.#shellFactory({ video, container, sdk });
      await shell?.ready;
      this.#onShellCreated(shell);
      logger.log("lifecycle", `Shell created for ${sdk.name}`);
    } catch (err) {
      logger.error("lifecycle", `Failed to create shell for ${sdk.name}:`, err);
      // The shell rolls its own DOM back before rethrowing, so the video is
      // unmarked and adoptable again. Re-arm it - without this the kernel's
      // seen-set kept the video claimed forever and one transient boot throw
      // cost that player PlayerForge for the rest of the document. Re-arming
      // is safe even when the throw came from #onShellCreated rather than the
      // boot: a shell that did come up left SHELL_MARKER on the video, and
      // #adoptVideo refuses a marked one, so a healthy video still gets no
      // second shell.
      this.#onShellFailed?.(video);
    }
  }

  onVideoRemoved({ video }) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.sdk.name}`);
    }
  }

  /**
   * Tear down every in-flight settle wait: the observer + its two timers die
   * immediately instead of running their full quiet/cap window after pagehide.
   * Continuations resume and hit the still-connected guards, so nothing is
   * half-created on a dying page.
   */
  destroy() {
    this.#scope.abort();
  }
}