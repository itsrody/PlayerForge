import { logger } from "../shared/diagnostics.js";

/**
 * The live shells of one document, keyed by their <video>.
 *
 * This used to be a single slot that every new shell overwrote, which was only
 * correct while a document could hold one player. The kernel builds one shell
 * per qualifying <video> and platform/integration/gm-multisubscriber already
 * asserts two of them in one document, so the slot silently dropped every shell
 * but the last. That cost three things: a removed non-current player was never
 * destroyed, so its document-level hotkey listeners, its DOM observers and its
 * pf:resume subscription all stayed live (measured in Firefox 157: removing one
 * of two players produced ZERO gm:remove events, the subscription never left the
 * table); the bfcache reconcile pass only ever saw the newest shell, so orphaned
 * shells for any other video survived a restore; and getAll() was a
 * single-element array, which made togglePanel()'s "most recent" pick
 * meaningless.
 *
 * Insertion order is registration order, so the last entry is still the most
 * recently created shell - which is what togglePanel() means by it, and what it
 * means now that a page really can hold several.
 */
export class ShellRegistry {
  #shells = new Map();

  register(shell) {
    this.#shells.set(shell.video, shell);
    logger.log("registry", `Shell registered: ${shell.sdk.name}`);
  }

  unregister(shell) {
    // Deleted by identity, not by key alone. destroy() can legitimately be
    // reached twice - a removal grace and a pagehide both landing on the same
    // shell - and a bare delete would then evict whatever shell took the key in
    // between, losing a live player to a dead one's teardown.
    if (this.#shells.get(shell.video) === shell) {
      this.#shells.delete(shell.video);
    }
    logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
  }

  getByVideo(video) {
    return this.#shells.get(video) ?? null;
  }

  /** Every live shell, oldest registration first. */
  getAll() {
    return [...this.#shells.values()];
  }

  destroyAll() {
    // Emptied before any destroy() runs, so a shell torn down here cannot
    // unregister a sibling that happens to be destroyed later in this loop.
    const shells = [...this.#shells.values()];
    this.#shells.clear();
    for (const shell of shells) {
      shell.destroy();
      logger.log("registry", "Destroyed shell");
    }
  }
}
