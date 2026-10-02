import { logger } from "../shared/logger.js";

/**
 * Holds the single live shell. PlayerForge is one-shell-per-session by design.
 *
 * `onEmpty` (optional) fires when the last shell leaves through unregister -
 * the DOM-status edge the kernel uses to re-arm discovery. It is not wired to
 * destroyAll(): that is a page-teardown sweep, not a live page losing a player.
 */
export class ShellSlot {
  #current = null;
  #onEmpty;

  constructor(onEmpty) {
    this.#onEmpty = onEmpty;
  }

  register(shell) {
    this.#current = shell;
    logger.log("registry", `Shell registered: ${shell.sdk.name}`);
  }

  unregister(shell) {
    if (this.#current === shell) {
      this.#current = null;
      this.#onEmpty?.();
    }
    logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
  }

  getByVideo(video) {
    return this.#current?.video === video ? this.#current : null;
  }

  getAll() {
    return this.#current ? [this.#current] : [];
  }

  destroyAll() {
    const shell = this.#current;
    this.#current = null;
    if (shell) {
      shell.destroy();
      logger.log("registry", "Destroyed shell");
    }
  }
}
