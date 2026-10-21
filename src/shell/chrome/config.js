/**
 * User-settings engine: defaults, schema, and cached accessors. State only -
 * the panel renderer for this schema (addSettingsSection) lives in panel.js
 * beside the panel API it programs against.
 */
import { KEYS, getConfigValue, setConfigValue, invalidateConfigCache, watchStorageKey } from "../../shared/store.js";
import { GESTURES, GESTURE_IDS } from "../../kernel/contract.js";
import { logger } from "../../shared/runtime.js";
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

const cache = {};
for (const definition of SETTINGS_SCHEMA) {
  cache[definition.key] = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${definition.key}`, definition.default));
}

export function getSetting(key) {
  return cache[key];
}

/**
 * Settings reactivity bus: one module-level EventTarget so every consumer
 * (settings section controls, and any future hot-read UI) learns about a
 * change exactly once - own write dispatches here, the cross-tab echo lands
 * as a no-op (changed 0) and never double-fires.
 */
const settingsBus = new EventTarget();

function emitSettingsChanged() {
  settingsBus.dispatchEvent(new Event("settings"));
}

/**
 * Subscribe to settings changes; the cache is already updated when the
 * listener runs, so re-read getSetting() directly. Returns an unsubscribe;
 * `signal` detaches it with the caller's lifecycle.
 */
export function onSettingsChanged(listener, { signal } = {}) {
  // Reading a setting is safe with an aborted signal, but subscribing is not:
  // the platform never fires the teardown listener on an already-aborted
  // signal, which would leak the handler. Treat it as a no-op subscription.
  if (signal?.aborted) {
    return () => {};
  }
  const handler = () => listener();
  settingsBus.addEventListener("settings", handler, { signal });
  return () => settingsBus.removeEventListener("settings", handler);
}

export function setSetting(key, value) {
  const changed = cache[key] !== value;
  cache[key] = value;
  setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
  if (changed) {
    emitSettingsChanged();
  }
}

/**
 * Live reload across tabs: pf:configs lives in shared manager storage,
 * so a write from any other tab re-seeds this cache and every event-time
 * getSetting() consumer picks it up on its next read. Our own writes echo
 * back through the same path and land as no-ops.
 */
function refreshSettingsCache() {
  // A cross-tab writer replaced pf:configs behind our back - drop the cached
  // doc so the per-key re-reads below come from the fresh manager value.
  invalidateConfigCache();
  let changed = 0;
  for (const definition of SETTINGS_SCHEMA) {
    const key = definition.key;
    const fresh = coerceSetting(definition, getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]));
    if (cache[key] !== fresh) {
      cache[key] = fresh;
      changed++;
    }
  }
  if (changed > 0) {
    logger.log("settings", `Live-reloaded ${changed} setting(s) from storage`);
    emitSettingsChanged();
  }
}

// Cross-tab live reload via the storage-owned watch (shared echo contract).
watchStorageKey(KEYS.configs, () => refreshSettingsCache());
