import { Plugin } from "./base.js";
import { getSetting, setSetting, SETTINGS_SCHEMA } from "../shared/config.js";
import { createStepper } from "../shared/stepper.js";
import { logger } from "../shared/logger.js";

/** Renders the generic settings schema (Playback / Gestures / Resume) into a panel section. */
export class SettingsPlugin extends Plugin {
  #built = false;

  constructor() {
    super("settings");
  }

  onAttach(shell) {
    if (!this.#built) {
      this.#built = true;
      this.#buildPanelUi(shell);
    }
    logger.log("settings", `Attached (${shell.sdkName})`);
  }

  onDestroy() {
    this.#built = false;
    super.onDestroy();
  }

  #buildPanelUi(shell) {
    const panelBody = shell.panel?.body;
    if (!panelBody) {
      return;
    }
    const sectionRoot = shell.panel.addSection("Settings", "settings");
    if (!sectionRoot) {
      return;
    }
    const el = (tag, attrs = {}, parent = sectionRoot) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "style" && typeof value === "object") {
          Object.assign(node.style, value);
        } else {
          node.setAttribute(key, value);
        }
      }
      parent.appendChild(node);
      this.addCleanup(() => node.remove());
      return node;
    };

    let currentGroup = null;
    let groupSection = null;
    let groupGrid = null;
    for (const definition of SETTINGS_SCHEMA) {
      if (definition.group !== currentGroup) {
        currentGroup = definition.group;
        groupSection = el("div", { class: "pf-panel-section" });
        el("div", { class: "pf-panel-label" }, groupSection).textContent = definition.group;
        groupGrid = el("div", { class: "pf-panel-grid" }, groupSection);
      }
      if (definition.type === "bool") {
        const cell = el("div", { class: "pf-panel-cell" }, groupGrid);
        const toggleLabel = el("label", { class: "pf-settings-toggle" }, cell);
        const checkbox = el("input", { type: "checkbox" }, toggleLabel);
        checkbox.checked = getSetting(definition.key);
        checkbox.setAttribute("aria-label", definition.label);
        el("span", {}, toggleLabel).textContent = definition.label;
        checkbox.addEventListener("change", () => setSetting(definition.key, checkbox.checked));
      } else {
        const cell = el("div", { class: "pf-panel-cell" }, groupGrid);
        const head = el("div", { class: "pf-panel-cell-head" }, cell);
        el("span", { class: "pf-panel-label" }, head).textContent = definition.label;
        const valueLabel = el("span", { class: "pf-panel-value" }, head);
        const stepper = createStepper({
          min: definition.min,
          max: definition.max,
          step: definition.step,
          value: getSetting(definition.key),
          label: definition.label,
          onChange: (parsed) => {
            valueLabel.textContent = definition.fmt(parsed);
            setSetting(definition.key, parsed);
          }
        });
        cell.appendChild(stepper.root);
        this.addCleanup(() => stepper.root.remove());
        valueLabel.textContent = definition.fmt(getSetting(definition.key));
      }
    }
  }
}
