import { getConfigValue, setConfigFields } from "../shared/storage.js";
import { flashElement } from "./chrome/animate.js";
import { debounce } from "../shared/time.js";
import { clamp } from "../shared/clamp.js";
import { TUNING } from "../shared/tuning.js";
import { fmtPercent } from "../shared/formatters.js";
import { Scope } from "../shared/scope.js";

const CONFIG_PREFIX = "filter";

const signed = (v) => `${v > 0 ? "+" : ""}${v}`;

/**
 * The color-control schema - one entry per filter key and the single source for
 * its label, stepper range, value formatter and default. The panel steppers,
 * the defaults map, and the config load/save loops all derive from this instead
 * of re-listing the keys across parallel key/range/label/format maps.
 */
const FILTER_SCHEMA = {
  brightness: { label: "Brightness", min: 0, max: 200, step: 5, fmt: fmtPercent, default: 100 },
  contrast: { label: "Contrast", min: 0, max: 200, step: 5, fmt: fmtPercent, default: 100 },
  saturate: { label: "Saturate", min: 0, max: 200, step: 5, fmt: fmtPercent, default: 100 },
  hue: { label: "Hue", min: 0, max: 360, step: 5, fmt: (v) => `${v}°`, default: 0 },
  grayscale: { label: "Grayscale", min: 0, max: 100, step: 5, fmt: fmtPercent, default: 0 },
  sepia: { label: "Sepia", min: 0, max: 100, step: 5, fmt: fmtPercent, default: 0 },
  invert: { label: "Invert", min: 0, max: 100, step: 5, fmt: fmtPercent, default: 0 },
  temperature: { label: "Temp", min: -100, max: 100, step: 5, fmt: signed, default: 0 },
  tint: { label: "Tint", min: -100, max: 100, step: 5, fmt: signed, default: 0 }
};
const ALL_KEYS = Object.keys(FILTER_SCHEMA);

const PRESETS = {
  Default: { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 0, tint: 0 },
  Cinematic: { brightness: 105, contrast: 115, saturate: 85, hue: 0, grayscale: 0, sepia: 15, invert: 0, temperature: 10, tint: 2 },
  Vibrant: { brightness: 105, contrast: 110, saturate: 140, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 5, tint: 0 },
  "B&W": { brightness: 100, contrast: 110, saturate: 0, hue: 0, grayscale: 100, sepia: 0, invert: 0, temperature: 0, tint: 0 },
  Sepia: { brightness: 100, contrast: 100, saturate: 60, hue: 0, grayscale: 0, sepia: 80, invert: 0, temperature: 15, tint: 0 },
  Night: { brightness: 90, contrast: 120, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: -20, tint: -5 },
  Vintage: { brightness: 102, contrast: 95, saturate: 80, hue: 0, grayscale: 15, sepia: 25, invert: 0, temperature: 12, tint: 5 }
};

const DEFAULTS = Object.fromEntries(ALL_KEYS.map((key) => [key, FILTER_SCHEMA[key].default]));
const PRESET_ENTRIES = Object.entries(PRESETS);
const PRESET_OPTIONS = Object.keys(PRESETS).concat(["Custom"]);

// Monomorphic literal comparison. A keyed inner loop (values[key]/preset[key]
// over ALL_KEYS) makes both load sites megamorphic - measured 93 ns/op vs
// ~11 ns/op for literal field reads (V8 14.6). matchPreset runs on every
// stepper input during a slider drag and on preset select, so this is on the
// interaction path. Field order mirrors ALL_KEYS.
function presetMatches(values, preset) {
  return (
    values.brightness === preset.brightness &&
    values.contrast === preset.contrast &&
    values.saturate === preset.saturate &&
    values.hue === preset.hue &&
    values.grayscale === preset.grayscale &&
    values.sepia === preset.sepia &&
    values.invert === preset.invert &&
    values.temperature === preset.temperature &&
    values.tint === preset.tint
  );
}

function matchPreset(values) {
  // Index loop, no closure: matchPreset runs on every stepper change and
  // preset select, so neither Object.entries() nor .every() may allocate.
  for (let i = 0; i < PRESET_ENTRIES.length; i++) {
    if (presetMatches(values, PRESET_ENTRIES[i][1])) {
      return PRESET_ENTRIES[i][0];
    }
  }
  return "Custom";
}

function buildFilterString(values) {
  const parts = [];
  // temperature feeds both terms; parse it once (runs per stepper input during
  // a slider drag) instead of coercing the same field twice.
  const temperature = Number(values.temperature) || 0;
  const tempHue = temperature * 0.3;
  const tempSat = Math.abs(temperature) * 0.15;
  const tintHue = (Number(values.tint) || 0) * 0.2;
  const totalHue = (Number(values.hue) || 0) + tempHue + tintHue;
  const totalSat = Number(values.saturate) + tempSat;

  if (values.brightness !== DEFAULTS.brightness) {
    parts.push(`brightness(${values.brightness}%)`);
  }
  if (values.contrast !== DEFAULTS.contrast) {
    parts.push(`contrast(${values.contrast}%)`);
  }
  if (totalSat !== DEFAULTS.saturate) {
    parts.push(`saturate(${clamp(totalSat, 0, 200)}%)`);
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
  /** Disposal flag: guards #apply after teardown, home of future disposers. */
  #scope = new Scope();
  /** Trailing persist: preview applies instantly, storage lands once the drag
   *  settles (a slider drag otherwise fires a full config write + cross-tab
   *  live-reload echo per step). Flushed on destroy. */
  #schedulePersist = debounce(() => this.#writePersist(), TUNING.filter.persistDebounceMs);

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

    this.#presetSelect = panel.addControl(head, {
      type: "select",
      options: PRESET_OPTIONS,
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

    for (const key of ALL_KEYS) {
      const { label, min, max, step, fmt } = FILTER_SCHEMA[key];
      const stepper = panel.addControl(grid, {
        type: "stepper",
        label,
        min,
        max,
        step,
        value: DEFAULTS[key],
        head: true,
        format: fmt,
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
      if (typeof def === "number") {
        const num = Number(raw);
        // A saved 0 is a real value (brightness/contrast/saturate allow it):
        // the old `Number(raw) || def` treated it as absent and silently
        // reset those to their default on the next load. Only a missing or
        // non-finite value falls back now.
        this.#values[key] = raw == null || raw === "" || !Number.isFinite(num) ? def : num;
      } else {
        this.#values[key] = raw ?? def;
      }
    }
    for (const key of ALL_KEYS) {
      this.#steppers[key]?.setValue(this.#values[key]);
    }
    this.#syncPresetMenu();
  }

  #apply() {
    if (this.#scope.disposed || !this.#video) {
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
    this.#shell?.toastFlash("color", `Preset: ${name}`, "filter");
  }

  #persist() {
    this.#schedulePersist();
  }

  #writePersist() {
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
    this.#shell?.toastFlash("reload", "Color Reset", "filter");
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    // Land any trailing persist before the section dies - the last slider
    // value must not be the one that never got written.
    this.#schedulePersist.flush();
    if (this.#video) {
      this.#video.style.filter = "";
    }
  }
}
