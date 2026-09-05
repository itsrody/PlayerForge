/**
 * User-settings engine: defaults, schema, cached accessors, and the generic
 * panel renderer for that schema.
 */
import { KEYS, getConfigValue, setConfigValue, invalidateConfigCache, gmAddValueChangeListener } from "../../shared/storage.js";
import { logger } from "../../shared/logger.js";
import { fmtSeconds } from "../../shared/formatters.js";

const SETTINGS_PREFIX = "settings";

const SETTINGS_SCHEMA = [
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

/**
 * Render SETTINGS_SCHEMA into the settings panel: one labeled section per
 * group, toggles for bools, steppers for numbers. Pure function over the
 * panel API - no lifecycle of its own.
 */
export function addSettingsSection(panel) {
  if (!panel?.body) {
    return;
  }
  const sectionRoot = panel.addSection("Settings", "settings");
  if (!sectionRoot) {
    return;
  }

  let currentGroup = null;
  let groupGrid = null;
  for (const definition of SETTINGS_SCHEMA) {
    if (definition.group !== currentGroup) {
      currentGroup = definition.group;
      const groupSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
      panel.addLabel(groupSection, definition.group);
      groupGrid = panel.el("div", { class: "pf-panel-grid" }, groupSection);
    }
    if (definition.type === "bool") {
      const cellAttrs = { class: "pf-panel-cell" };
      const cell = panel.el("div", cellAttrs, groupGrid);
      const toggleLabel = panel.el("label", { class: "pf-settings-toggle" }, cell);
      const checkbox = panel.addControl(toggleLabel, {
        type: "checkbox",
        checked: getSetting(definition.key),
        onChange: (checked) => {
          setSetting(definition.key, checked);
        }
      });
      checkbox.setAttribute("aria-label", definition.label);
      panel.el("span", {}, toggleLabel).textContent = definition.label;
    } else if (definition.type === "options") {
      const cell = panel.el("div", { class: "pf-panel-cell pf-options-cell" }, groupGrid);
      panel.addLabel(cell, definition.label);
      const row = panel.el("div", { class: "pf-options-row" }, cell);
      const current = getSetting(definition.key);
      for (const opt of definition.options) {
        const btn = panel.el("button", {
          type: "button",
          class: opt === current ? "pf-btn pf-options-btn pf-options-active" : "pf-btn pf-options-btn"
        }, row);
        btn.textContent = definition.fmt(opt);
        btn.addEventListener("click", () => {
          setSetting(definition.key, opt);
          for (const b of row.children) {
            b.classList.toggle("pf-options-active", b === btn);
          }
        });
      }
    } else {
      panel.addControl(groupGrid, {
        type: "stepper",
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        value: getSetting(definition.key),
        head: true,
        format: definition.fmt,
        // Typing stays local until blur/Enter - no GM_setValue per keystroke
        // (subtitle steppers keep live output, so they stay immediate).
        deferTextInput: true,
        onChange: (parsed) => setSetting(definition.key, parsed)
      });
    }
  }
  logger.log("settings", "Settings section ready");
}
