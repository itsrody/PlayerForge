/**
 * User-settings engine: defaults, schema, cached accessors, and the generic
 * panel renderer for that schema.
 */
import { KEYS, getConfigValue, setConfigValue, invalidateConfigCache, gmAddValueChangeListener } from "../../shared/storage.js";
import { logger } from "../../shared/logger.js";
import { fmtSeconds } from "../../shared/formatters.js";

const SETTINGS_PREFIX = "settings";

/** Unique-id seed for option-group labels (one settings section per shell). */
let optionsGroupCounter = 0;
const ARROW_DIRECTIONS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

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
    key: "fullscreen.edgeToEdge",
    type: "bool",
    label: "Edge-to-edge Fullscreen",
    default: true,
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

// Own writes echo back too (remote === false): our cache was already updated
// by setSetting before the write, so skip the invalidation + full-doc re-parse
// it would trigger - the resume store applies the same guard (resume.js).
// Implementations that omit the 4th arg behave exactly as before.
gmAddValueChangeListener(KEYS.configs, (_name, _old, _value, remote) => {
  if (remote === false) {
    return;
  }
  refreshSettingsCache();
});

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
      const groupLabel = panel.addLabel(cell, definition.label);
      const row = panel.el("div", { class: "pf-options-row" }, cell);
      // Radio semantics: one roving stop per group, aria-checked mirrors the
      // active button, arrows move + select like a native radio group.
      groupLabel.id = `pf-options-group-${optionsGroupCounter++}`;
      row.setAttribute("role", "radiogroup");
      row.setAttribute("aria-labelledby", groupLabel.id);
      const current = getSetting(definition.key);
      const buttons = [];
      const syncOptions = (active) => {
        let checked = false;
        for (const [opt, btn] of buttons) {
          const on = opt === active;
          checked = checked || on;
          btn.classList.toggle("pf-options-active", on);
          btn.setAttribute("aria-checked", on ? "true" : "false");
          btn.tabIndex = on ? 0 : -1;
        }
        // A stale value outside the enum must not collapse the tab stops.
        if (!checked && buttons.length) {
          buttons[0][1].tabIndex = 0;
        }
      };
      for (const opt of definition.options) {
        const btn = panel.el("button", {
          type: "button",
          role: "radio",
          class: "pf-btn pf-options-btn"
        }, row);
        btn.textContent = definition.fmt(opt);
        btn.addEventListener("click", () => {
          setSetting(definition.key, opt);
          syncOptions(opt);
        });
        buttons.push([opt, btn]);
      }
      row.addEventListener("keydown", (event) => {
        const direction = ARROW_DIRECTIONS[event.key];
        if (!direction) {
          return;
        }
        const index = buttons.findIndex(([, btn]) => btn === event.target);
        if (index === -1) {
          return;
        }
        event.preventDefault();
        const next = (index + direction + buttons.length) % buttons.length;
        const [opt, btn] = buttons[next];
        setSetting(definition.key, opt);
        syncOptions(opt);
        btn.focus();
      });
      syncOptions(current);
      controls.set(definition.key, { type: "options", sync: syncOptions });
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
        rec.sync(fresh);
      } else {
        rec.el.setValue(fresh);
      }
    }
  };
  off = onSettingsChanged(syncFromCache, { signal });
  logger.log("settings", "Settings section ready");
}
