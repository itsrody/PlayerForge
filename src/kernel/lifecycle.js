import { logger } from "../shared/logger.js";

/**
 * Resolve once the container's child list has been quiet for a run of
 * consecutive animation frames, or when the cap expires - whichever comes
 * first. SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 */
function whenDomSettled(container, { quietFrames = 2, capMs = 150 } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let quiet = 0;
  let rafId = 0;
  const observer = new MutationObserver(() => {
    quiet = 0;
  });
  const done = () => {
    clearTimeout(capTimer);
    cancelAnimationFrame(rafId);
    observer.disconnect();
    resolve();
  };
  const tick = () => {
    quiet += 1;
    if (quiet >= quietFrames) {
      done();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  const capTimer = setTimeout(done, capMs);
  observer.observe(container, { childList: true });
  rafId = requestAnimationFrame(tick);
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

  async onVideoFound({ video, container, sdk, sdkName, id }) {
    logger.log("lifecycle", `video:found - ${sdkName} (${id})`);
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
      logger.log("lifecycle", `Video ${id} left the document before settle - skipping`);
      return;
    }
    if (this.#registry.getByVideo(video)) {
      return;
    }
    try {
      const shell = this.#shellFactory({ id, video, container, sdk, sdkName });
      await shell?.ready;
      this.#onShellCreated(shell);
      logger.log("lifecycle", `Shell created for ${sdkName}: ${id}`);
    } catch (err) {
      logger.error("lifecycle", `Failed to create shell for ${id}:`, err);
    }
  }

  onVideoRemoved({ video }) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.id}`);
    }
  }
}
