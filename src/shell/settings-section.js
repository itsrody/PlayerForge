import { getSetting, setSetting, SETTINGS_SCHEMA } from "../shared/config.js";
import { logger } from "../shared/logger.js";

/**
 * Shell-owned HUD piece: declares the generic settings schema (Playback /
 * Gestures / Resume) as panel-builder parameters. Pure UI over config.js —
 * no lifecycle of its own, so it is a function rather than a feature class.
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
