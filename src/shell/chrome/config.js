/**
 * User-settings engine: defaults, schema, cached accessors, and the generic
 * panel renderer for that schema.
 */
import { getConfigValue, setConfigValue } from "../../shared/storage.js";
import { logger } from "../../shared/logger.js";

const SETTINGS_PREFIX = "settings";

const DEFAULT_SETTINGS = {
  "controller.holdSpeed": 2,
  "controller.stepSeek": 5,
  "controller.streakMax": 10,
  "controller.scrubSensitivity": 150,
  "gestures.hotkeys": true,
  "gestures.hold": true,
  "gestures.scrub": true,
  "gestures.swipe": true,
  "gestures.dbltap": true,
  "gestures.pinch": true,
  "resume.durationFuzz": 2
};

const SETTINGS_SCHEMA = [
  {
    key: "controller.holdSpeed",
    type: "number",
    label: "Hold speed",
    min: 1.5,
    max: 4,
    step: 0.5,
    fmt: (v) => `${v}x`,
    group: "Playback"
  },
  {
    key: "controller.stepSeek",
    type: "number",
    label: "Arrow skip step",
    min: 1,
    max: 30,
    step: 1,
    fmt: (v) => `${v}s`,
    group: "Playback"
  },
  {
    key: "controller.streakMax",
    type: "number",
    label: "Max skip streak",
    min: 1,
    max: 30,
    step: 1,
    fmt: (v) => `${v}x`,
    group: "Playback"
  },
  {
    key: "controller.scrubSensitivity",
    type: "number",
    label: "Scrub sensitivity",
    min: 50,
    max: 500,
    step: 10,
    fmt: (v) => `${v}`,
    group: "Playback"
  },
  {
    key: "gestures.hotkeys",
    type: "bool",
    label: "Keyboard hotkeys",
    group: "Gestures"
  },
  {
    key: "gestures.hold",
    type: "bool",
    label: "Hold to speed up",
    group: "Gestures"
  },
  {
    key: "gestures.scrub",
    type: "bool",
    label: "Horizontal scrub",
    group: "Gestures"
  },
  {
    key: "gestures.swipe",
    type: "bool",
    label: "Swipe gestures",
    group: "Gestures"
  },
  {
    key: "gestures.dbltap",
    type: "bool",
    label: "Double-tap skip",
    group: "Gestures"
  },
  {
    key: "gestures.pinch",
    type: "bool",
    label: "Pinch to fill",
    group: "Gestures"
  },
  {
    key: "resume.durationFuzz",
    type: "number",
    label: "Resume tolerance",
    min: 0,
    max: 10,
    step: 1,
    fmt: (v) => `${v}s`,
    group: "Resume"
  }
];

const cache = {};
for (const key of Object.keys(DEFAULT_SETTINGS)) {
  cache[key] = getConfigValue(`${SETTINGS_PREFIX}.${key}`, DEFAULT_SETTINGS[key]);
}

export function getSetting(key) {
  return cache[key];
}

export function setSetting(key, value) {
  cache[key] = value;
  setConfigValue(`${SETTINGS_PREFIX}.${key}`, value);
}

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
      const cell = panel.el("div", { class: "pf-panel-cell" }, groupGrid);
      const toggleLabel = panel.el("label", { class: "pf-settings-toggle" }, cell);
      const checkbox = panel.addCheckbox(toggleLabel, {
        checked: getSetting(definition.key),
        onChange: (checked) => setSetting(definition.key, checked)
      });
      checkbox.setAttribute("aria-label", definition.label);
      panel.el("span", {}, toggleLabel).textContent = definition.label;
    } else {
      panel.addStepper(groupGrid, {
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        value: getSetting(definition.key),
        head: true,
        format: definition.fmt,
        onChange: (parsed) => setSetting(definition.key, parsed)
      });
    }
  }
  logger.log("settings", "Settings section ready");
}
