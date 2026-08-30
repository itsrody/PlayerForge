import { logger } from "../shared/logger.js";

/** Holds the single live shell. PlayerForge is one-shell-per-session by design. */
export class ShellRegistry {
  #current = null;

  register(shell) {
    this.#current = shell;
    logger.log("registry", `Shell registered: ${shell.sdkName}`);
  }

  unregister(shell) {
    if (this.#current === shell) {
      this.#current = null;
    }
    logger.log("registry", `Shell unregistered: ${shell.sdkName}`);
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
