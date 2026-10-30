import { getConfigValue, setConfigFields } from "../shared/store.js";
import { flashElement } from "./chrome/ui.js";
import { debounce, Scope, Fan } from "../shared/runtime.js";
import { clamp, TUNING, fmtPercent, fmtSigned } from "../shared/core.js";
import { GESTURE_EVENTS } from "../kernel/contract.js";

const CONFIG_PREFIX = "filter";

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
  temperature: { label: "Temp", min: -100, max: 100, step: 5, fmt: fmtSigned, default: 0 },
  tint: { label: "Tint", min: -100, max: 100, step: 5, fmt: fmtSigned, default: 0 }
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

/**
 * Color-filter state for one shell, constructed at boot - not with the
 * panel. The stored filter has to be ON the video the moment it plays (a
 * reopened page resuming into Sepia shows Sepia), and the menu's reset
 * command fires against the shell host whether or not a panel was ever
 * opened, so the values+apply machine must live where both are true. The
 * section is UI over this session.
 */
export class FilterSession {
  #shell;
  #video;
  #values = { ...DEFAULTS };
  /** Trailing persist: preview applies instantly, storage lands once the drag
   *  settles (a slider drag otherwise fires a full config write + cross-tab
   *  live-reload echo per step). Flushed on destroy. */
  #schedulePersist = debounce(() => this.#writePersist(), TUNING.filter.persistDebounceMs);
  #scope = new Scope();
  /** State audience on the shared Fan. */
  #audience = new Fan("filter");

  constructor(shell) {
    this.#shell = shell;
    this.#video = shell.video;
    // Menu reset (kernel-dispatched filterReset on the shell host): the
    // gesture surface that works without any panel.
    shell.shellHost?.addEventListener(GESTURE_EVENTS.filterReset, () => this.reset(), {
      signal: this.#scope.signal
    });
    this.#load();
    this.#apply();
  }

  get values() {
    return this.#values;
  }

  /** The preset whose values the section currently shows; "Custom" otherwise. */
  get preset() {
    return matchPreset(this.#values);
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  /** Per-key state write (panel stepper): preview + trailing persist. */
  set(key, value) {
    this.#values[key] = value;
    this.#apply();
    this.#schedulePersist();
    this.#notify();
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) {
      return;
    }
    for (const key of ALL_KEYS) {
      this.#values[key] = preset[key];
    }
    this.#apply();
    this.#schedulePersist();
    this.#shell?.toastFlash("color", `Preset: ${name}`, "filter");
    this.#notify();
  }

  reset() {
    for (const key of ALL_KEYS) {
      this.#values[key] = DEFAULTS[key];
    }
    this.#apply();
    this.#schedulePersist();
    this.#shell?.toastFlash("reload", "Color Reset", "filter");
    this.#notify();
  }

  #load() {
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
  }

  #writePersist() {
    const fields = {};
    for (const key of ALL_KEYS) {
      fields[`${CONFIG_PREFIX}.${key}`] = this.#values[key];
    }
    setConfigFields(fields);
  }

  #apply() {
    if (this.#scope.disposed || !this.#video) {
      return;
    }
    this.#video.style.filter = buildFilterString(this.#values);
  }

  #notify() {
    this.#audience.emit(this.#values);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    // No fan detach on dispose: every notify source (consumer calls, the menu
    // reset gesture listener) dies with this scope, so post-destroy dispatch
    // is unreachable and the audience GCs with the session it points at.
    // Land any trailing persist before the section dies - the last slider
    // value must not be the one that never got written.
    this.#schedulePersist.flush();
    if (this.#video) {
      this.#video.style.filter = "";
    }
  }
}

/**
 * Color section (panel): preset menu, per-key steppers, reset. State lives
 * in the shell's FilterSession (this section builds lazily with the panel);
 * a gesture-driven state change flows back through onState so the open
 * section never shows stale numbers.
 */
export class VideoFilter {
  #session;
  #presetSelect = null;
  #resetBtn = null;
  #steppers = {};
  #scope = new Scope();

  constructor(shell, panel) {
    this.#session = shell.filters;
    this.#buildSection(panel);
    this.#session?.onState(() => this.#syncFromSession(), { signal: this.#scope.signal });
    this.#syncFromSession();
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
      onChange: (name) => this.#session?.applyPreset(name)
    });
    this.#presetSelect.style.marginLeft = "auto";

    this.#resetBtn = panel.addControl(head, {
      type: "button",
      icon: "reload",
      title: "Reset all",
      ariaLabel: "Reset all",
      ghost: true,
      onClick: () => {
        flashElement(this.#resetBtn);
        this.#session?.reset();
      }
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
        onChange: (v) => this.#session?.set(key, v)
      });
      this.#steppers[key] = stepper;
    }
  }

  #syncFromSession() {
    const values = this.#session?.values;
    if (!values) {
      return;
    }
    for (const key of ALL_KEYS) {
      this.#steppers[key]?.setValue(values[key]);
    }
    const preset = this.#session.preset;
    if (this.#presetSelect && this.#presetSelect.value !== preset) {
      this.#presetSelect.value = preset;
    }
  }

  destroy() {
    this.#scope.dispose();
  }
}
