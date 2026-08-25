import { getConfigValue, setConfigValue } from "../shared/storage.js";
import { TUNING } from "./chrome/config.js";

const CONFIG_PREFIX = "filter";

const FILTER_KEYS = ["brightness", "contrast", "saturate", "hue", "grayscale", "sepia", "invert"];

const PRESETS = {
  Default: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0 },
  Cinematic: { brightness: 105, contrast: 115, saturate: 85, hue: 0, grayscale: 0, sepia: 15, invert: 0 },
  Vibrant: { brightness: 105, contrast: 110, saturate: 140, hue: 0, grayscale: 0, sepia: 0, invert: 0 },
  "B&W": { brightness: 100, contrast: 110, saturate: 0, hue: 0, grayscale: 100, sepia: 0, invert: 0 },
  Sepia: { brightness: 100, contrast: 100, saturate: 60, hue: 0, grayscale: 0, sepia: 80, invert: 0 },
  Night: { brightness: 90, contrast: 120, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0 },
  Inverted: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 100 }
};

const DEFAULTS = PRESETS.Default;

function matchPreset(values) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (FILTER_KEYS.every((k) => values[k] === preset[k])) {
      return name;
    }
  }
  return "Custom";
}

function buildFilterString(values) {
  const parts = [];
  if (values.brightness !== DEFAULTS.brightness) {
    parts.push(`brightness(${values.brightness}%)`);
  }
  if (values.contrast !== DEFAULTS.contrast) {
    parts.push(`contrast(${values.contrast}%)`);
  }
  if (values.saturate !== DEFAULTS.saturate) {
    parts.push(`saturate(${values.saturate}%)`);
  }
  if (values.hue !== DEFAULTS.hue) {
    parts.push(`hue-rotate(${values.hue}deg)`);
  }
  if (values.grayscale !== DEFAULTS.grayscale) {
    parts.push(`grayscale(${values.grayscale}%)`);
  }
  if (values.sepia !== DEFAULTS.sepia) {
    parts.push(`sepia(${values.sepia}%)`);
  }
  if (values.invert !== DEFAULTS.invert) {
    parts.push(`invert(${values.invert}%)`);
  }
  return parts.join(" ") || "none";
}

export class VideoFilter {
  #video;
  #shell;
  #values = { ...DEFAULTS };
  #presetSelect = null;
  #resetBtn = null;
  #steppers = {};
  #destroyed = false;

  constructor(shell, panel) {
    this.#video = shell.video;
    this.#shell = shell;
    this.#buildSection(panel);
    this.#loadFromConfig();
    this.#apply();
  }

  #buildSection(panel) {
    const sectionRoot = panel.addSection("Color", "color");
    if (!sectionRoot) {
      return;
    }

    const head = panel.el("div", { class: "pf-panel-section-head" }, sectionRoot);

    const presetOptions = Object.keys(PRESETS).concat(["Custom"]);
    this.#presetSelect = panel.addSelect(head, {
      options: presetOptions,
      value: "Default",
      onChange: (name) => this.#onPresetChange(name)
    });
    this.#presetSelect.style.marginLeft = "auto";

    this.#resetBtn = panel.addButton(head, {
      icon: "reload",
      title: "Reset all",
      ariaLabel: "Reset all",
      ghost: true,
      onClick: () => this.reset()
    });

    const grid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, sectionRoot);

    const formatMap = {
      brightness: (v) => `${v}%`,
      contrast: (v) => `${v}%`,
      saturate: (v) => `${v}%`,
      hue: (v) => `${v}°`,
      grayscale: (v) => `${v}%`,
      sepia: (v) => `${v}%`,
      invert: (v) => `${v}%`
    };
    const rangeMap = {
      brightness: [0, 200, 5],
      contrast: [0, 200, 5],
      saturate: [0, 200, 5],
      hue: [0, 360, 5],
      grayscale: [0, 100, 5],
      sepia: [0, 100, 5],
      invert: [0, 100, 5]
    };
    const labelMap = {
      brightness: "Brightness",
      contrast: "Contrast",
      saturate: "Saturate",
      hue: "Hue",
      grayscale: "Grayscale",
      sepia: "Sepia",
      invert: "Invert"
    };

    for (const key of FILTER_KEYS) {
      const [min, max, step] = rangeMap[key];
      const stepper = panel.addStepper(grid, {
        label: labelMap[key],
        min,
        max,
        step,
        value: DEFAULTS[key],
        head: true,
        format: formatMap[key],
        deferTextInput: true,
        onChange: (v) => this.#onStepperChange(key, v)
      });
      this.#steppers[key] = stepper;
    }
  }

  #loadFromConfig() {
    for (const key of FILTER_KEYS) {
      this.#values[key] = Number(getConfigValue(`${CONFIG_PREFIX}.${key}`, DEFAULTS[key])) || DEFAULTS[key];
    }
    for (const key of FILTER_KEYS) {
      this.#steppers[key]?.setValue(this.#values[key]);
    }
    this.#syncPresetMenu();
  }

  #apply() {
    if (this.#destroyed || !this.#video) {
      return;
    }
    this.#video.style.filter = buildFilterString(this.#values);
  }

  #syncPresetMenu() {
    if (this.#presetSelect) {
      this.#presetSelect.value = matchPreset(this.#values);
    }
  }

  #onStepperChange(key, value) {
    this.#values[key] = value;
    this.#apply();
    this.#syncPresetMenu();
    this.#persist();
  }

  #onPresetChange(name) {
    const preset = PRESETS[name];
    if (!preset) {
      return;
    }
    for (const key of FILTER_KEYS) {
      this.#values[key] = preset[key];
      this.#steppers[key]?.setValue(preset[key]);
    }
    this.#apply();
    this.#persist();
  }

  #persist() {
    for (const key of FILTER_KEYS) {
      setConfigValue(`${CONFIG_PREFIX}.${key}`, this.#values[key]);
    }
  }

  reset() {
    for (const key of FILTER_KEYS) {
      this.#values[key] = DEFAULTS[key];
      this.#steppers[key]?.setValue(DEFAULTS[key]);
    }
    this.#apply();
    this.#persist();
    this.#syncPresetMenu();
    if (this.#resetBtn) {
      this.#resetBtn.classList.remove("pf-flash");
      void this.#resetBtn.offsetWidth;
      this.#resetBtn.classList.add("pf-flash");
    }
    this.#shell?.toast({ icon: "reload", text: "Color Reset", duration: TUNING.toast.flashMs, group: "filter" });
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#video) {
      this.#video.style.filter = "";
    }
  }
}
