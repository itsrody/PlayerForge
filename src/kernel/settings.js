/**
 * Headless settings engine: schema, cached typed accessors, and change
 * notifications for every user setting. Kernel-owned so every consumer - the
 * kernel's own proxy arm, the shell's panel renderer, per-player features -
 * reads ONE coerced value from ONE store; there is no shell-side secret
 * second copy of a setting.
 *
 * The schema doubles as the panel definition: labels, groups, and option
 * lists live here where the value semantics are decided. The shell panel
 * (chrome/config.js addSettingsSection) renders this schema; it never owns a
 * setting's meaning.
 *
 * Deterministic: only shared/storage.js is touched at module load - no DOM,
 * no frame, no panel - so the engine boots headless in the kernel where the
 * proxy arm consumes it.
 */
import { KEYS, getConfigValue, setConfigValue, invalidateConfigCache, gmAddValueChangeListener } from "../shared/storage.js";
import { logger } from "../shared/logger.js";
import { fmtSeconds } from "../shared/formatters.js";

const SETTINGS_PREFIX = "settings";

export const SETTINGS_SCHEMA = [
  {
    key: "controller.stepSeek",
    type: "options",
    label: "Skip Step",
    options: [5, 10, 15],
    fmt: fmtSeconds,
    default: 5,
    group: "Playback"
  },
  {
    key: "gestures.hotkeys",
    type: "bool",
    label: "Hotkeys",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.hold",
    type: "bool",
    label: "Speed Up Hold",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.scrub",
    type: "bool",
    label: "Scrub Seeking",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.swipe",
    type: "bool",
    label: "Swiping",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.dbltap",
    type: "bool",
    label: "Double-tap Skip",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.pinch",
    type: "bool",
    label: "Pinch to Fill",
    default: true,
    group: "Features"
  },
  {
    key: "gestures.haptics",
    type: "bool",
    label: "Haptic Feedback",
    default: true,
    group: "Features"
  },
  {
    key: "features.wakeLock",
    type: "bool",
    label: "Keep Screen Awake",
    default: true,
    group: "Features"
  },
  {
    key: "features.mp4Fallback",
    type: "bool",
    label: "Recover MP4 Streams",
    default: true,
    group: "Features"
  },
  {
    key: "features.manifestProxy",
    type: "bool",
    label: "Route HLS/DASH Streams",
    default: false,
    group: "Features"
  },
  {
    key: "features.mse",
    type: "bool",
    label: "Stream Takeover (fMP4)",
    default: false,
    group: "Features"
  },
  {
    key: "proxy.mp4MaxBytes",
    label: "Max MP4 Route Size",
    // Stepper field (no "type", so the renderer's number branch drives it).
    // The ceiling for a whole-file element route (bytes): above it, the proxy
    // bails and the element keeps the native wire. Decision-time - read per
    // src route, never snapshotted. Stored as bytes, shown as MiB.
    min: 256 * 1024 * 1024,
    max: 16384 * 1024 * 1024,
    step: 256 * 1024 * 1024,
    default: 4 * 1024 * 1024 * 1024,
    fmt: (bytes) => `${Math.round(bytes / (1024 * 1024))}MiB`,
    group: "Proxy"
  },
  {
    key: "ui.compact",
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

export function setSetting(key, value) {
  cache[key] = value;
  setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
  notifySetting(key);
}

/** Per-key change callbacks, fired after cache refresh on reload or set.
 *  Lets live consumers (e.g. the wake-lock watcher) react to a toggle flip
 *  without polling. */
const settingWatchers = new Map();
export function onSettingChange(key, fn) {
  const list = settingWatchers.get(key) ?? new Set();
  list.add(fn);
  settingWatchers.set(key, list);
  return () => list.delete(fn);
}

function notifySetting(key) {
  settingWatchers.get(key)?.forEach((fn) => fn(cache[key]));
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
      notifySetting(key);
    }
  }
  if (changed > 0) {
    logger.log("settings", `Live-reloaded ${changed} setting(s) from storage`);
  }
}

gmAddValueChangeListener(KEYS.configs, () => refreshSettingsCache());