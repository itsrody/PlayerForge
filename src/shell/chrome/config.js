/**
 * User-settings engine: defaults, schema, cached accessors, and the generic
 * panel renderer for that schema.
 */
import { configStore, getConfigValue, setConfigValue } from "../../shared/storage.js";
import { logger } from "../../shared/diagnostics.js";
import { fmtSeconds } from "../../shared/primitives.js";

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
    key: "ui.compact",
    type: "bool",
    label: "Compact Panel",
    // Deliberately NO default. This setting is a tri-state: true/false are
    // explicit choices, and absent means "let the panel auto-detect a narrow
    // touch viewport". With a default of false the tri-state collapsed - the
    // seeded value was always an explicit `false`, Panel's #isCompactMode
    // returned on it, and the matchMedia auto-detect below never ran on a
    // fresh install. undefined is the only default that means "no opinion".
    default: undefined,
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
  const handler = () => listener();
  settingsBus.addEventListener("settings", handler, { signal });
  return () => settingsBus.removeEventListener("settings", handler);
}

export function setSetting(key, value) {
  // No local bookkeeping: the store publishes the write synchronously, so
  // refreshSettingsCache has already re-coerced and emitted by the time this
  // returns. Going through the write also means a caller cannot smuggle an
  // uncoerced value into the cache - getSetting() stays trustworthy.
  setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
}

/**
 * Live reload across tabs: pf:configs lives in shared manager storage, so a
 * write from any other tab re-seeds this cache and every event-time
 * getSetting() consumer picks it up on its next read. Our own writes echo
 * back through the same path and land as no-ops.
 *
 * The store hands us the changed leaf paths, so this re-coerces only the
 * settings that actually moved instead of re-reading the whole document -
 * a write to one gesture toggles one, not all eight.
 */
function refreshSettingsCache(paths) {
  let changed = 0;
  for (const definition of SETTINGS_SCHEMA) {
    const key = definition.key;
    if (paths && !paths.has(`${SETTINGS_PREFIX}.${key}`)) {
      continue;
    }
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

configStore.onChange(({ paths }) => refreshSettingsCache(paths));

/**
 * Render SETTINGS_SCHEMA into the settings panel: one labeled section per
 * group, toggles for bools, steppers for numbers. Pure function over the
 * panel API - aside from the reactivity subscription below, no lifecycle of
 * its own (`signal` ties that subscription to the caller, e.g. the shell).
 */
export function addSettingsSection(panel, signal) {
  if (!panel?.body) {
    return;
  }
  const sectionRoot = panel.addSection("Settings", "settings");
  if (!sectionRoot) {
    return;
  }

  /** key -> widget handle(s), so a change event can re-sync without queries. */
  const controls = new Map();

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
      controls.set(definition.key, { type: "bool", el: checkbox });
    } else if (definition.type === "options") {
      const cell = panel.el("div", { class: "pf-panel-cell pf-options-cell" }, groupGrid);
      panel.addLabel(cell, definition.label);
      const row = panel.el("div", { class: "pf-options-row" }, cell);
      const current = getSetting(definition.key);
      const buttons = [];
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
        buttons.push([opt, btn]);
      }
      controls.set(definition.key, { type: "options", buttons });
    } else {
      const stepper = panel.addControl(groupGrid, {
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
      if (stepper) {
        controls.set(definition.key, { type: "stepper", el: stepper });
      }
    }
  }

  // Re-sync widgets when a setting changes elsewhere (another tab's write, or
  // an in-page setSetting that did not originate from these controls). Values
  // are assigned - never .click()/.dispatchEvent - so the sync cannot echo
  // back into setSetting. A destroyed panel (body nulled) unsubscribes.
  let off = () => {};
  const syncFromCache = () => {
    if (!panel?.body) {
      off();
      return;
    }
    for (const [key, rec] of controls) {
      const fresh = getSetting(key);
      if (rec.type === "bool") {
        rec.el.checked = fresh;
      } else if (rec.type === "options") {
        for (const [opt, btn] of rec.buttons) {
          btn.classList.toggle("pf-options-active", opt === fresh);
        }
      } else {
        rec.el.setValue(fresh);
      }
    }
  };
  off = onSettingsChanged(syncFromCache, { signal });
  logger.log("settings", "Settings section ready");
}
