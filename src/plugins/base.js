import { logger } from "../shared/logger.js";

export const PluginState = {
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  ERROR: "error",
  DESTROYED: "destroyed"
};

/**
 * Base class for all PlayerForge plugins. Provides shell/bus access, scoped
 * bus subscriptions with automatic cleanup, DOM element lifetime management,
 * and toast helpers. Subclasses must override onAttach/onDetach.
 */
export class Plugin {
  name;
  options;

  #state = PluginState.PENDING;
  #shell = null;
  #bus = null;
  #shellDom = null;
  #cleanups = new Set();

  constructor(name, options = {}) {
    if (new.target === Plugin) {
      throw new Error("Plugin is abstract and cannot be instantiated directly");
    }
    this.name = name;
    this.options = options;
  }

  get shell() {
    return this.#shell;
  }

  get bus() {
    return this.#bus;
  }

  get shellDom() {
    return this.#shellDom;
  }

  get state() {
    return this.#state;
  }

  set state(value) {
    this.#state = value;
  }

  get isActive() {
    return this.#state === PluginState.ACTIVE;
  }

  init(shell, bus, shellDom) {
    this.#shell = shell;
    this.#bus = bus;
    this.#shellDom = shellDom;
    this.#state = PluginState.PENDING;
  }

  onAttach(shell) {}

  onDetach() {}

  onDestroy() {
    this.#runCleanups();
  }

  /** Subscribe to the bus; the subscription is cleaned up automatically. */
  on(event, handler) {
    if (this.#state === PluginState.DESTROYED) {
      logger.warn("plugin", `[${this.name}] on("${event}") after destroy — ignored`);
      return () => {};
    }
    const unsubscribe = this.#bus.on(event, handler);
    this.#cleanups.add(unsubscribe);
    return unsubscribe;
  }

  /** Subscribe to a shell-scoped event (`shell:<event>`) for this shell only. */
  onVideo(event, handler) {
    return this.on(`shell:${event}`, (payload) => {
      if (payload.shellId === this.shell.id) {
        handler(payload);
      }
    });
  }

  addCleanup(cleanup) {
    if (this.#state === PluginState.DESTROYED) {
      logger.warn("plugin", `[${this.name}] addCleanup after destroy — ignored`);
      return cleanup;
    } else {
      this.#cleanups.add(cleanup);
      return cleanup;
    }
  }

  createElement(tag, attrs = {}, content = "") {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        el.setAttribute(key, value);
      }
    }
    if (content) {
      el.textContent = content;
    }
    if (this.#shellDom?.host) {
      this.#shellDom.host.appendChild(el);
    }
    this.#cleanups.add(() => el.remove());
    return el;
  }

  toast(payload) {
    this.shell?.toast?.(payload);
  }

  hideToast() {
    this.shell?.hideToast?.();
  }

  #runCleanups() {
    for (const cleanup of this.#cleanups) {
      try {
        cleanup();
      } catch (err) {
        logger.error("plugin", `[${this.name}] Cleanup error:`, err);
      }
    }
    this.#cleanups.clear();
  }
}
