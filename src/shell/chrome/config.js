/**
 * User-settings engine: defaults, schema, and cached accessors. State only -
 * the panel renderer for this schema (addSettingsSection) lives in panel.js
 * beside the panel API it programs against.
 */
import { KEYS, getConfigValue, setConfigValue, invalidateConfigCache, watchStorageKey } from "../../shared/store.js";
import { GESTURES, GESTURE_IDS } from "../../kernel/contract.js";
import { logger, Fan } from "../../shared/runtime.js";
import { fmtSeconds } from "../../shared/core.js";

const SETTINGS_PREFIX = "settings";

/**
 * The non-gesture setting-key vocabulary, written exactly once here: the
 * schema entries and every consumer derive from these handles, so a key
 * rename can never silently orphan a binding gate, haptic gate, or panel
 * read. (The gesture-family keys stay on GESTURES[id].setting - the kernel
 * contract owns that vocabulary.)
 */
export const SETTING_KEYS = Object.freeze({
  stepSeek: "controller.stepSeek",
  hotkeys: "gestures.hotkeys",
  haptics: "gestures.haptics",
  edgeToEdge: "fullscreen.edgeToEdge",
  compact: "ui.compact"
});

/**
 * One bool toggle per gesture family, derived from the registry: the key is the
 * family's configs gate and the label is its panel text, so a new gesture is a
 * single contract entry - never a second edit here.
 */
const GESTURE_TOGGLES = GESTURE_IDS.map((id) => ({
  key: GESTURES[id].setting,
  type: "bool",
  label: GESTURES[id].label,
  default: true,
  group: "Features"
}));

/** The schema is consumed by its renderer (panel.js); state stays here. */
export const SETTINGS_SCHEMA = [
  {
    key: SETTING_KEYS.stepSeek,
    type: "options",
    label: "Skip Step",
    options: [5, 10, 15],
    fmt: fmtSeconds,
    default: 5,
    group: "Playback"
  },
  {
    key: SETTING_KEYS.hotkeys,
    type: "bool",
    label: "Hotkeys",
    default: true,
    group: "Features"
  },
  ...GESTURE_TOGGLES,
  {
    key: SETTING_KEYS.haptics,
    type: "bool",
    label: "Haptic Feedback",
    default: true,
    group: "Features"
  },
  {
    key: SETTING_KEYS.edgeToEdge,
    type: "bool",
    label: "Edge-to-edge Fullscreen",
    default: true,
    group: "Features"
  },
  {
    key: SETTING_KEYS.compact,
    type: "bool",
    label: "Compact Panel",
    default: false,
    group: "Interface"
  }
];

/** Defaults ride their schema definitions - one source, no drift. */
const DEFAULT_SETTINGS = Object.fromEntries(
  SETTINGS_SCHEMA.map((definition) => [definition.key, definition.default])
);

/**
 * Coerce a stored value back to its schema type, falling back to the default.
 * pf:configs lives in shared manager storage where any tab or a hand edit can
 * write - a foreign writer must not smuggle e.g. a string into a boolean gate
 * (event-time consumers trust getSetting() without a type check).
 */
function coerceSetting(definition, value) {
  if (definition.type === "bool") {
    return typeof value === "boolean" ? value : definition.default;
  }
  if (definition.type === "options") {
    return definition.options.includes(value) ? value : definition.default;
  }
  return value;
}

/**
 * The settings engine as one class: the typed cache, the reactivity bus, the
 * cross-tab live reload - everything stateful here is a private field, and
 * every public behavior is a method on the instance. The module-level
 * singleton wires the exported call surface below.
 */
class Settings {
  /** Typed cache keyed by SETTING_KEYS, seeded once from storage. */
  #cache = {};
  /** One Fan so every consumer learns about a change exactly once. */
  #bus = new Fan("settings");

  constructor() {
    for (const definition of SETTINGS_SCHEMA) {
      this.#cache[definition.key] = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${definition.key}`, definition.default));
    }
    // Cross-tab live reload via the storage-owned watch (shared echo contract).
    watchStorageKey(KEYS.configs, () => this.#refreshFromStorage());
  }

  get(key) {
    return this.#cache[key];
  }

  #emit() {
    this.#bus.emit();
  }

  /**
   * Subscribe to settings changes; the cache is already updated when the
   * listener runs, so re-read getSetting() directly. Returns an unsubscribe;
   * `signal` detaches it with the caller's lifecycle. Fan natively realizes
   * the no-op-on-aborted-signal convention (the DOM arm adds nothing for an
   * aborted signal - the manual guard this once spelled).
   */
  subscribe(listener, { signal } = {}) {
    return this.#bus.subscribe(listener, { signal });
  }

  set(key, value) {
    const changed = this.#cache[key] !== value;
    this.#cache[key] = value;
    setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
    if (changed) {
      this.#emit();
    }
  }

  /**
   * Live reload across tabs: pf:configs lives in shared manager storage,
   * so a write from any other tab re-seeds this cache and every event-time
   * getSetting() consumer picks it up on its next read. Our own writes echo
   * back through the same path and land as no-ops.
   */
  #refreshFromStorage() {
    // A cross-tab writer replaced pf:configs behind our back - drop the cached
    // doc so the per-key re-reads below come from the fresh manager value.
    invalidateConfigCache();
    let changed = 0;
    for (const definition of SETTINGS_SCHEMA) {
      const key = definition.key;
      const fresh = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]));
      if (this.#cache[key] !== fresh) {
        this.#cache[key] = fresh;
        changed++;
      }
    }
    if (changed > 0) {
      logger.log("settings", `Live-reloaded ${changed} setting(s) from storage`);
      this.#emit();
    }
  }
}

const settings = new Settings();

export function getSetting(key) {
  return settings.get(key);
}

export function onSettingsChanged(listener, { signal } = {}) {
  return settings.subscribe(listener, { signal });
}

export function setSetting(key, value) {
  settings.set(key, value);
}
