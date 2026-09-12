import { logger } from "../shared/logger.js";

/**
 * Resolve once the container's child list has been quiet for a stretch
 * without further mutations, or when the cap expires - whichever comes
 * first. SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 * A trailing quiet timer replaces the display-refresh rAF cadence, so the
 * settle still resolves while the tab is throttled or backgrounded.
 */
function whenDomSettled(container, { quietMs = 50, capMs = 150 } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let settleTimer = 0;
  const done = () => {
    clearTimeout(capTimer);
    clearTimeout(settleTimer);
    observer.disconnect();
    resolve();
  };
  const observer = new MutationObserver(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(done, quietMs);
  });
  const capTimer = setTimeout(done, capMs);
  observer.observe(container, { childList: true });
  settleTimer = setTimeout(done, quietMs);
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
    await whenDomSettled(container);
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
}
