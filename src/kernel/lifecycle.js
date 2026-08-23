import { logger } from "../shared/logger.js";

/**
 * Bridges video discovery to shell creation: listens for `video:found` /
 * `video:removed`, invokes the shell factory, and cleans everything up on
 * page unload.
 */
export class LifecycleManager {
  #bus;
  #registry;
  #shellFactory = null;
  #scope = new AbortController();

  constructor(bus, registry) {
    this.#bus = bus;
    this.#registry = registry;
    this.#wire();
  }

  setShellFactory(factory) {
    this.#shellFactory = factory;
  }

  #wire() {
    const { signal } = this.#scope;
    this.#bus.addEventListener("video:found", (event) => this.#onVideoFound(event.detail), { signal });
    this.#bus.addEventListener("video:removed", (event) => this.#onVideoRemoved(event.detail), { signal });
    this.#guardUnload();
  }

  #onVideoFound({ video, container, sdk, sdkName, id }) {
    logger.log("lifecycle", `video:found — ${sdkName} (${id})`);
    if (this.#registry.getByVideo(video)) {
      logger.log("lifecycle", "Video already has a shell, skipping");
      return;
    }
    if (!this.#shellFactory) {
      logger.error("lifecycle", "No shell factory set!");
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

  #guardUnload() {
    const onUnload = (event) => {
      if (!event?.persisted) {
        logger.log("lifecycle", "Page unloading, cleaning up");
        this.#registry.destroyAll();
        this.#scope.abort();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
  }
}
