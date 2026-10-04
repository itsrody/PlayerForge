import { getConfigValue, setConfigFields } from "../shared/storage.js";
import { flashElement } from "./chrome/animate.js";
import { debounce } from "../shared/scheduler.js";
import { clamp, fmtPercent } from "../shared/primitives.js";
import { TUNING } from "../shared/tuning.js";
import { Scope } from "../shared/scope.js";

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
  Vintage: { brightness: 102, contrast: 95, saturate: 80, hue: 0, grayscale: 15, sepia: 25, invert: 0, temperature: 12, tint: 5 }
};

const DEFAULTS = PRESETS.Default;
const PRESET_ENTRIES = Object.entries(PRESETS);
const PRESET_OPTIONS = Object.keys(PRESETS).concat(["Custom"]);

/**
 * Coerce a stored filter value to a number, falling back to `def` only when
 * the stored value is not a usable number.
 *
 * The obvious `Number(raw) || def` is wrong here: 0 is a legitimate,
 * user-reachable value for brightness, contrast and saturate (their steppers
 * start at 0, and the B&W preset stores saturate: 0), so the `||` threw away
 * exactly the value the user picked and substituted the default instead.
 * Reject only what is genuinely not a number - null, undefined, empty string,
 * NaN, Infinity.
 */
function coerceNumber(raw, def) {
  if (raw === null || raw === undefined || raw === "") {
    return def;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

// Static UI maps hoisted out of #buildSection: they are pure constants, so
// building three object literals + nine format closures per VideoFilter
// construction (once per shell, i.e. per video) was pure per-shell garbage.
const RANGE_MAP = {
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
const LABEL_MAP = {
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
const FORMAT_MAP = {
  brightness: fmtPercent,
  contrast: fmtPercent,
  saturate: fmtPercent,
  hue: (v) => `${v}°`,
  grayscale: fmtPercent,
  sepia: fmtPercent,
  invert: fmtPercent,
  temperature: (v) => `${v > 0 ? "+" : ""}${v}`,
  tint: (v) => `${v > 0 ? "+" : ""}${v}`
};

// Monomorphic literal comparison. A keyed inner loop (values[key]/preset[key]
// over ALL_KEYS) hands both load sites nine different property names, which is
// the shape Gecko cannot fold into one cache. Measured in Gecko 158
// (platform/browser-bench/jit-shape.bench.mjs), per call over two passes: 1.69us
// against 0.49us on the deepest scan the function can be driven into, and
// 0.76us against 0.47us on the mid-drag early exit - 3.4x and 1.6x.
//
// The early exit is priced separately because it is the common case and it is
// much cheaper than the deep scan: a mid-drag brightness still mismatches at
// ALL_KEYS[0] for nearly every preset, so the keyed sites are rarely reached
// more than once. Anyone quoting the 3.4x as the cost of this path is quoting
// the preset-select path.
//
// The sibling chromium branch reported 8.6x for this same rewrite, but that was
// Node 26.9 / V8 14.6. Gecko's number is smaller, and Gecko's number is the
// one this branch can quote.
//
// Field order mirrors ALL_KEYS. If a filter key is added, this and ALL_KEYS
// have to move together - the filter-key tests cover the behaviour, and the
// benchmark row is what says whether the rewrite is still worth having.
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
  const tempHue = (Number(values.temperature) || 0) * 0.3;
  const tempSat = Math.abs(Number(values.temperature) || 0) * 0.15;
  const tintHue = (Number(values.tint) || 0) * 0.2;
  const totalHue = (Number(values.hue) || 0) + tempHue + tintHue;
  const totalSat = (Number(values.saturate) || 0) + tempSat;

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
  /**
   * The embed's own inline `filter`, captured before PF's first write.
   * `filter` is an inherited CSS property, so a host page may legitimately be
   * using it; clearing to "" on destroy would silently drop the page's value.
   * Null until first apply, which keeps the capture lazy and one-shot.
   */
  #priorFilter = null;
  /** Disposal flag: guards #apply after teardown, home of future disposers. */
  #scope = new Scope();
  /** Trailing persist: preview applies instantly, storage lands once the drag
   *  settles (a slider drag otherwise fires a full config write + cross-tab
   *  live-reload echo per step). Flushed on destroy. Issued at `background`:
   *  a settings write is not worth a place in the queue ahead of the HUD
   *  commit or an input response (§5, "history ... never block input"). */
  #schedulePersist = debounce(() => this.#writePersist(), TUNING.filter.persistDebounceMs, { priority: "background" });

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
      const [min, max, step] = RANGE_MAP[key];
      const stepper = panel.addControl(grid, {
        type: "stepper",
        label: LABEL_MAP[key],
        min,
        max,
        step,
        value: DEFAULTS[key],
        head: true,
        format: FORMAT_MAP[key],
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
      this.#values[key] = typeof def === "number" ? coerceNumber(raw, def) : (raw ?? def);
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
    if (this.#priorFilter === null) {
      this.#priorFilter = this.#video.style.filter;
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
      this.#video.style.filter = this.#priorFilter ?? "";
      this.#priorFilter = null;
    }
  }
}
