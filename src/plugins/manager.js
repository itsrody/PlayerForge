import { logger } from "../shared/logger.js";
import { PluginState } from "./base.js";

/** Owns the plugin lifecycle for one shell: attach / pause / resume / destroy. */
export class PluginManager {
  #shell;
  #bus;
  #plugins = new Map();

  constructor(shell, bus) {
    this.#shell = shell;
    this.#bus = bus;
  }

  register(plugin) {
    if (!plugin?.name) {
      logger.warn("plugin-manager", "Plugin must have a name");
      return;
    }
    if (this.#plugins.has(plugin.name)) {
      logger.warn("plugin-manager", `Plugin "${plugin.name}" already registered`);
      return;
    }
    try {
      plugin.init(this.#shell, this.#bus, this.#shell.shellDom);
    } catch (err) {
      logger.error("plugin-manager", `Plugin "${plugin.name}" init failed:`, err);
      plugin.state = PluginState.ERROR;
      return;
    }
    this.#plugins.set(plugin.name, plugin);
    try {
      this.#attach(plugin);
      plugin.state = PluginState.ACTIVE;
      logger.log("plugin-manager", `Plugin "${plugin.name}" activated`);
      this.#bus.emit("plugin:activated", { plugin, shell: this.#shell });
    } catch (err) {
      plugin.state = PluginState.ERROR;
      logger.error("plugin-manager", `Plugin "${plugin.name}" failed to attach:`, err);
    }
  }

  #attach(plugin) {
    const result = plugin.onAttach(this.#shell);
    if (result && typeof result.then === "function") {
      result.catch((err) => {
        plugin.state = PluginState.ERROR;
        logger.error("plugin-manager", `Plugin "${plugin.name}" async attach failed:`, err);
      });
    }
  }

  get(name) {
    return this.#plugins.get(name) || null;
  }

  getActive() {
    return [...this.#plugins.values()].filter((plugin) => plugin.state === PluginState.ACTIVE);
  }

  pause(name) {
    const plugin = this.#plugins.get(name);
    if (plugin && plugin.state === PluginState.ACTIVE) {
      plugin.state = PluginState.PAUSED;
      if (typeof plugin.onDetach === "function") {
        try {
          plugin.onDetach();
        } catch (err) {
          logger.error("plugin-manager", `Plugin "${name}" detach error:`, err);
        }
      }
      logger.log("plugin-manager", `Plugin "${name}" paused`);
    }
  }

  resume(name) {
    const plugin = this.#plugins.get(name);
    if (plugin && plugin.state === PluginState.PAUSED) {
      plugin.state = PluginState.ACTIVE;
      try {
        this.#attach(plugin);
      } catch (err) {
        plugin.state = PluginState.ERROR;
        logger.error("plugin-manager", `Plugin "${name}" failed to resume:`, err);
      }
      logger.log("plugin-manager", `Plugin "${name}" resumed`);
    }
  }

  destroy(name) {
    const plugin = this.#plugins.get(name);
    if (plugin) {
      if (plugin.state === PluginState.ACTIVE && typeof plugin.onDetach === "function") {
        try {
          plugin.onDetach();
        } catch (err) {
          logger.error("plugin-manager", `Plugin "${name}" detach error:`, err);
        }
      }
      plugin.state = PluginState.DESTROYED;
      if (typeof plugin.onDestroy === "function") {
        try {
          plugin.onDestroy();
        } catch (err) {
          logger.error("plugin-manager", `Plugin "${name}" destroy error:`, err);
        }
      }
      this.#plugins.delete(name);
      logger.log("plugin-manager", `Plugin "${name}" destroyed`);
    }
  }

  destroyAll() {
    for (const [name] of this.#plugins) {
      this.destroy(name);
    }
  }

  get size() {
    return this.#plugins.size;
  }
}
