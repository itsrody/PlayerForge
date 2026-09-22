import { logger } from "../shared/logger.js";
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

  observer.observe(container, { childList: true });

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
  #shellFactory = null;
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();
  /** Abort source for in-flight settle waits; aborted by destroy() (pagehide). */
  #scope = new AbortController();

  constructor(registry, onShellCreated) {
    this.#registry = registry;
    this.#onShellCreated = onShellCreated;
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
    if (!video.isConnected || !container.isConnected) {
      logger.log("lifecycle", `${sdk.name} video left the document before settle - skipping`);
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