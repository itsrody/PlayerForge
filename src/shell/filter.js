import { getConfigValue, setConfigFields } from "../shared/storage.js";
import { flashElement } from "../shared/flash.js";
import { TUNING } from "./chrome/config.js";

const CONFIG_PREFIX = "filter";

const FILTER_KEYS = ["brightness", "contrast", "saturate", "hue", "grayscale", "sepia", "invert"];
const EXTRA_KEYS = ["temperature", "tint"];
const ALL_KEYS = [...FILTER_KEYS, ...EXTRA_KEYS];

const PRESETS = {
  Default: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 0, tint: 0 },
  Cinematic: { brightness: 105, contrast: 115, saturate: 85, hue: 0, grayscale: 0, sepia: 15, invert: 0, temperature: 10, tint: 2 },
  Vibrant: { brightness: 105, contrast: 110, saturate: 140, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 5, tint: 0 },
  "B&W": { brightness: 100, contrast: 110, saturate: 0, hue: 0, grayscale: 100, sepia: 0, invert: 0, temperature: 0, tint: 0 },
  Sepia: { brightness: 100, contrast: 100, saturate: 60, hue: 0, grayscale: 0, sepia: 80, invert: 0, temperature: 15, tint: 0 },
  Night: { brightness: 90, contrast: 120, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: -20, tint: -5 },
  Inverted: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 100, temperature: 0, tint: 0 },
  "Teal & Orange": { brightness: 102, contrast: 108, saturate: 105, hue: 0, grayscale: 0, sepia: 5, invert: 0, temperature: 15, tint: -3 },
  "Film Kodak": { brightness: 103, contrast: 105, saturate: 95, hue: 0, grayscale: 0, sepia: 10, invert: 0, temperature: 8, tint: 4 },
  "Bleach Bypass": { brightness: 98, contrast: 130, saturate: 55, hue: 0, grayscale: 25, sepia: 5, invert: 0, temperature: -5, tint: 0 },
  "Cross Process": { brightness: 105, contrast: 110, saturate: 120, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 20, tint: -10 },
  Vintage: { brightness: 102, contrast: 95, saturate: 80, hue: 0, grayscale: 15, sepia: 25, invert: 0, temperature: 12, tint: 5 },
  "Cold Tone": { brightness: 100, contrast: 105, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: -25, tint: -3 },
  "Warm Tone": { brightness: 102, contrast: 102, saturate: 105, hue: 0, grayscale: 0, sepia: 5, invert: 0, temperature: 20, tint: 3 }
};

const DEFAULTS = PRESETS.Default;

function matchPreset(values) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (ALL_KEYS.every((k) => values[k] === preset[k])) {
      return name;
    }
  }
  return "Custom";
}

function buildFilterString(values) {
  const parts = [];
  const tempHue = (values.temperature || 0) * 0.3;
  const tempSat = Math.abs(values.temperature || 0) * 0.15;
  const tintHue = (values.tint || 0) * 0.2;
  const totalHue = (values.hue || 0) + tempHue + tintHue;
  const totalSat = (values.saturate || DEFAULTS.saturate) + tempSat;

  if (values.brightness !== DEFAULTS.brightness) {
    parts.push(`brightness(${values.brightness}%)`);
  }
  if (values.contrast !== DEFAULTS.contrast) {
    parts.push(`contrast(${values.contrast}%)`);
  }
  if (totalSat !== DEFAULTS.saturate) {
    parts.push(`saturate(${Math.min(200, Math.max(0, totalSat))}%)`);
  }
  if (totalHue !== 0) {
    parts.push(`hue-rotate(${totalHue}deg)`);
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
    this.#presetSelect = panel.addControl(head, {
      type: "select",
      options: presetOptions,
      value: "Default",
      onChange: (name) => this.#onPresetChange(name)
    });
    this.#presetSelect.style.marginLeft = "auto";

    this.#resetBtn = panel.addControl(head, {
      type: "button",
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
      invert: (v) => `${v}%`,
      temperature: (v) => `${v > 0 ? "+" : ""}${v}`,
      tint: (v) => `${v > 0 ? "+" : ""}${v}`
    };
    const rangeMap = {
      brightness: [0, 200, 5],
      contrast: [0, 200, 5],
      saturate: [0, 200, 5],
      hue: [0, 360, 5],
      grayscale: [0, 100, 5],
      sepia: [0, 100, 5],
      invert: [0, 100, 5],
      temperature: [-100, 100, 5],
      tint: [-100, 100, 5]
    };
    const labelMap = {
      brightness: "Brightness",
      contrast: "Contrast",
      saturate: "Saturate",
      hue: "Hue",
      grayscale: "Grayscale",
      sepia: "Sepia",
      invert: "Invert",
      temperature: "Temp",
      tint: "Tint"
    };

    for (const key of ALL_KEYS) {
      const [min, max, step] = rangeMap[key];
      const stepper = panel.addControl(grid, {
        type: "stepper",
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
    for (const key of ALL_KEYS) {
      const def = DEFAULTS[key];
      const raw = getConfigValue(`${CONFIG_PREFIX}.${key}`, def);
      this.#values[key] = typeof def === "number" ? (Number(raw) || def) : (raw ?? def);
    }
    for (const key of ALL_KEYS) {
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
    for (const key of ALL_KEYS) {
      this.#values[key] = preset[key];
      this.#steppers[key]?.setValue(preset[key]);
    }
    this.#apply();
    this.#persist();
    this.#shell?.toast({ icon: "color", text: `Preset: ${name}`, duration: TUNING.toast.flashMs, group: "filter" });
  }

  #persist() {
    const fields = {};
    for (const key of ALL_KEYS) {
      fields[`${CONFIG_PREFIX}.${key}`] = this.#values[key];
    }
    setConfigFields(fields);
  }

  reset() {
    for (const key of ALL_KEYS) {
      this.#values[key] = DEFAULTS[key];
      this.#steppers[key]?.setValue(DEFAULTS[key]);
    }
    this.#apply();
    this.#persist();
    this.#syncPresetMenu();
    if (this.#resetBtn) {
      flashElement(this.#resetBtn);
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
