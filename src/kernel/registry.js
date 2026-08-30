import { logger } from "../shared/logger.js";
import { BUS_EVENTS } from "../shared/events.js";

/** Tracks live shells by id and by video element. */
export class ShellRegistry {
  #bus;
  #byId = new Map();
  #idByVideo = new WeakMap();
  #scope = new AbortController();

  constructor(bus) {
    this.#bus = bus;
    this.#wire();
  }

  #wire() {
    const { signal } = this.#scope;
    this.#bus.addEventListener(BUS_EVENTS.shellCreated, (event) => this.#register(event.detail), { signal });
    this.#bus.addEventListener(BUS_EVENTS.shellDestroyed, (event) => this.#unregister(event.detail), { signal });
  }

  #register(shell) {
    this.#byId.set(shell.id, shell);
    this.#idByVideo.set(shell.video, shell.id);
    logger.log("registry", `Shell registered: ${shell.id} (${shell.sdkName})`);
  }

  #unregister(shell) {
    this.#byId.delete(shell.id);
    logger.log("registry", `Shell unregistered: ${shell.id}`);
  }

  get(id) {
    return this.#byId.get(id) || null;
  }

  getByVideo(video) {
    const id = this.#idByVideo.get(video);
    return id ? this.#byId.get(id) : null;
  }

  getAll() {
    return [...this.#byId.values()];
  }

  getBySDK(sdkName) {
    return this.getAll().filter((shell) => shell.sdkName === sdkName);
  }

  get size() {
    return this.#byId.size;
  }

  destroyAll() {
    const shells = this.getAll();
    for (const shell of shells) {
      shell.destroy();
    }
    this.#byId.clear();
    logger.log("registry", `Destroyed ${shells.length} shell(s)`);
  }
}
