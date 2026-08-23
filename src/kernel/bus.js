import { logger } from "../shared/logger.js";

/**
 * Event bus over the platform EventTarget: payloads ride CustomEvent detail,
 * listeners subscribe with addEventListener ({ once, signal } supported),
 * and emits trace when debug mode is on.
 */
export class EventBus extends EventTarget {
  #debug = false;

  set debug(value) {
    this.#debug = value;
  }

  emit(type, detail) {
    if (this.#debug) {
      logger.log("bus", `emit: ${type}`, detail);
    }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
