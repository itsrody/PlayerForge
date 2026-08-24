import { logger } from "../shared/logger.js";
import { whenDomSettled } from "../shell/inject.js";

/**
 * Bridges video discovery to shell creation: listens for `video:found` /
 * `video:removed` and invokes the shell factory once the SDK's DOM has
 * settled. Creation is deferred (quiescence-capped) so the parasite overlay
 * never lands mid-build, with post-wait guards against videos that vanished
 * or were adopted meanwhile. Page-unload cleanup is owned by the kernel.
 */
export class LifecycleManager {
  #bus;
  #registry;
  #shellFactory = null;
  #scope = new AbortController();
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();

  constructor(bus, registry) {
    this.#bus = bus;
    this.#registry = registry;
    const { signal } = this.#scope;
    this.#bus.addEventListener("video:found", (event) => this.#onVideoFound(event.detail), { signal });
    this.#bus.addEventListener("video:removed", (event) => this.#onVideoRemoved(event.detail), { signal });
  }

  setShellFactory(factory) {
    this.#shellFactory = factory;
  }

  async #onVideoFound({ video, container, sdk, sdkName, id }) {
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
      this.#bus.emit("shell:created", shell);
      logger.log("lifecycle", `Shell created for ${sdkName}: ${id}`);
    } catch (err) {
      logger.error("lifecycle", `Failed to create shell for ${id}:`, err);
    }
  }

  #onVideoRemoved({ video }) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.id}`);
    }
  }
}
